"""
TAS (Total Alkali-Silica) igneous rock classification diagram for an arbitrary set of sample_ids
— one occurrence, many occurrences, or a whole discovered region.

Classifies whole-rock major-oxide analyses into standard igneous rock names (basalt, andesite,
rhyolite, trachyte, etc. — volcanic names; granite, diorite, syenite, etc. — plutonic
equivalents) using pyrolite's built-in polygon classifier (pyrolite.util.classification.TAS),
implementing Middlemost (1994) / Le Bas et al. (1992). Needs only SiO2, Na2O, K2O — the smallest
oxide subset of any script in this registry, so it has noticeably broader sample coverage than
alteration_box_plot (which needs 6 oxides + an iron measure).

OXIDE DATA EXIST FOR GREENLAND, FINLAND, SWEDEN AND THE USGS DATA (checked 2026-10-20) — Argentina (SEGEMAR) and Victoria (GSV) have zero oxide
analytes, same constraint as alteration_box_plot. Unlike alteration_box_plot, most samples with
TAS-sufficient oxide data are NOT linked to a specific occurrence_id (only ~146 of ~12,280 are) —
this is regional whole-rock geochemistry, not deposit-targeted sampling, so this script is
usually used on a sample_ids set resolved by region/sample-type filters rather than by occurrence.

IMPORTANT CAVEAT, worth surfacing to the user: TAS assumes relatively fresh, unaltered igneous
rock. Na2O and K2O (the alkalis on the y-axis) are exactly the elements most mobile during
hydrothermal alteration — the same process alteration_box_plot is built to detect. A sample that
alteration_box_plot flags as strongly altered should have its TAS classification treated as
unreliable (the alkali ratio may reflect alteration fluid chemistry, not original magma
composition), not as a confident rock name. Run alteration_box_plot alongside this on the same
samples when alteration is a live question.

Same analyte_name-keyed fetch pattern as alteration_box_plot.py, for the same reason: oxide rows
in this database are only unambiguous by analyte_name, not analyte_symbol (SiO2/Na2O/K2O all
collapse to bare element symbols Si/Na/K, which would silently collide with any elemental Si/Na/K
assay present on the same sample).

Designed to run as a cell in an E2B code-interpreter sandbox (via runCode). Also runnable directly
for local testing.
"""
import os
import warnings

warnings.filterwarnings("ignore")

import json

import pandas as pd
import psycopg2
import matplotlib
import matplotlib.pyplot as plt
from pyrolite.util.classification import TAS

REQUIRED_KEYS = ["PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD"]
OXIDE_NAME_TO_CODE = {
    "Silicon Dioxide": "SiO2",
    "Sodium Oxide": "Na2O",
    "Potassium Oxide": "K2O",
}
NEEDED_OXIDES = list(OXIDE_NAME_TO_CODE.values())
EXPECTED_UNIT = "%"


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
    df = pd.read_sql(query, conn, params=(sample_ids, list(OXIDE_NAME_TO_CODE.keys())))
    conn.close()
    return df


def to_wide(long_df):
    if long_df.empty:
        return pd.DataFrame()
    df = long_df.copy()
    bad = df.loc[df["unit_code"] != EXPECTED_UNIT, "unit_code"].unique()
    if len(bad):
        raise ValueError(f"Unexpected non-{EXPECTED_UNIT} units in oxide data: {list(bad)}")
    df["code"] = df["analyte_name"].map(OXIDE_NAME_TO_CODE)
    return df.pivot_table(index="sample_id", columns="code", values="value", aggfunc="mean")


def field_label(cls, field_id):
    if field_id == "none":
        return "Unclassified (outside standard TAS fields)"
    names = cls.fields.get(field_id, {}).get("name")
    if isinstance(names, list):
        return " / ".join(n.replace("\n", " ").strip() for n in names)
    return str(names)


