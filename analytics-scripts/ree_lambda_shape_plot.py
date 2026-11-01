"""
REE pattern "shape space" plot for an arbitrary set of sample_ids — one occurrence, many
occurrences, or a whole discovered region.

Where ree_pattern_analysis.py collapses a whole selection down to ONE averaged lambda-tau
value (fine for a single occurrence, but it washes out real differences when the selection
spans multiple occurrences/deposit types), this script fits pyrolite's orthogonal polynomial
lambda-tau coefficients (O'Neill, 2016) PER SAMPLE and plots them against each other — the
standard lambda1-vs-lambda2 "shape space" scatter used to compare REE pattern shapes across
many samples at a glance:
  - lambda0: overall pattern level (chondrite-normalized average abundance)
  - lambda1: overall slope (LREE/HREE fractionation — same information as La/Yb, but fit from
    the whole pattern rather than two endpoints)
  - lambda2: curvature (mid-REE bowing relative to the straight-line lambda0/lambda1 trend —
    sensitive to things like hydrothermal REE mobility, garnet fractionation, or a Ce/Eu
    anomaly's neighbors)
  - lambda3: higher-order wiggle (tetrad-type effects) — least robust, shown for completeness
    only

This makes it possible to actually see whether a discovered set of samples (e.g. "all LCT
pegmatite occurrences in Argentina") clusters into one coherent pattern shape or several
distinct groups — something no single-pattern spider plot or single averaged number can show.

Samples with too few REE analysed for a stable fit (pyrolite's own min_elements threshold)
come back as NaN from the fit and are dropped before plotting, reported in the summary rather
than silently ignored.

Designed to run as a cell in an E2B code-interpreter sandbox (via runCode). Also runnable
directly for local testing.
"""
import os
import warnings

warnings.filterwarnings("ignore")

import json

import pandas as pd
import psycopg2
import matplotlib.pyplot as plt
import pyrolite.geochem  # noqa: F401 — registers the .pyrochem DataFrame accessor
from pyrolite.geochem.ind import REE

REQUIRED_KEYS = ["PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD"]
LAMBDA_COLS = ["λ0", "λ1", "λ2", "λ3"]  # pyrolite's actual column names


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


def generate_lambda_shape_plot(sample_ids, reference="Chondrite_PON", label=None, save_path=None):
    env = load_env()
    long_df = fetch_ree_data(sample_ids, env)
    wide = to_wide_ppm(long_df)
    if wide.empty:
        raise ValueError("None of the given samples have any REE data.")

    elements_per_sample = wide.notna().sum(axis=1)

    try:
        lam = wide.pyrochem.lambda_lnREE(norm_to=reference)
        valid = lam.dropna(how="any")
    except IndexError:
        # pyrolite returns NaN rows for individual samples below its min_elements threshold,
        # but raises IndexError instead when NOT EVEN ONE sample in the whole batch clears it
        # (nothing left to fit a basis against) — normalize that into the same clear error path.
        valid = pd.DataFrame(columns=LAMBDA_COLS)
    n_requested = len(sample_ids)
    n_fit = int(valid.shape[0])
    n_dropped = int(wide.shape[0]) - n_fit
    if valid.empty:
        raise ValueError(
            f"None of these {wide.shape[0]} samples had enough REE elements analysed for a "
            "stable lambda-tau fit. Try ree_pattern_analysis (averaged La/Yb + Eu anomaly) or "
            "ree_spider_plot instead, which tolerate sparser data."
        )

    title = label or f"{len(sample_ids)} samples"
    fig, ax = plt.subplots(figsize=(7, 6))
    sc = ax.scatter(
        valid[LAMBDA_COLS[1]], valid[LAMBDA_COLS[2]],
        c=valid[LAMBDA_COLS[0]], cmap="viridis", s=90, edgecolor="k", zorder=5,
    )
    cbar = fig.colorbar(sc, ax=ax)
    cbar.set_label("λ0 (overall chondrite-normalized level)")
    ax.axhline(0, color="gray", linewidth=0.8, linestyle="--", zorder=1)
    ax.axvline(0, color="gray", linewidth=0.8, linestyle="--", zorder=1)
    if n_fit <= 30:
        for sid, row in valid.iterrows():
            ax.annotate(str(sid), (row[LAMBDA_COLS[1]], row[LAMBDA_COLS[2]]),
                        fontsize=7, xytext=(4, 4), textcoords="offset points")
    ax.set_xlabel("λ1 (slope — LREE/HREE fractionation)")
    ax.set_ylabel("λ2 (curvature — mid-REE bowing)")
    ax.set_title(f"{title} — REE pattern shape space (n={n_fit} of {n_requested} requested)")
    fig.tight_layout()

    per_sample = [
        {
            "sample_id": int(sid),
            "lambda0": round(float(row[LAMBDA_COLS[0]]), 5),
            "lambda1": round(float(row[LAMBDA_COLS[1]]), 5),
            "lambda2": round(float(row[LAMBDA_COLS[2]]), 5),
            "lambda3": round(float(row[LAMBDA_COLS[3]]), 5),
            "n_ree_elements_analysed": int(elements_per_sample.get(sid, 0)),
        }
        for sid, row in valid.iterrows()
    ]
    summary = {
        "label": label,
        "reference_composition": reference,
        "n_samples_requested": n_requested,
        "n_samples_with_ree_data": int(wide.shape[0]),
        "n_samples_fit": n_fit,
        "n_samples_dropped_insufficient_elements": n_dropped,
        "samples": per_sample,
        "interpretation_notes": (
            "lambda1 > 0 and large means strong LREE enrichment relative to HREE (steep pattern, "
            "like a high La/Yb); lambda1 near 0 means a flat pattern. lambda2 captures mid-REE "
            "bowing away from the straight lambda0/lambda1 trend — away from zero can indicate "
            "hydrothermal REE mobility, garnet in the source/residue, or a mid-REE anomaly. "
            "Samples clustering together in this lambda1-lambda2 space share a similar pattern "
            "shape regardless of overall enrichment level (lambda0, shown as point color); "
            "samples scattered across distinct regions suggest genuinely different REE-controlling "
            "processes or sources within the selection, which single-pattern spider plots make "
            "hard to see at a glance across many samples. lambda3 is reported but is the least "
            "robust term and shouldn't be over-interpreted."
        ),
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
    generate_lambda_shape_plot(args.sample_ids, reference=args.reference, label=args.label, save_path=args.save)
