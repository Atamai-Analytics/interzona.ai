"""
CLR-transformed compositional correlation analysis for an arbitrary set of sample_ids, using the centred
log-ratio transform in plain numpy (ln(x_i / geometric mean of the row), identical to pyrolite's CLR; pyrolite is not
needed, which keeps the sandbox install small).

Why this exists: computing an ordinary Pearson correlation directly on raw ppm/percent
concentrations is a well-known statistical pitfall for geochemical data (Aitchison, 1986) — because
every sample's elements are constrained to sum to a constant (100%, or "the rest is unanalysed
gangue"), raw concentrations are NOT independent: if one element's proportion goes up, others are
mathematically forced down, regardless of any real geological relationship. This "closure" effect
can manufacture strong spurious negative correlations (or mask real ones) that have nothing to do
with the actual mineralogy/process. The Centred Log-Ratio (CLR) transform removes this artifact by
working in log-ratio space, giving statistically meaningful correlations.

This script reports BOTH the raw and CLR-transformed correlation for the strongest element pairs,
specifically so the difference (and the risk of trusting raw correlations) is visible rather than
hidden.

Usage:
    python clr_correlation_analysis.py <sample_id,sample_id,...> [--top-n 10] [--label "..."]
"""
import os
import json
import argparse
import warnings

warnings.filterwarnings("ignore")

import numpy as np
import pandas as pd
import psycopg2

REQUIRED_KEYS = ["PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD"]

