"""
Pearce (2008) Th/Yb vs Nb/Yb tectonic discrimination diagram for an arbitrary set of sample_ids —
one occurrence, many occurrences, or a whole region.

Classic geochemical fingerprinting diagram for distinguishing magma source / tectonic setting
(MORB-OIB array vs. subduction-influenced / upper-crustal-contaminated compositions) from
immobile trace elements. Uses pyrolite's built-in Pearce (2008) template
(pyrolite.plot.templates.pearceThNbYb) overlaid with the given samples' actual data.

IMPORTANT DATA COVERAGE CAVEAT: this dataset only has Nb analysed for ~169 of ~1,320 Argentina
occurrences (~13%) — Th and Yb are much more broadly analysed (~94-98%), so Nb is the bottleneck.
This script will raise a clear error (not silently produce an empty/misleading plot) if none of the
given samples have Nb data — check first with run_sql if unsure (analyte_symbol='Nb' AND
sample_id = ANY(...)).

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
from pyrolite.plot.templates.pearce import pearceThNbYb

REQUIRED_KEYS = ["PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD"]
NEEDED_ELEMENTS = ["Th", "Nb", "Yb"]


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


def to_wide_ppm(long_df):
    if long_df.empty:
        return pd.DataFrame()
    df = long_df.copy()
    bad_units = df.loc[~df["unit_code"].isin(["ppm"]), "unit_code"].unique()
    if len(bad_units):
        raise ValueError(f"Unexpected non-ppm units for {NEEDED_ELEMENTS}: {list(bad_units)}")
    return df.pivot_table(index="sample_id", columns="analyte_symbol", values="value", aggfunc="mean")


def generate_pearce_plot(sample_ids, label=None, save_path=None):
    env = load_env()
    long_df = fetch_data(sample_ids, env)
    wide = to_wide_ppm(long_df)

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
    th_yb = wide["Th"] / wide["Yb"]

    title = label or f"{len(sample_ids)} samples"
    ax = pearceThNbYb()
    ax.scatter(nb_yb, th_yb, color="crimson", edgecolor="k", s=30, zorder=5, label=title)
    ax.legend(loc="lower right", fontsize=8)
    ax.set_title(f"{title} — Pearce (2008) Th/Yb-Nb/Yb (n={wide.shape[0]} samples)")
    fig = ax.get_figure()
    fig.tight_layout()

    summary = {
        "label": label,
        "n_samples": int(wide.shape[0]),
        "samples": [
            {"sample_id": int(sid), "Nb_Yb": round(float(nb_yb[sid]), 3), "Th_Yb": round(float(th_yb[sid]), 3)}
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
    generate_pearce_plot(args.sample_ids, label=args.label, save_path=args.save)
