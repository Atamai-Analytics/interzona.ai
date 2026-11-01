"""
Large et al. (1998) hydrothermal alteration box plot for an arbitrary set of sample_ids — one
occurrence, many occurrences, or a whole region. CCPI (chlorite-carbonate-
pyrite index) vs. the Ishikawa alteration index, the standard vectoring tool in VMS/epithermal
exploration for distinguishing barren host rock from ore-proximal hydrothermal alteration. Both
indices and their exact formulas come directly from pyrolite.geochem.alteration (CCPI,
IshikawaAltIndex) — this script only adds the DB fetch, a total-iron reconciliation step pyrolite's
own CCPI() doesn't handle robustly (see below), and the published box-plot axes/vector overlay,
which pyrolite does not provide as a plot template.

Enabled by the 2026-09-30 Greenland (GEUS) migration, which brought real major-oxide whole-rock
data into this database for the first time (188,692 oxide analytical_results rows; ~4,869 samples
with the full 6-oxide suite needed here). OXIDE DATA ARE NOW ALSO AVAILABLE FOR FINLAND, SWEDEN AND THE USGS DATA (total basis; about 6,250 / 11,700 / 68,000 samples with
the full suite plus iron, checked 2026-10-20). Argentina (SEGEMAR) and Victoria (GSV) have none. Of the 28 Greenland occurrences, 21 have at least
one oxide-complete sample (1-20 samples each) — check coverage with run_sql before calling this
tool on an occurrence that might not have it.

REAL DATA GOTCHA, found when wiring this in (not a guess — checked against the live migrated
data): oxide rows do NOT use oxide-formula symbols. `analyte_symbol` is resolved from
`geochem.analytes.element_symbol`, so every oxide collapses to its bare cation element —
'Silicon Dioxide' -> 'Si', 'Aluminium Oxide' -> 'Al', etc. Worse, **three different iron
measurements all collapse to the same symbol 'Fe'**: 'Iron Oxide' (Fe2O3), 'Iron(II) Oxide
(Wüstite)' (FeO), and 'Total Iron as Fe2O3' (the pre-reconciled total) all resolve to
analyte_symbol='Fe' — querying by symbol alone would silently average three chemically different
quantities together. Fixed by querying/pivoting on `analyte_name` (which IS oxide-specific)
instead of `analyte_symbol`, and reconciling the three iron variants by name explicitly.

DELIBERATELY NOT DRAWN: a specific numeric "least-altered box" rectangle. In the original Large et
al. (1998) methodology that box is empirically fitted per-suite around a dataset's own
least-altered/precursor samples — it is not a fixed universal coordinate range in the literature,
so drawing one here would misrepresent a suite-specific empirical result as a general calibration.
What IS a fixed, literature-standard feature of the diagram (and is drawn here) is the geometry of
the four alteration-vector arrows radiating from the "least altered volcanics" field (~AI 40-50,
CCPI 40-50): chlorite (up), sericite (right), carbonate-ankerite (down), albite-K-feldspar (left) —
per Large et al. (1998) Figure 3.

Designed to run as a cell in an E2B code-interpreter sandbox (via runCode), same pattern as the
other plot scripts in this registry. Also runnable directly for local testing, including a
--synthetic-test mode that needs no DB connection (used to validate the calculation and plot
geometry before any real oxide data exists — see bottom of file).
"""
import os
import warnings

warnings.filterwarnings("ignore")

import json

import numpy as np
import pandas as pd
import psycopg2
import matplotlib.pyplot as plt
from pyrolite.geochem.alteration import CCPI, IshikawaAltIndex
from pyrolite.geochem.transform import oxide_conversion

REQUIRED_KEYS = ["PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD"]

# Keyed by analyte_name (the only unambiguous column — see module docstring), mapped to the short
# oxide code pyrolite's CCPI/IshikawaAltIndex expect as DataFrame columns.
OXIDE_NAME_TO_CODE = {
    "Silicon Dioxide": "SiO2",
    "Aluminium Oxide": "Al2O3",
    "Calcium Oxide": "CaO",
    "Sodium Oxide": "Na2O",
    "Potassium Oxide": "K2O",
    "Magnesium Oxide": "MgO",
}
NEEDED_OXIDES = list(OXIDE_NAME_TO_CODE.values())
IRON_NAME_TO_CODE = {
    "Total Iron as Fe2O3": "Fe2O3T",
    "Iron(II) Oxide (Wüstite)": "FeO",
    "Iron Oxide": "Fe2O3",
}
EXPECTED_UNIT = "%"

