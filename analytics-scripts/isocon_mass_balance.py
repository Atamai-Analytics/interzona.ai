"""
Grant (1986, 2005) ISOCON mass balance: which elements an ALTERED rock gained or lost relative to its least-altered equivalent.

Inputs: sample_ids = the altered samples; reference_sample_ids = least-altered (precursor) samples of the SAME rock type (comma-separated
string or list). The script takes the MEDIAN composition of each group (total-basis analyses only), then fits the isocon through the
origin using elements assumed immobile (default Al2O3, TiO2, Zr; option immobile="Al2O3,TiO2,Zr,Nb"): slope = median of
C_altered / C_reference over the immobile elements. Then for every element:
    mass change of the rock          = (1 / slope - 1) * 100 %
    concentration change of element  = (1 / slope) * (C_altered / C_reference) - 1     (fractional gain > 0, loss < 0)
    absolute change                  = that fraction * C_reference (wt % for oxides, ppm for trace elements)
The spread of the immobile elements' ratios is reported: if they disagree by more than about 15 %, the "immobile" set is not immobile
for this rock pair (or the groups are not the same protolith) and the result should not be trusted.

Figure: C_altered against C_reference on log-log axes (Grant's isocon plot) with the isocon, the 1:1 line, the immobile elements marked
and the 8 largest gains and losses labelled.

Rules: same protolith only (compare like with like: check lithology); medians, not means, so single outliers do not drive it;
elements need a value in at least half of each group. Not a substitute for a proper alteration study with density data
(Gresens' approach); results are relative mass changes.
Local test: python isocon_mass_balance.py --ids 1,2,3 --ref 4,5,6 --save out.png
"""
import json
import os
import warnings

warnings.filterwarnings("ignore")

import numpy as np
import pandas as pd
import psycopg2
import matplotlib.pyplot as plt

REQUIRED_KEYS = ["PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD"]
OXIDES = ["SiO2", "TiO2", "Al2O3", "FeTO3", "Fe2O3", "FeO", "MnO", "MgO", "CaO", "Na2O", "K2O", "P2O5"]
TRACES = ["Ba", "Rb", "Sr", "Cs", "Li", "Zr", "Hf", "Nb", "Ta", "Y", "Th", "U", "La", "Ce", "Nd", "Sm", "Eu", "Gd", "Yb", "Lu",
          "Sc", "V", "Cr", "Co", "Ni", "Cu", "Zn", "Pb", "Ag", "As", "Sb", "Bi", "Mo", "W", "Sn", "Au", "S", "Ga"]


def load_env():
    if all(k in os.environ for k in REQUIRED_KEYS):
        return {k: os.environ[k] for k in REQUIRED_KEYS}
    env = {}
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env.local"), encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1); env[k.strip()] = v.strip()
    return env


def _ids(x):
    if x is None:
        return None
    if isinstance(x, str):
        return [int(s) for s in x.replace(";", ",").split(",") if s.strip()]
    return [int(s) for s in x]


def fetch(ids):
    env = load_env()
    cols = {f"{c.lower()}_t": c for c in OXIDES + TRACES}
    conn = psycopg2.connect(host=env["PGHOST"], port=env["PGPORT"], dbname=env["PGDATABASE"], user=env["PGUSER"], password=env["PGPASSWORD"])
    df = pd.read_sql(f"SELECT sample_id, lithology_name, lithology_category, {', '.join(cols)} FROM geochem.sample_chemistry_wide "
                     "WHERE sample_id = ANY(%s)", conn, params=(ids,))
    conn.close()
    df = df.rename(columns=cols).set_index("sample_id")
    for c in cols.values():
        df[c] = pd.to_numeric(df[c], errors="coerce")
        df.loc[df[c] <= 0, c] = np.nan
    # one total-iron column (as Fe2O3): analysed Fe2O3 + FeO*1.1113 where both, else the total-iron value
    both = df["Fe2O3"].notna() & df["FeO"].notna()
    fet = pd.Series(np.nan, index=df.index)
    fet[both] = df.loc[both, "Fe2O3"] + df.loc[both, "FeO"] * 1.1113
    df["Fe2O3T"] = fet.combine_first(df["FeTO3"]).combine_first(df["Fe2O3"]).combine_first(df["FeO"] * 1.1113)
    return df.drop(columns=["FeTO3", "Fe2O3", "FeO"])


def _median_composition(g):
    ok = g.notna().mean() >= 0.5
    return g.loc[:, ok].median()


