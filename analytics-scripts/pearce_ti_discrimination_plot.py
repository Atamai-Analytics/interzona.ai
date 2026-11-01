"""
Pearce (2008) TiO2/Yb vs Nb/Yb tectonic discrimination diagram for an arbitrary set of sample_ids —
one occurrence, many occurrences, or a whole region.

Companion diagram to pearce_discrimination_plot.py (Th/Yb-Nb/Yb) — same Pearce (2008) reference
framework, different vertical axis (TiO2/Yb instead of Th/Yb), useful as a second, largely
independent check of the same MORB-OIB / subduction-influence question since Ti and Th behave very
differently during magmatic and crustal processes.

UNIT NOTE: pyrolite's pearceTiNbYb() template expects TiO2 in wt% on the y-axis (per the
diagram's original published calibration), but this database stores Ti as an elemental ppm assay
(analyte_symbol='Ti'), not TiO2 wt%. This script converts Ti (ppm) -> TiO2 (wt%) via pyrolite's
own stoichiometric oxide_conversion("Ti", "TiO2") factor before computing the ratio — this is a
straightforward unit conversion of an already-measured element, NOT dependent on this project's
planned future oxide-assay migration (unlike the alteration-index script, which genuinely needs
directly-measured major-element oxides).

IMPORTANT DATA COVERAGE CAVEAT: same Nb bottleneck as pearce_discrimination_plot.py — only ~169 of
~1,320 Argentina occurrences have Nb analysed. Ti and Yb are broadly analysed (~97%+), so Nb remains
the limiting element for this diagram too. This script raises a clear error if none of the given
samples have Nb rather than silently producing an empty/misleading plot — check first with run_sql
if unsure (analyte_symbol='Nb' AND sample_id = ANY(...)).

Designed to run as a cell in an E2B code-interpreter sandbox (via runCode). Also runnable directly
for local testing.
"""
import os
import warnings

warnings.filterwarnings("ignore")

import json

import pandas as pd
import psycopg2
import matplotlib.pyplot as plt
from pyrolite.plot.templates.pearce import pearceTiNbYb
from pyrolite.geochem.transform import oxide_conversion

REQUIRED_KEYS = ["PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD"]
NEEDED_ELEMENTS = ["Ti", "Nb", "Yb"]

# Unlike Nb/Yb (always ppm in this dataset), Ti is assayed as elemental Ti in wt% (unit_code='%'),
# not ppm — checked against real data (100% of Ti rows are '%'). oxide_conversion's factor is a
# pure mass-ratio multiplier (same units in, same units out), so applying it to Ti wt% directly
# yields TiO2 wt% with no ppm/percent conversion needed in between.
EXPECTED_UNITS = {"Ti": "%", "Nb": "ppm", "Yb": "ppm"}
TI_TO_TIO2_FACTOR = oxide_conversion("Ti", "TiO2")(1.0)


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


def fetch_data(sample_ids, env):
    conn = psycopg2.connect(
        host=env["PGHOST"], port=env["PGPORT"], dbname=env["PGDATABASE"],
        user=env["PGUSER"], password=env["PGPASSWORD"],
    )
    query = """
        -- one best value per sample+analyte: active rows only, detected values only (use_in_statistics), total/no-digestion
        -- basis before partial leach, then package priority (geochem.package_wide_rules); never an average across methods
        SELECT DISTINCT ON (r.sample_id, r.analyte_symbol)
               r.sample_id, r.analyte_symbol, r.value, r.unit_code
        FROM geochem.analytical_results r
        JOIN geochem.analytes a ON a.analyte_id = r.analyte_id
        LEFT JOIN geochem.package_wide_rules w ON w.package_id = r.package_id
        LEFT JOIN geochem.result_classifications k ON k.result_id = r.result_id AND k.source_system = r.source_system
        WHERE r.sample_id = ANY(%s) AND r.analyte_symbol = ANY(%s)
          AND r.is_active AND r.value IS NOT NULL AND coalesce(k.use_in_statistics, true) AND NOT a.is_oxide
        ORDER BY r.sample_id, r.analyte_symbol, (w.basis = 'T') DESC NULLS LAST, w.priority NULLS LAST, r.result_id
    """
    df = pd.read_sql(query, conn, params=(sample_ids, NEEDED_ELEMENTS))
    conn.close()
    return df


def to_wide(long_df):
    if long_df.empty:
        return pd.DataFrame()
    df = long_df.copy()
    for element, expected_unit in EXPECTED_UNITS.items():
        bad = df.loc[(df["analyte_symbol"] == element) & (df["unit_code"] != expected_unit), "unit_code"].unique()
        if len(bad):
            raise ValueError(f"Unexpected unit(s) for {element} (expected {expected_unit}): {list(bad)}")
    return df.pivot_table(index="sample_id", columns="analyte_symbol", values="value", aggfunc="mean")


def generate_pearce_ti_plot(sample_ids, label=None, save_path=None):
    env = load_env()
    long_df = fetch_data(sample_ids, env)
    wide = to_wide(long_df)

    missing = [el for el in NEEDED_ELEMENTS if el not in wide.columns]
    if missing:
        raise ValueError(
            f"These samples are missing {missing} — this Pearce diagram needs all of "
            f"{NEEDED_ELEMENTS}, and only ~13% of occurrences in this dataset have Nb analysed. "
            "Check analyte availability with run_sql before retrying on a different selection."
        )
    wide = wide.dropna(subset=NEEDED_ELEMENTS)
    if wide.empty:
        raise ValueError(f"None of the given samples have all of {NEEDED_ELEMENTS} together.")

    nb_yb = wide["Nb"] / wide["Yb"]
    tio2_wtpct = wide["Ti"] * TI_TO_TIO2_FACTOR
    tio2_yb = tio2_wtpct / wide["Yb"]

    title = label or f"{len(sample_ids)} samples"
    ax = pearceTiNbYb()
    ax.scatter(nb_yb, tio2_yb, color="teal", edgecolor="k", s=30, zorder=5, label=title)
    ax.legend(loc="lower right", fontsize=8)
    ax.set_title(f"{title} — Pearce (2008) TiO2/Yb-Nb/Yb (n={wide.shape[0]} samples)")
    fig = ax.get_figure()
    fig.tight_layout()

    summary = {
        "label": label,
        "n_samples": int(wide.shape[0]),
        "samples": [
            {"sample_id": int(sid), "Nb_Yb": round(float(nb_yb[sid]), 3), "TiO2_Yb": round(float(tio2_yb[sid]), 3)}
            for sid in wide.index
        ],
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
    parser.add_argument("sample_ids", type=lambda s: [int(x) for x in s.split(",")])
    parser.add_argument("--label", default=None)
    parser.add_argument("--save", default=None, help="Local file path to save PNG (for testing outside a sandbox).")
    args = parser.parse_args()
    generate_pearce_ti_plot(args.sample_ids, label=args.label, save_path=args.save)
