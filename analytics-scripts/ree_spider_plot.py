"""
REE spider (multi-element pattern) diagram for an arbitrary set of sample_ids — one occurrence,
many occurrences, or a whole region, whatever the caller already resolved via SQL.

Same data pipeline as ree_pattern_analysis.py (fetch -> pivot -> chondrite-normalize), but
produces a visual pattern diagram via pyrolite's `.pyroplot.REE()` instead of scalar summary
statistics. This is the standard visualization economic geologists use to eyeball REE
enrichment/depletion and pattern shape (LREE vs HREE slope, Eu anomalies) at a glance.

Designed to run as a cell in an E2B code-interpreter sandbox (via runCode, not a CLI subprocess) —
matplotlib's captured figure becomes the sandbox execution's image result. Also runnable directly
for local testing (saves to a PNG file instead).
"""
import os
import warnings

warnings.filterwarnings("ignore")

import json

import pandas as pd
import psycopg2
# Deliberately do NOT force a matplotlib backend here: E2B's sandbox configures its own
# inline/capturing backend so plt.show() becomes an image result, and local CLI testing
# uses fig.savefig() below which works fine with any backend.
import matplotlib.pyplot as plt
import pyrolite.geochem  # noqa: F401 — registers .pyrochem
import pyrolite.plot  # noqa: F401 — registers .pyroplot
from pyrolite.geochem.ind import REE

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


def fetch_ree_data(sample_ids, env):
    ree_symbols = REE()
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
    df = pd.read_sql(query, conn, params=(sample_ids, ree_symbols))
    conn.close()
    return df


def to_wide_ppm(long_df):
    if long_df.empty:
        return pd.DataFrame()
    df = long_df.copy()
    bad_units = df.loc[~df["unit_code"].isin(["ppm"]), "unit_code"].unique()
    if len(bad_units):
        raise ValueError(f"Unexpected non-ppm units for REE data: {list(bad_units)}")
    return df.pivot_table(index="sample_id", columns="analyte_symbol", values="value", aggfunc="mean")


def generate_spider_plot(sample_ids, reference="Chondrite_PON", label=None, save_path=None):
    env = load_env()
    long_df = fetch_ree_data(sample_ids, env)
    if long_df.empty:
        raise ValueError("No REE data found for these samples.")

    wide = to_wide_ppm(long_df)
    normalized = wide.pyrochem.normalize_to(reference, units="ppm")

    title = label or f"{len(sample_ids)} samples"
    fig, ax = plt.subplots(figsize=(8, 5))
    normalized.pyroplot.REE(
        ax=ax, mode="plot",
        line_kw={"color": "0.3", "alpha": 0.4},
        scatter_kw={"color": "0.2", "alpha": 0.6, "s": 12},
    )
    ax.set_yscale("log")
    ax.set_ylabel(f"Sample / {reference}")
    ax.set_title(f"{title} — REE pattern (n={wide.shape[0]} samples, {reference}-normalized)")
    fig.tight_layout()

    # Printed before plt.show() so the caller (sandbox.ts) can capture it from stdout and pass it
    # back to the model alongside the image — exact numbers to ground interpretation, not just a
    # picture to eyeball.
    summary = {
        "label": label,
        "reference": reference,
        "n_samples": int(wide.shape[0]),
        "elements_present": list(normalized.columns),
        "median_normalized_value_per_element": {
            el: round(float(normalized[el].median()), 3) for el in normalized.columns
        },
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
    parser.add_argument("--reference", default="Chondrite_PON")
    parser.add_argument("--label", default=None)
    parser.add_argument("--save", default=None, help="Local file path to save PNG (for testing outside a sandbox).")
    args = parser.parse_args()
    generate_spider_plot(args.sample_ids, args.reference, label=args.label, save_path=args.save)
