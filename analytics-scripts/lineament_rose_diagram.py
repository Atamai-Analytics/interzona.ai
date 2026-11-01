"""
Structural lineament rose diagram (orientation frequency) around a mineral occurrence, using
fractopo (https://github.com/nialov/fractopo).

Pulls lineaments within a radius of an occurrence, reprojects to the correct local UTM zone, and
produces a length-weighted equal-area rose diagram of trace orientations — the standard way
structural geologists visualize whether a local fault/fracture fabric has a dominant strike
direction (often diagnostic of the regional stress regime or a structural control on
mineralization).

Same data pipeline as lineament_network_stats.py (kept self-contained/duplicated rather than
cross-imported, consistent with the other analytics scripts in this registry).

Designed to run as a cell in an E2B code-interpreter sandbox (via runCode). Also runnable directly
for local testing.
"""
import os
import warnings

warnings.filterwarnings("ignore")

import json

import pandas as pd
import geopandas as gpd
import psycopg2
from shapely import wkt
import matplotlib.pyplot as plt
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
    return 32700 + zone if lat < 0 else 32600 + zone


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
        SELECT l.lineament_id, ST_AsText(l.geom)
        FROM geochem.lineaments l
        JOIN core.occurrences o ON o.occurrence_id = %s
        WHERE ST_DWithin(o.geog, l.geog, %s)
        """,
        (occurrence_id, radius_km * 1000),
    )
    rows = cur.fetchall()
    conn.close()
    df = pd.DataFrame(rows, columns=["lineament_id", "wkt"])
    return df, lon, lat, occurrence_name


def generate_rose_diagram(occurrence_id, radius_km=50, save_path=None):
    env = load_env()
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
        name=f"Occ. {occurrence_id} ({len(df)} traces, {radius_km:g}km)",
        determine_branches_nodes=False,
        circular_target_area=True,
        truncate_traces=True,
    )
    _, fig, _ = network.plot_trace_azimuth()

    # Azimuths are axial (0-180, no inherent direction) — doubling before averaging and halving
    # after is the standard fix for a plain circular mean being wrong on axial data (e.g. 10 and
    # 170 degrees should average to ~0/180, not 90).
    import numpy as np

    azimuths = np.asarray(network.trace_azimuth_array)
    doubled = np.deg2rad(azimuths * 2)
    mean_doubled = np.arctan2(np.mean(np.sin(doubled)), np.mean(np.cos(doubled)))
    dominant_azimuth = float(np.rad2deg(mean_doubled) / 2 % 180)

    summary = {
        "occurrence_id": occurrence_id,
        "occurrence_name": occurrence_name,
        "radius_km": radius_km,
        "n_traces": int(len(df)),
        "dominant_azimuth_deg": round(dominant_azimuth, 1),
    }
    print(json.dumps(summary, indent=2))

    if save_path:
        fig.savefig(save_path, dpi=150)
        plt.close(fig)
    else:
        plt.show()


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("occurrence_id", type=int)
    parser.add_argument("--radius-km", type=float, default=50)
    parser.add_argument("--save", default=None, help="Local file path to save PNG (for testing outside a sandbox).")
    args = parser.parse_args()
    generate_rose_diagram(args.occurrence_id, args.radius_km, save_path=args.save)