# Broad element candidate list — filtered per-occurrence to whatever has complete coverage.
CANDIDATE_ELEMENTS = [
    "Al", "As", "Ba", "Be", "Bi", "Ca", "Cd", "Ce", "Co", "Cr", "Cs", "Cu", "Eu", "Fe", "Ga",
    "Hf", "K", "La", "Li", "Lu", "Mg", "Mn", "Mo", "Na", "Nb", "Nd", "Ni", "P", "Pb", "Rb",
    "Sb", "Sc", "Se", "Sm", "Sn", "Sr", "Ta", "Tb", "Th", "Ti", "Tl", "U", "V", "W", "Y",
    "Yb", "Zn", "Zr",
]


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
        WHERE r.sample_id = ANY(%s) AND r.analyte_symbol = ANY(%s) AND r.value > 0
          AND r.is_active AND r.value IS NOT NULL AND coalesce(k.use_in_statistics, true) AND NOT a.is_oxide
        ORDER BY r.sample_id, r.analyte_symbol, (w.basis = 'T') DESC NULLS LAST, w.priority NULLS LAST, r.result_id
    """
    df = pd.read_sql(query, conn, params=(sample_ids, CANDIDATE_ELEMENTS))
    conn.close()
    return df


def to_wide_ppm(long_df):
    """
    Converts every row to a consistent ppm basis before pivoting. Real data (checked against
    Greenland) mixes three units for the same CANDIDATE_ELEMENTS list -- e.g. most U is in ppm but
    ~50 Greenland results are in ppb (ultra-trace gold/PGE-suite elements like Au/Ir/Pt/Pd aren't in
    CANDIDATE_ELEMENTS at all, but U is, and apparently gets analysed on both a routine ppm package
    and a precious-metal ppb package depending on the lab run). An earlier version of this function
    raised on ANY unit outside {ppm, %} -- that's correct for a genuinely unexpected unit, but it
    meant one ppb row anywhere in the whole candidate-element fetch killed the ENTIRE analysis, not
    just that one element. Converting ppb explicitly (1 ppm = 1000 ppb) fixes the real, known case;
    anything still unrecognized after that still raises, same as before.
    """
    if long_df.empty:
        return pd.DataFrame()
    df = long_df.copy()
    is_pct = df["unit_code"] == "%"
    df.loc[is_pct, "value"] = df.loc[is_pct, "value"] * 10000  # % -> ppm
    is_ppb = df["unit_code"] == "ppb"
    df.loc[is_ppb, "value"] = df.loc[is_ppb, "value"] / 1000  # ppb -> ppm
    bad_units = df.loc[~df["unit_code"].isin(["ppm", "%", "ppb"]), "unit_code"].unique()
    if len(bad_units):
        raise ValueError(f"Unexpected units for element data: {list(bad_units)}")
    return df.pivot_table(index="sample_id", columns="analyte_symbol", values="value", aggfunc="mean")


def top_pairs(corr_df, top_n, exclude_diag=True):
    pairs = []
    cols = corr_df.columns
    for i, a in enumerate(cols):
        for b in cols[i + 1:]:
            pairs.append((a, b, corr_df.loc[a, b]))
    pairs.sort(key=lambda p: abs(p[2]), reverse=True)
    return pairs[:top_n]


def choose_complete_block(wide_all, min_samples):
    """
    CLR needs every retained sample to have every retained element. A strict 'every element present in every
    sample' rule returns nothing for a heterogeneous selection (many campaigns / labs / decades), so instead try
    a series of element-coverage thresholds -- keep elements present in at least t of the samples, then keep only
    samples that have all of those elements -- and take the block with the most data (samples x elements).
    The note records what was dropped so the caller can report it.
    """
    n = wide_all.shape[0]
    coverage = wide_all.notna().mean()
    best, best_key, best_t = None, (-1, -1), None
    seen = set()
    for t in (1.0, 0.95, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3):
        cols = [c for c in wide_all.columns if coverage[c] >= t]
        key = tuple(cols)
        if len(cols) < 3 or key in seen:
            continue
        seen.add(key)
        block = wide_all[cols].dropna()
        block = block.loc[:, block.std() > 0]
        if block.shape[0] < min_samples or block.shape[1] < 3:
            continue
        score = (block.shape[0] * block.shape[1], t)
        if score > best_key:
            best, best_key, best_t = block, score, t
    if best is None:
        return pd.DataFrame(), "no element set had enough samples in common"
    if best_t == 1.0:
        note = "elements with complete coverage across all samples with data were used"
    else:
        note = (
            f"no single element set covered every sample; kept elements analysed in at least {int(best_t * 100)}% of the "
            f"{n} samples with data, then only the {best.shape[0]} samples that have all {best.shape[1]} of them "
            "(a sub-composition: CLR is computed over these elements only)"
        )
    return best, note


def analyze(sample_ids, top_n=10, min_samples=8, label=None):
    env = load_env()
    long_df = fetch_data(sample_ids, env)
    if long_df.empty:
        return {"label": label, "sample_ids_requested": sample_ids, "error": "No analytical data found for these samples."}

    wide_all = to_wide_ppm(long_df)
    n_with_data = int(wide_all.shape[0])
    wide, coverage_note = choose_complete_block(wide_all, min_samples)
    # Drop elements with exactly zero variance (e.g. every sample at the same value, often a
    # detection-limit-substitution artifact) — raw correlation is undefined (0/0) for these, and
    # while CLR still produces a number, it's actually measuring how much the OTHER elements vary
    # relative to this fixed one, not a real relationship involving the constant element itself.
    wide = wide.loc[:, wide.std() > 0]

    if wide.shape[0] < min_samples or wide.shape[1] < 3:
        return {
            "label": label,
            "sample_ids_requested": sample_ids,
            "error": (
                f"Insufficient complete-case data for a meaningful correlation analysis "
                f"({wide.shape[0]} samples x {wide.shape[1]} elements with full coverage; "
                f"need at least {min_samples} samples and 3 elements)."
            ),
        }

    raw_corr = wide.corr(method="pearson")
    # CLR: ln of each value minus the mean of the logs across the row's elements (= ln(x / geometric mean)).
    log_x = np.log(wide)
    clr_df = log_x.sub(log_x.mean(axis=1), axis=0)
    clr_corr_relabelled = clr_df.corr(method="pearson")

    strongest_clr = top_pairs(clr_corr_relabelled, top_n)
    comparison = []
    for a, b, clr_r in strongest_clr:
        raw_r = raw_corr.loc[a, b]
        comparison.append({
            "element_pair": f"{a}-{b}",
            "clr_correlation": round(float(clr_r), 3),
            "raw_correlation": round(float(raw_r), 3),
            "difference": round(float(clr_r - raw_r), 3),
        })

    return {
        "label": label,
        "sample_ids_requested": sample_ids,
        "n_samples_with_any_data": n_with_data,
        "n_samples": int(wide.shape[0]),
        "n_elements_with_complete_coverage": int(wide.shape[1]),
        "elements_used": list(wide.columns),
        "elements_dropped_for_sparse_coverage": [c for c in wide_all.columns if c not in wide.columns],
        "coverage_note": coverage_note,
        "strongest_clr_correlations": comparison,
        "methodology_note": (
            "raw_correlation is an ordinary Pearson correlation on untransformed ppm values — "
            "known to be statistically unreliable for compositional (closed-sum) data, since "
            "elements are not mathematically independent (Aitchison, 1986). clr_correlation uses "
            "the Centred Log-Ratio transform, which corrects for this. Where 'difference' is "
            "large, the raw correlation should NOT be trusted as reflecting a real geological "
            "relationship — prefer the CLR value."
        ),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("sample_ids", type=lambda s: [int(x) for x in s.split(",")])
    parser.add_argument("--top-n", type=int, default=10)
    parser.add_argument("--label", default=None)
    args = parser.parse_args()
    result = analyze(args.sample_ids, args.top_n, label=args.label)
    print(json.dumps(result, indent=2))
