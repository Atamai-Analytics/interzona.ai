"""
REE (rare earth element) pattern analysis for an arbitrary set of sample_ids — one occurrence,
many occurrences, or a whole region, whatever the caller already resolved via SQL.

Standard economic-geology workflow, built on pyrolite (https://github.com/morganjwilliams/pyrolite):
  1. Pull whatever REE elements were actually analysed for the given samples.
  2. Normalize to a reference reservoir (default: Chondrite_PON) — this is what makes REE
     concentrations comparable/interpretable, since raw ppm values span orders of magnitude
     just from mineral abundance, not enrichment processes.
  3. Compute the classic scalar indicators: La/Yb ratio (light-vs-heavy REE fractionation) and
     the Eu anomaly (Eu/Eu* — sensitive to plagioclase fractionation / redox state, a standard
     tell for certain REE deposit types).
  4. Fit pyrolite's lambda-tau orthogonal polynomial parameterization (O'Neill, 2016) for a
     rigorous, comparable numerical summary of the whole pattern's shape, not just two ratios.

Only elements actually present for a sample are used — this dataset has a partial REE suite
(La, Ce, Nd, Sm, Eu, Tb, Yb, Lu; no Pr/Gd/Dy/Ho/Er/Tm), which pyrolite handles fine.

Usage:
    python ree_pattern_analysis.py <sample_id,sample_id,...> [--reference Chondrite_PON] [--label "..."]

Reads DB connection details from .env.local in this repo (the read-only cm_app_readonly role —
this script never needs write access).
"""
import sys
import os
import json
import argparse
import warnings

warnings.filterwarnings("ignore")

import numpy as np
import pandas as pd
import psycopg2
import pyrolite.geochem  # noqa: F401 — registers the .pyrochem DataFrame accessor
from pyrolite.geochem.ind import REE
from pyrolite.geochem.transform import lambda_lnREE

ENV_PATH = os.path.join(os.path.dirname(__file__), "..", ".env.local")


REQUIRED_KEYS = ["PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD"]


def load_env():
    """Prefer real environment variables (how this script runs inside a sandbox, where the
    caller passes DB credentials directly) — only fall back to reading .env.local for
    convenient local CLI testing outside a sandbox."""
    if all(k in os.environ for k in REQUIRED_KEYS):
        return {k: os.environ[k] for k in REQUIRED_KEYS}

    env = {}
    with open(ENV_PATH, "r", encoding="utf-8") as f:
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
    """Pivot long-format results to wide (sample_id rows x element columns), all in ppm."""
    if long_df.empty:
        return pd.DataFrame()
    df = long_df.copy()
    # REE are reported in ppm throughout this dataset; guard against surprises rather than
    # silently mixing units.
    bad_units = df.loc[~df["unit_code"].isin(["ppm"]), "unit_code"].unique()
    if len(bad_units):
        raise ValueError(f"Unexpected non-ppm units for REE data: {list(bad_units)}")
    wide = df.pivot_table(index="sample_id", columns="analyte_symbol", values="value", aggfunc="mean")
    return wide


def eu_anomaly(normalized_row):
    """Eu/Eu* = Eu_N / sqrt(Sm_N * Gd_N), falling back to Sm/Tb geometric mean if Gd is absent
    (this dataset has no Gd) — a documented, standard substitution when Gd wasn't analysed."""
    if "Eu" not in normalized_row:
        return None
    sm = normalized_row.get("Sm")
    gd = normalized_row.get("Gd")
    tb = normalized_row.get("Tb")
    if sm is not None and gd is not None:
        denom = np.sqrt(sm * gd)
    elif sm is not None and tb is not None:
        denom = np.sqrt(sm * tb)
    else:
        return None
    if not denom or np.isnan(denom):
        return None
    return round(float(normalized_row["Eu"] / denom), 4)


def analyze(sample_ids, reference="Chondrite_PON", label=None):
    env = load_env()
    long_df = fetch_ree_data(sample_ids, env)
    if long_df.empty:
        return {"label": label, "n_samples_requested": len(sample_ids), "error": "No REE data found for these samples."}

    wide = to_wide_ppm(long_df)
    present_elements = list(wide.columns)

    normalized = wide.pyrochem.normalize_to(reference, units="ppm")
    mean_normalized = normalized.mean(axis=0, skipna=True)

    la_yb = None
    if "La" in mean_normalized and "Yb" in mean_normalized and mean_normalized["Yb"]:
        la_yb = round(float(mean_normalized["La"] / mean_normalized["Yb"]), 4)

    eu_anom = eu_anomaly(mean_normalized)

    lambdas = None
    lambda_caveat = None
    try:
        mean_ppm = wide.mean(axis=0, skipna=True).to_frame().T
        lam = lambda_lnREE(mean_ppm, norm_to=reference)
        lambdas = {col: round(float(lam[col].iloc[0]), 5) for col in lam.columns}
        # A degree-3 fit (lambda0..lambda3) needs a reasonably complete, evenly-spaced REE suite
        # to be numerically stable. With gaps in the middle of the series (this dataset lacks
        # Pr/Gd/Dy/Ho/Er/Tm), the higher-order terms can swing to implausible magnitudes even
        # though the fit "succeeds" — flag it rather than present a falsely precise number.
        if len(present_elements) < 10:
            lambda_caveat = (
                f"Only {len(present_elements)}/14 REE were analysed, with gaps in the middle of "
                "the series. Lambda0 (average level) and lambda1 (overall slope) are reasonably "
                "robust here, but lambda2/lambda3 (curvature/higher-order shape) should be treated "
                "as unreliable with this few, unevenly-spaced points — prefer La/Yb ratio and Eu "
                "anomaly for this occurrence's interpretation."
            )
    except Exception as e:
        lambdas = {"error": f"lambda fit failed: {e}"}

    return {
        "label": label,
        "sample_ids_requested": sample_ids,
        "reference_composition": reference,
        "n_samples": int(wide.shape[0]),
        "elements_present": present_elements,
        "mean_chondrite_normalized": {k: round(float(v), 4) for k, v in mean_normalized.dropna().items()},
        "la_yb_ratio_normalized": la_yb,
        "eu_anomaly": eu_anom,
        "lambda_tau_coefficients": lambdas,
        "lambda_tau_caveat": lambda_caveat,
        "interpretation_notes": (
            "La/Yb_N > 1 indicates light-REE enrichment relative to heavy REE (typical of many "
            "carbonatite/alkaline REE deposits); Eu/Eu* < 1 indicates a negative Eu anomaly "
            "(plagioclase fractionation or reducing conditions), > 1 a positive anomaly."
        ),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("sample_ids", type=lambda s: [int(x) for x in s.split(",")])
    parser.add_argument("--reference", default="Chondrite_PON")
    parser.add_argument("--label", default=None)
    args = parser.parse_args()
    result = analyze(args.sample_ids, args.reference, args.label)
    print(json.dumps(result, indent=2))