FE2O3_TO_FEO_FACTOR = oxide_conversion("Fe2O3", "FeO")(1.0)


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
        SELECT DISTINCT ON (r.sample_id, r.analyte_name)
               r.sample_id, r.analyte_name, r.value, r.unit_code
        FROM geochem.analytical_results r
        JOIN geochem.analytes a ON a.analyte_id = r.analyte_id
        LEFT JOIN geochem.package_wide_rules w ON w.package_id = r.package_id
        LEFT JOIN geochem.result_classifications k ON k.result_id = r.result_id AND k.source_system = r.source_system
        WHERE r.sample_id = ANY(%s) AND r.analyte_name = ANY(%s)
          AND r.is_active AND r.value IS NOT NULL AND coalesce(k.use_in_statistics, true)
        ORDER BY r.sample_id, r.analyte_name, (w.basis = 'T') DESC NULLS LAST, w.priority NULLS LAST, r.result_id
    """
    names = list(OXIDE_NAME_TO_CODE.keys()) + list(IRON_NAME_TO_CODE.keys())
    df = pd.read_sql(query, conn, params=(sample_ids, names))
    conn.close()
    return df


def to_wide(long_df):
    if long_df.empty:
        return pd.DataFrame()
    df = long_df.copy()
    bad = df.loc[df["unit_code"] != EXPECTED_UNIT, "unit_code"].unique()
    if len(bad):
        raise ValueError(f"Unexpected non-{EXPECTED_UNIT} units in oxide data: {list(bad)}")
    code_map = {**OXIDE_NAME_TO_CODE, **IRON_NAME_TO_CODE}
    df["code"] = df["analyte_name"].map(code_map)
    return df.pivot_table(index="sample_id", columns="code", values="value", aggfunc="mean")


def reconcile_total_iron(wide):
    """
    Returns a Series of total iron expressed as FeO-equivalent wt%, falling back PER ROW (not
    per-column) across whichever of Fe2O3T / (FeO and/or Fe2O3) a given sample actually reported
    — real Greenland samples are inconsistent about which iron measurement they carry, so picking
    one column for the whole table (an earlier version of this function did exactly that) silently
    produces NaN for every row that happens to use a different column than the first one checked,
    even when that row has perfectly good iron data under a different name. Priority per row:
    the lab's own pre-reconciled Fe2O3T first (most authoritative), else FeO+Fe2O3 summed when a
    row has at least one of them, else whichever single one that row has.
    """
    candidates = []
    if "Fe2O3T" in wide.columns:
        candidates.append(wide["Fe2O3T"] * FE2O3_TO_FEO_FACTOR)
    if "FeO" in wide.columns and "Fe2O3" in wide.columns:
        has_either = wide["FeO"].notna() | wide["Fe2O3"].notna()
        combined = (wide["FeO"].fillna(0) + wide["Fe2O3"].fillna(0) * FE2O3_TO_FEO_FACTOR).where(has_either)
        candidates.append(combined)
    if "FeO" in wide.columns:
        candidates.append(wide["FeO"])
    if "Fe2O3" in wide.columns:
        candidates.append(wide["Fe2O3"] * FE2O3_TO_FEO_FACTOR)
    if not candidates:
        raise ValueError(f"No usable iron oxide column found (checked {list(IRON_NAME_TO_CODE.values())}).")

    result = candidates[0]
    for candidate in candidates[1:]:
        result = result.fillna(candidate)
    return result


def compute_indices(wide):
    missing = [ox for ox in NEEDED_OXIDES if ox not in wide.columns]
    if missing:
        raise ValueError(f"Missing required oxides: {missing}")
    feo_total = reconcile_total_iron(wide)
    calc_df = wide[NEEDED_OXIDES].copy()
    calc_df["FeO"] = feo_total
    ai = IshikawaAltIndex(calc_df)
    ccpi = CCPI(calc_df)
    return pd.DataFrame({"AI": ai, "CCPI": ccpi}, index=wide.index)


def draw_alteration_box(ax=None):
    """
    Large et al. (1998) alteration box plot axes + the four literature-standard alteration
    vectors radiating from the least-altered-volcanics field. Deliberately does NOT draw a
    specific "least-altered box" polygon — see module docstring.
    """
    if ax is None:
        fig, ax = plt.subplots(figsize=(6.5, 6.5))
    ax.set_xlim(0, 100)
    ax.set_ylim(0, 100)
    ax.set_xlabel("Alteration Index (Ishikawa) = 100(K2O+MgO)/(K2O+MgO+Na2O+CaO)")
    ax.set_ylabel("CCPI = 100(MgO+FeOT)/(MgO+FeOT+Na2O+K2O)")
    ax.set_title("Alteration Box Plot (Large et al. 1998)")

    origin = np.array([45, 45])
    vectors = {
        "Chlorite": (np.array([0, 40]), "up"),
        "Sericite": (np.array([40, 0]), "right"),
        "Carbonate-Ankerite": (np.array([0, -30]), "down"),
        "Albite-K-feldspar": (np.array([-30, 0]), "left"),
    }
    for label, (delta, _direction) in vectors.items():
        end = origin + delta
        ax.annotate(
            "", xy=end, xytext=origin,
            arrowprops=dict(arrowstyle="->", color="gray", lw=1.5),
        )
        text_pos = origin + delta * 1.15
        ax.text(*text_pos, label, fontsize=8, color="dimgray", ha="center", va="center")

    ax.scatter(*origin, marker="s", color="gray", s=20, zorder=3)
    ax.text(origin[0], origin[1] - 6, "least altered\nvolcanics (typical)", fontsize=7,
            color="gray", ha="center", va="top")
    return ax


def generate_alteration_box_plot(sample_ids, label=None, save_path=None):
    env = load_env()
    long_df = fetch_data(sample_ids, env)
    wide = to_wide(long_df)
    if wide.empty:
        raise ValueError("No oxide data for these samples.")
    indices = compute_indices(wide).dropna()
    if indices.empty:
        raise ValueError("None of the given samples have all required oxides together.")

    title = label or f"{len(sample_ids)} samples"
    ax = draw_alteration_box()
    ax.scatter(indices["AI"], indices["CCPI"], color="crimson", edgecolor="k", s=35, zorder=5,
               label=title)
    ax.legend(loc="upper right", fontsize=8)
    fig = ax.get_figure()
    fig.tight_layout()

    summary = {
        "label": label,
        "n_samples": int(indices.shape[0]),
        "samples": [
            {"sample_id": int(sid), "AI": round(float(row.AI), 1), "CCPI": round(float(row.CCPI), 1)}
            for sid, row in indices.iterrows()
        ],
    }
    print(json.dumps(summary, indent=2))

    if save_path:
        fig.savefig(save_path, dpi=150)
        plt.close(fig)
    else:
        plt.show()


def _synthetic_test(save_path):
    """
    No-DB validation of the calculation + plot geometry using fabricated oxide compositions
    loosely modeled on typical VHMS alteration ranges (fresh dacite -> chlorite-altered ->
    sericite-altered), used only to prove the code runs correctly before any real oxide data
    exists. These are illustrative made-up numbers, not a real analyzed sample or a literature
    dataset.
    """
    synthetic = pd.DataFrame(
        {
            "SiO2": [68.0, 55.0, 62.0],
            "Al2O3": [15.0, 16.0, 18.0],
            "CaO": [3.5, 1.0, 0.3],
            "Na2O": [4.0, 0.5, 0.2],
            "K2O": [2.5, 1.5, 6.0],
            "MgO": [1.5, 9.0, 1.0],
            "FeOT": [3.0, 12.0, 4.0],
        },
        index=["fresh_dacite", "chlorite_altered", "sericite_altered"],
    )
    indices = compute_indices(synthetic)
    print(indices.to_string())

    ax = draw_alteration_box()
    colors = {"fresh_dacite": "seagreen", "chlorite_altered": "steelblue", "sericite_altered": "darkorange"}
    for name, row in indices.iterrows():
        ax.scatter(row["AI"], row["CCPI"], color=colors[name], edgecolor="k", s=60, zorder=5, label=name)
    ax.legend(loc="upper left", fontsize=8)
    fig = ax.get_figure()
    fig.tight_layout()
    if save_path:
        fig.savefig(save_path, dpi=150)
        plt.close(fig)
    else:
        plt.show()


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("sample_ids", type=lambda s: [int(x) for x in s.split(",")], nargs="?", default=None)
    parser.add_argument("--label", default=None)
    parser.add_argument("--save", default=None, help="Local file path to save PNG (for testing outside a sandbox).")
    parser.add_argument("--synthetic-test", action="store_true",
                         help="Run against fabricated oxide data instead of the DB.")
    args = parser.parse_args()
    if args.synthetic_test:
        _synthetic_test(save_path=args.save)
    else:
        if args.sample_ids is None:
            parser.error("sample_ids is required unless --synthetic-test is given.")
        generate_alteration_box_plot(args.sample_ids, label=args.label, save_path=args.save)
