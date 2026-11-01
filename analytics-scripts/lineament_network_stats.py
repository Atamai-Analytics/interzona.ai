"""
Structural lineament network statistics around a mineral occurrence, using fractopo
(https://github.com/nialov/fractopo, published in JOSS — a peer-reviewed tool purpose-built for
fracture/lineament trace network analysis).

Pulls all lineaments (faults/folds) within a radius of an occurrence, reprojects to the correct
local UTM zone (lineament geometry is stored as WGS84 lat/lon degrees, which is NOT suitable for
real length/azimuth measurement), and computes trace-count/length statistics, a length-distribution
power-law fit, and orientation-set frequency counts — the standard descriptive toolkit for asking
"what does the local fault/fracture fabric around this deposit look like."

Deliberately does NOT attempt fractopo's branch/node topological analysis (intersections,
connectivity) — this dataset is independently-digitized regional fault traces (SEGEMAR), not a
purpose-mapped, topologically-clean fracture network, so forcing that heavier analysis risks
nonsensical results on messy real-world geometry. Trace-level statistics (this script) are robust
to that; topological analysis would need cleaner input data to be trustworthy.

Usage:
    python lineament_network_stats.py <occurrence_id> [--radius-km 50]
"""
import os
import sys
import json
import argparse
import warnings

warnings.filterwarnings("ignore")

import numpy as np
import pandas as pd
import geopandas as gpd
import psycopg2
from shapely import wkt
from fractopo import Network

REQUIRED_KEYS = ["PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD"]


def load_env():
    if all(k in os.environ for k in REQUIRED_KEYS):
        return {k: os.environ[k] for k in REQUIRED_KEYS}
    env_path = os.path.join(os.path.dirname(__file__), "..", ".env.local")
    env = {}
    with open(env_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    return env


def utm_epsg_for_lonlat(lon, lat):
    zone = int((lon + 180) / 6) + 1
    return 32700 + zone if lat < 0 else 32600 + zone  # southern vs northern hemisphere


def fetch_lineaments_near_occurrence(occurrence_id, radius_km, env):
    conn = psycopg2.connect(
        host=env["PGHOST"], port=env["PGPORT"], dbname=env["PGDATABASE"],
        user=env["PGUSER"], password=env["PGPASSWORD"],
    )
    cur = conn.cursor()
    cur.execute("SELECT ST_X(geom), ST_Y(geom), name FROM core.occurrences WHERE occurrence_id = %s", (occurrence_id,))
    row = cur.fetchone()
    if row is None:
        raise ValueError(f"Occurrence {occurrence_id} not found.")
    lon, lat, occurrence_name = row

    cur.execute(
        """
        SELECT l.lineament_id, ST_AsText(l.geom), lt.type_name
        FROM geochem.lineaments l
        LEFT JOIN geochem.lineament_types lt ON lt.lineament_type_id = l.lineament_type_id
        JOIN core.occurrences o ON o.occurrence_id = %s
        WHERE ST_DWithin(o.geog, l.geog, %s)
        """,
        (occurrence_id, radius_km * 1000),
    )
    rows = cur.fetchall()
    conn.close()
    df = pd.DataFrame(rows, columns=["lineament_id", "wkt", "type_name"])
    return df, lon, lat, occurrence_name


def build_network(occurrence_id, radius_km, env):
    df, lon, lat, occurrence_name = fetch_lineaments_near_occurrence(occurrence_id, radius_km, env)
    if df.empty:
        raise ValueError(f"No lineaments found within {radius_km}km of occurrence {occurrence_id}.")

    epsg = utm_epsg_for_lonlat(lon, lat)
    trace_gdf = gpd.GeoDataFrame(df, geometry=gpd.GeoSeries.from_wkt(df["wkt"]), crs="EPSG:4326").to_crs(epsg)

    center = gpd.GeoSeries([wkt.loads(f"POINT({lon} {lat})")], crs="EPSG:4326").to_crs(epsg)
    area_polygon = center.buffer(radius_km * 1000)
    area_gdf = gpd.GeoDataFrame(geometry=area_polygon, crs=epsg)

    network = Network(
        trace_gdf=trace_gdf,
        area_gdf=area_gdf,
        name=f"occurrence_{occurrence_id}",
        determine_branches_nodes=False,
        circular_target_area=True,
        truncate_traces=True,
    )
    return network, df, epsg, occurrence_name


def analyze(occurrence_id, radius_km=50):
    env = load_env()
    network, df, epsg, occurrence_name = build_network(occurrence_id, radius_km, env)

    lengths_km = network.trace_length_array_non_weighted / 1000.0
    azimuths = network.trace_azimuth_array

    type_counts = df["type_name"].value_counts(dropna=False).to_dict()

    powerlaw_fit = {}
    try:
        fit = network.trace_lengths_powerlaw_fit_description  # property, not a method
        powerlaw_fit = {k: (float(v) if isinstance(v, (int, float, np.floating)) else str(v)) for k, v in fit.items()}
    except Exception as e:
        powerlaw_fit = {"error": f"power-law fit failed: {e}"}

    return {
        "occurrence_id": occurrence_id,
        "occurrence_name": occurrence_name,
        "radius_km": radius_km,
        "utm_epsg_used": epsg,
        "n_lineaments": int(len(df)),
        "lineament_type_counts": {str(k): int(v) for k, v in type_counts.items()},
        "total_length_km": round(float(lengths_km.sum()), 2),
        "mean_length_km": round(float(lengths_km.mean()), 3),
        "median_length_km": round(float(np.median(lengths_km)), 3),
        # Computed directly rather than trusting fractopo's raw "Fracture Intensity B21" parameter,
        # which is in native CRS units (length-per-area in meters, i.e. effectively 1/m) — easy to
        # misinterpret. area is exact here since the target area is a circle of known radius.
        "fracture_intensity_km_per_km2": round(float(lengths_km.sum() / (np.pi * radius_km**2)), 5),
        "mean_azimuth_deg": round(float(_circular_mean_deg(azimuths)), 1),
        "trace_length_powerlaw_fit": powerlaw_fit,
        "methodology_note": (
            "Statistics use trace-level geometry only (no branch/node topological analysis) — "
            "this dataset is independently-digitized regional fault traces, not a topologically "
            "clean fracture network, so intersection/connectivity analysis was deliberately not "
            "attempted. Lengths/azimuths are computed after reprojecting to the correct local UTM "
            "zone; the target area is a circular buffer around the occurrence (Mauldon circular "
            "correction applied), not a true independent geological study boundary."
        ),
    }


def _circular_mean_deg(azimuths_deg):
    """Lineament azimuths are axial (0-180 deg, no directionality), so an ordinary circular mean
    would be wrong — double the angles before averaging, then halve the result (standard
    treatment for axial/orientation data, as opposed to true circular/vector data)."""
    rad = np.deg2rad(azimuths_deg * 2)
    mean_rad = np.arctan2(np.mean(np.sin(rad)), np.mean(np.cos(rad))) / 2
    mean_deg = np.rad2deg(mean_rad) % 180
    return mean_deg


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("occurrence_id", type=int)
    parser.add_argument("--radius-km", type=float, default=50)
    args = parser.parse_args()
    result = analyze(args.occurrence_id, args.radius_km)
    print(json.dumps(result, indent=2))