def generate_isocon(sample_ids=None, reference_sample_ids=None, label=None, immobile="Al2O3,TiO2,Zr", save_path=None):
    alt_ids, ref_ids = _ids(sample_ids), _ids(reference_sample_ids)
    if not alt_ids or not ref_ids:
        raise ValueError("isocon_mass_balance needs sample_ids (altered samples) AND reference_sample_ids (least-altered samples of the same rock).")
    overlap = set(alt_ids) & set(ref_ids)
    if overlap:
        raise ValueError(f"{len(overlap)} sample_ids are in both groups; the altered and reference groups must be different samples.")
    df = fetch(alt_ids + ref_ids)
    alt, ref = df.loc[df.index.isin(alt_ids)], df.loc[df.index.isin(ref_ids)]
    if alt.empty or ref.empty:
        raise ValueError(f"Found {len(alt)} altered and {len(ref)} reference samples in the chemistry table; both groups need samples.")
    num = [c for c in df.columns if c not in ("lithology_name", "lithology_category")]
    ca, co = _median_composition(alt[num]), _median_composition(ref[num])
    common = [e for e in ca.index if e in co.index and ca[e] > 0 and co[e] > 0]
    imm = [e.strip() for e in immobile.split(",") if e.strip()]
    imm_ok = [e for e in imm if e in common]
    if len(imm_ok) < 2:
        raise ValueError(f"Need at least two immobile elements with data in both groups; have {imm_ok} (asked {imm}). "
                         "Try immobile='Al2O3,TiO2,Zr,Nb,Y' or check coverage.")
    ratios = pd.Series({e: ca[e] / co[e] for e in imm_ok})
    slope = float(ratios.median())
    spread = float((ratios.max() - ratios.min()) / slope)
    rows = []
    for e in common:
        frac = (1.0 / slope) * (ca[e] / co[e]) - 1.0
        unit = "wt %" if e in ("SiO2", "TiO2", "Al2O3", "Fe2O3T", "MnO", "MgO", "CaO", "Na2O", "K2O", "P2O5") else "ppm"
        rows.append({"element": e, "unit": unit, "reference_median": round(float(co[e]), 4), "altered_median": round(float(ca[e]), 4),
                     "change_pct": round(100 * frac, 1), "absolute_change": round(float(frac * co[e]), 4), "immobile": e in imm_ok})
    res = pd.DataFrame(rows).sort_values("change_pct")
    mobile = res[~res["immobile"]]

    fig, ax = plt.subplots(figsize=(7.5, 7))
    x, y = res["reference_median"], res["altered_median"]
    ax.scatter(x, y, s=22, color=np.where(res["immobile"], "#1f618d", "#7f8c8d"), zorder=3)
    lo, hi = min(x.min(), y.min()) / 2, max(x.max(), y.max()) * 2
    xx = np.logspace(np.log10(lo), np.log10(hi), 50)
    ax.plot(xx, xx, color="#bbb", ls="--", lw=1, label="1:1 (no change)")
    ax.plot(xx, slope * xx, color="#1f618d", lw=1.5, label=f"isocon (slope {slope:.3f}, mass change {100 * (1 / slope - 1):+.1f} %)")
    lab = pd.concat([mobile.head(8), mobile.tail(8)]).drop_duplicates("element")
    for _, r in pd.concat([lab, res[res["immobile"]]]).iterrows():
        ax.annotate(r["element"], (r["reference_median"], r["altered_median"]), fontsize=8, xytext=(3, 3), textcoords="offset points")
    ax.set_xscale("log"); ax.set_yscale("log")
    ax.set_xlabel(f"least-altered reference, median of {len(ref)} samples"); ax.set_ylabel(f"altered, median of {len(alt)} samples")
    ax.set_title("Isocon diagram (Grant 1986)" + (f" | {label}" if label else "")); ax.legend(fontsize=8, loc="upper left")
    fig.tight_layout()

    summary = {
        "label": label, "n_altered": int(len(alt)), "n_reference": int(len(ref)),
        "lithologies": {"altered": {k: int(v) for k, v in alt["lithology_name"].fillna("?").value_counts().head(5).items()},
                        "reference": {k: int(v) for k, v in ref["lithology_name"].fillna("?").value_counts().head(5).items()}},
        "immobile_elements": imm_ok, "immobile_ratios_altered_over_reference": {k: round(float(v), 3) for k, v in ratios.items()},
        "isocon_slope": round(slope, 4), "rock_mass_change_pct": round(100 * (1 / slope - 1), 1),
        "immobile_spread_pct": round(100 * spread, 1),
        "reliability": ("OK: immobile elements agree within 15 %" if spread <= 0.15 else
                        "WARNING: the chosen immobile elements disagree by more than 15 % - they were mobile, or the two groups are not the same protolith; do not trust the gains and losses"),
        "largest_gains": json.loads(mobile.sort_values("change_pct", ascending=False).head(10).to_json(orient="records")),
        "largest_losses": json.loads(mobile.head(10).to_json(orient="records")),
        "all_elements": json.loads(res.to_json(orient="records")),
        "notes": ["Medians of each group, total-basis analyses only; elements need values in at least half of each group.",
                  "Relative mass balance (Grant isocon), no density data used.",
                  "Only meaningful when both groups are the same protolith (check the lithologies above)."],
    }
    print(json.dumps(summary, indent=2))
    if save_path:
        fig.savefig(save_path, dpi=130); plt.close(fig)
    else:
        plt.show()


if __name__ == "__main__":
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument("--ids", required=True); p.add_argument("--ref", required=True)
    p.add_argument("--immobile", default="Al2O3,TiO2,Zr"); p.add_argument("--label", default=None); p.add_argument("--save", default=None)
    a = p.parse_args()
    if a.save:
        plt.switch_backend("Agg")
    generate_isocon(sample_ids=a.ids, reference_sample_ids=a.ref, label=a.label, immobile=a.immobile, save_path=a.save)