def generate_tas_plot(sample_ids, label=None, save_path=None):
    env = load_env()
    long_df = fetch_data(sample_ids, env)
    wide = to_wide(long_df)
    missing = [ox for ox in NEEDED_OXIDES if ox not in wide.columns]
    if missing:
        raise ValueError(
            f"These samples are missing {missing} — TAS classification needs SiO2+Na2O+K2O "
            "together, and only Greenland samples have oxide data in this database at all "
            "(Argentina and Victoria have none; Greenland, Finland, Sweden and the USGS data do). Check coverage with run_sql before retrying."
        )
    wide = wide.dropna(subset=NEEDED_OXIDES)
    if wide.empty:
        raise ValueError("None of the given samples have SiO2, Na2O, and K2O together.")
    wide["Na2O + K2O"] = wide["Na2O"] + wide["K2O"]

    cls = TAS()
    predicted_ids = cls.predict(wide[["SiO2", "Na2O + K2O"]], data_scale=100)
    rock_names = predicted_ids.map(lambda fid: field_label(cls, fid))

    title = label or f"{len(sample_ids)} samples"
    fig, ax = plt.subplots(figsize=(8, 6.5))
    cls.add_to_axes(ax, fill=True, alpha=0.12, add_labels=True, which_labels="ID", fontsize=7)

    distinct_classes = rock_names.value_counts()
    palette = matplotlib.colormaps["tab20"].resampled(max(len(distinct_classes), 1))
    for i, (name, count) in enumerate(distinct_classes.items()):
        mask = rock_names == name
        color = "lightgray" if name.startswith("Unclassified") else palette(i)
        ax.scatter(
            wide.loc[mask, "SiO2"], wide.loc[mask, "Na2O + K2O"],
            color=color, edgecolor="k", s=45, zorder=5, label=f"{name} (n={count})",
        )
    ax.legend(loc="upper left", fontsize=6.5, bbox_to_anchor=(1.01, 1), borderaxespad=0)
    # The standard TAS field geometry only spans SiO2 30-90 / alkalis 0-20 — real samples
    # (e.g. carbonate/sulfide-rich or heavily weathered material, not true fresh igneous rock)
    # can fall well outside that, and would otherwise be silently clipped out of the visible
    # frame despite being counted in the legend. Widen the axes to the data's actual extent.
    x_lo, x_hi = ax.get_xlim()
    y_lo, y_hi = ax.get_ylim()
    ax.set_xlim(min(x_lo, wide["SiO2"].min() - 2), max(x_hi, wide["SiO2"].max() + 2))
    ax.set_ylim(min(y_lo, wide["Na2O + K2O"].min() - 1), max(y_hi, wide["Na2O + K2O"].max() + 1))
    ax.set_xlabel("SiO2 (wt%)")
    ax.set_ylabel("Na2O + K2O (wt%)")
    ax.set_title(f"{title} — TAS classification (n={wide.shape[0]} samples)")
    fig.tight_layout()

    summary = {
        "label": label,
        "n_samples_requested": len(sample_ids),
        "n_samples_classified": int(wide.shape[0]),
        "class_counts": {str(k): int(v) for k, v in distinct_classes.items()},
        "samples": [
            {
                "sample_id": int(sid),
                "SiO2": round(float(row["SiO2"]), 2),
                "Na2O_plus_K2O": round(float(row["Na2O + K2O"]), 2),
                "rock_type": rock_names.loc[sid],
            }
            for sid, row in wide.iterrows()
        ],
        "interpretation_notes": (
            "TAS classifies on SiO2 vs total alkalis (Na2O+K2O) alone — it assumes relatively "
            "unaltered igneous rock. Na2O and K2O are both mobile during hydrothermal alteration, "
            "so any sample also flagged as altered (e.g. via alteration_box_plot's Ishikawa AI/"
            "CCPI on the same sample_ids) should have its TAS name treated as indicative, not "
            "definitive — alteration can shift a sample's apparent position on this diagram "
            "away from its true protolith composition. 'Unclassified' samples fall outside all "
            "standard TAS fields entirely (e.g. very low total-alkali, low-silica compositions), "
            "which itself can be a meaningful signal rather than a data problem."
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
    parser.add_argument("--label", default=None)
    parser.add_argument("--save", default=None, help="Local file path to save PNG (for testing outside a sandbox).")
    args = parser.parse_args()
    generate_tas_plot(args.sample_ids, label=args.label, save_path=args.save)
