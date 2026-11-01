"""
Extended multi-element (LILE + HFSE + REE) normalized spider diagram for an arbitrary set of
sample_ids — one occurrence, many occurrences, or a whole region.

This is the standard "primitive-mantle-normalized multi-element diagram" used broadly in igneous
petrology/economic geology — much richer than a REE-only spider plot, since it also captures large-
ion lithophile elements (Rb, Ba, K, Sr — mobile, fluid/melt-incompatible) and high-field-strength
elements (Th, U, Nb, Ta, Zr, Hf, Ti — immobile, useful for petrogenesis even when a rock has been
altered). Default reference is Primitive Mantle (PM_PON) rather than chondrite, which is the
standard choice for a full multi-element diagram rather than a REE-only one.

Only elements actually analysed for the occurrence are plotted — this dataset has uneven element
coverage (Nb/Zr are only in ~13% of occurrences; most others cover ~97%), so the candidate list
below is deliberately broad and filtered down per-occurrence rather than required in full.

Designed to run as a cell in an E2B code-interpreter sandbox (via runCode) — matplotlib's captured
figure becomes the sandbox execution's image result. Also runnable directly for local testing.
"""
import os
import warnings

warnings.filterwarnings("ignore")

import json

import pandas as pd
import psycopg2
import matplotlib.pyplot as plt
import pyrolite.geochem  # noqa: F401 — registers .pyrochem
import pyrolite.plot  # noqa: F401 — registers .pyroplot
from pyrolite.geochem.ind import by_incompatibility

# Broad candidate list spanning LILE, HFSE, and REE — filtered per-occurrence to what's present.
CANDIDATE_ELEMENTS = [
    "Cs", "Rb", "Ba", "Th", "U", "Nb", "Ta", "K", "La", "Ce", "Pb", "Pr", "Sr",
    "Nd", "Sm", "Zr", "Hf", "Eu", "Ti", "Gd", "Tb", "Dy", "Y", "Ho", "Er", "Tm", "Yb", "Lu",
]

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


def fetch_element_data(sample_ids, env):
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
    df = pd.read_sql(query, conn, params=(sample_ids, CANDIDATE_ELEMENTS))
    conn.close()
    return df


def to_wide_ppm(long_df):
    """Pivot to wide format, converting any % columns (e.g. K, Ti sometimes reported as %) to ppm
    so every column shares one unit before normalization."""
    if long_df.empty:
        return pd.DataFrame()
    df = long_df.copy()
    is_pct = df["unit_code"] == "%"
    df.loc[is_pct, "value"] = df.loc[is_pct, "value"] * 10000  # % -> ppm
    bad_units = df.loc[~df["unit_code"].isin(["ppm", "%"]), "unit_code"].unique()
    if len(bad_units):
        raise ValueError(f"Unexpected units for element data: {list(bad_units)}")
    return df.pivot_table(index="sample_id", columns="analyte_symbol", values="value", aggfunc="mean")


def generate_extended_spider_plot(sample_ids, reference="PM_PON", label=None, save_path=None):
    env = load_env()
    long_df = fetch_element_data(sample_ids, env)
    if long_df.empty:
        raise ValueError("No trace element data found for these samples.")

    wide = to_wide_ppm(long_df)
    ordered_elements = [el for el in by_incompatibility(list(wide.columns)) if el in wide.columns]
    wide = wide[ordered_elements]
    normalized = wide.pyrochem.normalize_to(reference, units="ppm")

    title = label or f"{len(sample_ids)} samples"
    fig, ax = plt.subplots(figsize=(11, 5))
    normalized.pyroplot.spider(
        ax=ax, mode="plot", index_order=by_incompatibility,
        line_kw={"color": "0.3", "alpha": 0.4},
        scatter_kw={"color": "0.2", "alpha": 0.6, "s": 12},
    )
    ax.set_yscale("log")
    ax.set_ylabel(f"Sample / {reference}")
    ax.set_title(
        f"{title} — extended multi-element pattern "
        f"(n={wide.shape[0]} samples, {reference}-normalized, {len(ordered_elements)} elements)"
    )
    fig.tight_layout()

    summary = {
        "label": label,
        "reference": reference,
        "n_samples": int(wide.shape[0]),
        "elements_present": ordered_elements,
        "median_normalized_value_per_element": {
            el: round(float(normalized[el].median()), 3) for el in ordered_elements
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
    parser.add_argument("--reference", default="PM_PON")
    parser.add_argument("--label", default=None)
    parser.add_argument("--save", default=None, help="Local file path to save PNG (for testing outside a sandbox).")
    args = parser.parse_args()
    generate_extended_spider_plot(args.sample_ids, args.reference, label=args.label, save_path=args.save)
