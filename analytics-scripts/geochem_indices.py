"""
Whole-rock GEOCHEMISTRY calculations and the standard charts that go with them, for a set of samples from
geochem.sample_chemistry_wide. One method per call (parameter `method`); each prints a JSON summary (per-method statistics plus
up to 200 per-sample rows) and draws one figure.

METHODS
  niggli                 Niggli numbers (si, al, fm, c, alk, k, mg, ti, p, qz) from molar oxide proportions; figure: al, fm, c, alk
                         against si (the classic Niggli variation diagram), with qz (silica saturation) summarised.
  cipw_norm              CIPW norm (Verma et al. 2003 revision, via pyrolite.mineral.normative.CIPW_norm; iron split with the
                         Le Maitre (1976) correction where only total iron is reported). Reported per sample as the grouped normative
                         minerals (quartz, corundum, orthoclase, albite, anorthite, nepheline, leucite, diopside, hypersthene, olivine,
                         magnetite, hematite, ilmenite, titanite, apatite...), never their end-member parts as well, so totals do not
                         double count. Saturation class: quartz-normative / hypersthene+olivine (critically undersaturated) /
                         nepheline-normative. Figure: normative Q-Ab-Or ternary (granite system) and the median norm.
  weathering             Chemical weathering / alteration indices from molar proportions, with the McLennan (1993) CaO* correction
                         (CaO in silicates only: CaO - 10/3 P2O5, and capped at Na2O when that is lower):
                         CIA (Nesbitt & Young 1982), CIW (Harnois 1988), PIA (Fedo et al. 1995), WIP (Parker 1970).
                         Figure: A-CN-K ternary (molar Al2O3, CaO*+Na2O, K2O) with the CIA scale and reference minerals.
                         Use for regolith, laterite, saprolite and clay-hosted REE / lithium questions; on fresh crystalline rock CIA
                         mostly reflects feldspar content and hydrothermal alteration, not weathering.
  porphyry_fertility     Arc-magma "fertility" ratios used in porphyry Cu exploration: Sr/Y, V/Sc, chondrite-normalised Eu/Eu*
                         (Eu_N / sqrt(Sm_N * Gd_N), McDonough & Sun 1995 chondrite) and La/Yb. Reports the share of samples above two
                         widely used indicative cut-offs: Sr/Y >= 40 (adakite-like, Defant & Drummond 1990) and V/Sc >= 10 (Loucks 2014).
                         Figure: Sr/Y against Eu/Eu*, and V/Sc against SiO2. These are screening ratios for intermediate-felsic
                         intrusive rocks, not proof of fertility; the published "fertile" fields are NOT drawn.
  pegmatite_fractionation  Granite / pegmatite fractionation ratios used for LCT (Li-Cs-Ta) pegmatite and rare-metal granite targeting:
                         K/Rb, Rb/Sr, Nb/Ta, Zr/Hf, plus Li and Cs levels. Reports the share of samples past widely used indicative
                         levels: K/Rb < 150 (evolved) and < 30 (highly fractionated, Cerny et al. 1985), Nb/Ta < 5 and Zr/Hf < 25
                         (strongly fractionated; chondritic about 17.5 and 36). Figure: K/Rb against Rb (log-log) and Nb/Ta against Zr/Hf.
  harker                 Harker variation diagrams: TiO2, Al2O3, FeOT, MgO, CaO, Na2O, K2O and P2O5 against SiO2, coloured by
                         logged lithology, with Spearman correlations.
  jensen                 Jensen (1976) cation plot (Al - Fe+Ti - Mg) separating tholeiitic, calc-alkaline and komatiitic series, using
                         pyrolite's published template; counts by field.

DATA RULES. TOTAL-basis values only (the *_t columns: oxides wt %, elements ppm); partial digestions are never used. Zero, negative
and below-detection values are dropped. Iron: Fe2O3 + FeO where both are reported, otherwise total iron (FeTO3 / Fe2O3 / FeO).
Elements reported only as oxides (or only as elements) are converted. Major-oxide methods need the main oxides on the same sample;
samples missing one are dropped and counted. On regional surveys rock types are mixed: read results by lithology.

SAMPLE SELECTION: sample_ids, or source_system (+ lithology_category, bounding box), as for halley_plots; selecting by dataset uses
rock and drill samples only. Selections over max_samples are thinned deterministically.

Runs in the E2B sandbox like the other scripts (entry point prints JSON, then plt.show()). Local test:
    python geochem_indices.py --source FINLAND_GTK_ROCK --method niggli --save out.png
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
METHODS = ["niggli", "cipw_norm", "weathering", "porphyry_fertility", "pegmatite_fractionation", "harker", "jensen"]

OXIDES = ["SiO2", "TiO2", "Al2O3", "Fe2O3", "FeO", "FeTO3", "MnO", "MgO", "CaO", "Na2O", "K2O", "P2O5"]
TRACES = ["Sr", "Y", "V", "Sc", "Eu", "Sm", "Gd", "La", "Yb", "Rb", "Nb", "Ta", "Zr", "Hf", "Li", "Cs", "Ba"]
ELEMENT_FALLBACK = {"K": "K2O", "Ti": "TiO2", "Mn": "MnO", "P": "P2O5", "Na": "Na2O", "Ca": "CaO", "Mg": "MgO", "Al": "Al2O3", "Si": "SiO2"}
COLUMNS = {f"{o.lower()}_t": o for o in OXIDES} | {f"{t.lower()}_t": t for t in TRACES} | {f"{e.lower()}_t": f"{e}_el" for e in ELEMENT_FALLBACK}

MW = {"SiO2": 60.084, "TiO2": 79.866, "Al2O3": 101.961, "Fe2O3": 159.688, "FeO": 71.844, "MnO": 70.937, "MgO": 40.304,
      "CaO": 56.077, "Na2O": 61.979, "K2O": 94.196, "P2O5": 141.943}
# element mass fraction in the oxide (element ppm -> oxide wt %: ppm / 1e4 / fraction)
EL_FRACTION = {"SiO2": 0.4674, "TiO2": 0.5995, "Al2O3": 0.5293, "MnO": 0.7745, "MgO": 0.6030, "CaO": 0.7147, "Na2O": 0.7419,
               "K2O": 0.8301, "P2O5": 0.4364}
FE2O3_TO_FEO = 0.8998
CHONDRITE = {"Sm": 0.148, "Eu": 0.0563, "Gd": 0.199}  # McDonough & Sun (1995) CI chondrite, ppm
NEEDS = {
    "niggli": ["SiO2", "Al2O3", "FeOT", "MgO", "CaO", "Na2O", "K2O"],
    "cipw_norm": ["SiO2", "Al2O3", "FeOT", "MgO", "CaO", "Na2O", "K2O"],
    "weathering": ["Al2O3", "CaO", "Na2O", "K2O"],
    "porphyry_fertility": ["Sr", "Y"],
    "pegmatite_fractionation": ["K", "Rb"],
    "harker": ["SiO2"],
    "jensen": ["Al2O3", "FeOT", "MgO"],
}
LITHO_COLOURS = {
    "IGNEOUS_INTRUSIVE": "#c0392b", "IGNEOUS_EXTRUSIVE": "#e67e22", "METAMORPHIC_FOLIATED": "#2874a6",
    "METAMORPHIC_NON_FOLIATED": "#17a589", "SEDIMENTARY_CLASTIC": "#b7950b", "SEDIMENTARY_CHEMICAL": "#7d6608",
    "ALTERATION": "#8e44ad", "ORE_VEIN": "#000000", "OTHER": "#7f8c8d",
}


def load_env():
    if all(k in os.environ for k in REQUIRED_KEYS):
        return {k: os.environ[k] for k in REQUIRED_KEYS}
    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env.local")
    env = {}
    with open(env_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    return env


def fetch(sample_ids, source_system, lithology_category, bbox, max_samples):
    where, params = ["1=1"], []
    if sample_ids is not None:
        where.append("sample_id = ANY(%s)"); params.append([int(s) for s in sample_ids])
    if source_system:
        where.append("source_system = %s"); params.append(source_system)
    if lithology_category:
        where.append("lithology_category = %s"); params.append(lithology_category)
    if bbox and all(v is not None for v in bbox):
        where.append("lon BETWEEN %s AND %s AND lat BETWEEN %s AND %s")
        params += [bbox[0], bbox[2], bbox[1], bbox[3]]
    if len(where) == 1:
        raise ValueError("Give sample_ids, a source_system, or a bounding box: this script will not run on the whole table.")
    if sample_ids is None:
        where.append("sample_type_name ~* '(rock|outcrop|core|float|grab|channel|composite|drill)' "
                     "AND sample_type_name !~* '(sediment|soil|till|concentrate|tailings)'")
    env = load_env()
    conn = psycopg2.connect(host=env["PGHOST"], port=env["PGPORT"], dbname=env["PGDATABASE"], user=env["PGUSER"], password=env["PGPASSWORD"])
    cur = conn.cursor()
    cur.execute(f"SELECT count(*) FROM geochem.sample_chemistry_wide WHERE {' AND '.join(where)}", params)
    n_matched = int(cur.fetchone()[0])
    if n_matched == 0:
        conn.close()
        raise ValueError("No samples matched the selection.")
    order = "ORDER BY md5(sample_id::text) LIMIT %s" if n_matched > max_samples else ""
    sql = (f"SELECT sample_id, source_system, lithology_category, lithology_name, {', '.join(COLUMNS)} "
           f"FROM geochem.sample_chemistry_wide WHERE {' AND '.join(where)} {order}")
    df = pd.read_sql(sql, conn, params=params + ([max_samples] if order else []))
    conn.close()
    df = df.rename(columns=COLUMNS).set_index("sample_id")
    for c in COLUMNS.values():
        df[c] = pd.to_numeric(df[c], errors="coerce")
        df.loc[df[c] <= 0, c] = np.nan
    # oxide from element where only the element was reported (ppm -> wt % oxide); K element from K2O where missing
    for el, ox in ELEMENT_FALLBACK.items():
        df[ox] = df[ox].combine_first(df[f"{el}_el"] / 1e4 / EL_FRACTION[ox])
    df["K"] = df["K_el"].combine_first(df["K2O"] * EL_FRACTION["K2O"] * 1e4)
    # total iron as FeO: Fe2O3+FeO when both, else the total-iron column, else whichever single one exists
    both = df["Fe2O3"].notna() & df["FeO"].notna()
    feot = pd.Series(np.nan, index=df.index)
    feot[both] = df.loc[both, "FeO"] + df.loc[both, "Fe2O3"] * FE2O3_TO_FEO
    feot = feot.combine_first(df["FeTO3"] * FE2O3_TO_FEO).combine_first(df["Fe2O3"] * FE2O3_TO_FEO).combine_first(df["FeO"])
    df["FeOT"] = feot
    df["iron_split"] = both
    df["litho"] = df["lithology_category"].fillna("OTHER")
    return df, {"samples_matched": n_matched, "samples_fetched": int(len(df)), "thinned": n_matched > max_samples}


def _q(s, qs=(0.1, 0.5, 0.9)):
    s = pd.Series(s).replace([np.inf, -np.inf], np.nan).dropna()
    return {f"p{int(q * 100)}": round(float(s.quantile(q)), 3) for q in qs} | {"n": int(len(s))} if len(s) else {"n": 0}


def _molar(df, cols):
    return pd.DataFrame({c: df[c] / MW[c] for c in cols})


def _colour_scatter(ax, df, x, y, logx=False, logy=False, s=9):
    for lit, sub in df.groupby("litho"):
        ax.scatter(sub[x], sub[y], s=s, alpha=0.6, color=LITHO_COLOURS.get(lit, "#7f8c8d"), label=f"{lit.replace('_', ' ').title()} ({len(sub):,})",
                   edgecolors="none")
    if logx: ax.set_xscale("log")
    if logy: ax.set_yscale("log")


def _tern(top, left, right):
    t = top + left + right
    a, b, c = top / t, left / t, right / t
    return 0.5 * a + c, (np.sqrt(3) / 2) * a


def _tern_frame(ax, top, left, right):
    ax.plot([0, 1, 0.5, 0], [0, 0, np.sqrt(3) / 2, 0], color="k", lw=1)
    ax.text(0.5, np.sqrt(3) / 2 + 0.03, top, ha="center", va="bottom")
    ax.text(-0.03, -0.03, left, ha="right", va="top")
    ax.text(1.03, -0.03, right, ha="left", va="top")
    ax.set_xlim(-0.12, 1.12); ax.set_ylim(-0.1, 1.0); ax.set_aspect("equal"); ax.axis("off")


# ---------------------------------------------------------------- methods
def m_niggli(df):
    d = df.dropna(subset=NEEDS["niggli"]).copy()
    for c in ["MnO", "TiO2", "P2O5"]:
        d[c] = d[c].fillna(0.0)
    m = _molar(d, ["SiO2", "TiO2", "Al2O3", "MnO", "MgO", "CaO", "Na2O", "K2O", "P2O5"])
    fe = d["FeOT"] / MW["FeO"]                     # total iron as FeO moles (= 2 Fe2O3 + FeO)
    al, fm, c, alk = m["Al2O3"], fe + m["MnO"] + m["MgO"], m["CaO"], m["Na2O"] + m["K2O"]
    tot = al + fm + c + alk
    out = pd.DataFrame({
        "si": 100 * m["SiO2"] / tot, "al": 100 * al / tot, "fm": 100 * fm / tot, "c": 100 * c / tot, "alk": 100 * alk / tot,
        "k": m["K2O"] / (m["K2O"] + m["Na2O"]), "mg": m["MgO"] / (m["MgO"] + fe + m["MnO"]),
        "ti": 100 * m["TiO2"] / tot, "p": 100 * m["P2O5"] / tot,
    }, index=d.index)
    out["qz"] = out["si"] - (100 + 4 * out["alk"])
    stats = {k: _q(out[k]) for k in ["si", "al", "fm", "c", "alk", "k", "mg", "qz"]}
    stats["share_qz_positive_silica_oversaturated"] = round(float((out["qz"] > 0).mean()), 3)
    fig, ax = plt.subplots(figsize=(8, 5.5))
    for col, colour in [("al", "#2874a6"), ("fm", "#7d3c98"), ("c", "#b7950b"), ("alk", "#c0392b")]:
        ax.scatter(out["si"], out[col], s=8, alpha=0.5, color=colour, label=col, edgecolors="none")
    ax.set_xlabel("Niggli si"); ax.set_ylabel("Niggli al, fm, c, alk (sum = 100)")
    ax.set_title("Niggli variation diagram"); ax.legend(markerscale=2)
    return fig, stats, out.round(2)


CIPW_GROUPS = ["quartz", "corundum", "zircon", "orthoclase", "albite", "anorthite", "nepheline", "leucite", "kaliophilite", "acmite",
               "diopside", "hypersthene", "olivine", "wollastonite", "magnetite", "hematite", "ilmenite", "titanite", "perovskite",
               "rutile", "apatite", "calcite", "chromite", "pyrite"]


def m_cipw(df):
    from pyrolite.mineral.normative import CIPW_norm
    d = df.dropna(subset=NEEDS["cipw_norm"]).copy()
    inp = pd.DataFrame({c: d[c].fillna(0.0) for c in ["SiO2", "TiO2", "Al2O3", "MnO", "MgO", "CaO", "Na2O", "K2O", "P2O5"]}, index=d.index)
    # analysed Fe2O3 + FeO where both exist; otherwise total iron as FeOT and let pyrolite split it (Le Maitre 1976)
    split = d["iron_split"]
    inp["Fe2O3"] = np.where(split, d["Fe2O3"], np.nan)
    inp["FeO"] = np.where(split, d["FeO"], np.nan)
    inp["FeOT"] = np.where(split, np.nan, d["FeOT"])
    parts = []
    if split.any():
        parts.append(CIPW_norm(inp.loc[split, [c for c in inp.columns if c != "FeOT"]]))
    if (~split).any():
        parts.append(CIPW_norm(inp.loc[~split, [c for c in inp.columns if c not in ("Fe2O3", "FeO")]], Fe_correction="LeMaitre"))
    norm = pd.concat(parts).reindex(d.index)
    keep = [c for c in CIPW_GROUPS if c in norm.columns]
    norm = norm[keep].fillna(0.0)
    sat = np.where(norm.get("quartz", 0) > 0, "quartz-normative (oversaturated)",
                   np.where(norm.get("nepheline", 0) + norm.get("leucite", 0) > 0, "nepheline/leucite-normative (undersaturated)",
                            np.where(norm.get("olivine", 0) > 0, "olivine-normative (critically undersaturated)", "saturated (hypersthene)")))
    norm["saturation_class"] = sat
    stats = {"median_norm_wt_pct": {k: round(float(v), 2) for k, v in norm[keep].median().items() if v > 0},
             "saturation_classes": {k: int(v) for k, v in pd.Series(sat).value_counts().items()},
             "iron": {"analysed_Fe2O3_FeO": int(split.sum()), "total_iron_split_LeMaitre": int((~split).sum())}}
    fig, (a1, a2) = plt.subplots(1, 2, figsize=(11, 5.2))
    q, ab, orr = norm.get("quartz", 0), norm.get("albite", 0), norm.get("orthoclase", 0)
    ok = (q + ab + orr) > 0
    x, y = _tern(q[ok], ab[ok], orr[ok])
    _tern_frame(a1, "Q (normative)", "Ab", "Or")
    a1.scatter(x, y, s=8, alpha=0.5, color="#c0392b", edgecolors="none")
    a1.set_title("Normative Q-Ab-Or (granite system)")
    med = norm[keep].median().sort_values(ascending=True)
    med = med[med > 0.05]
    a2.barh(med.index, med.values, color="#5d6d7e"); a2.set_xlabel("median normative wt %"); a2.set_title("Median CIPW norm")
    return fig, stats, norm.round(2)


def _cao_star(m):
    """McLennan (1993): CaO in silicates = CaO - 10/3 P2O5 (apatite), then capped at Na2O when that is lower."""
    p = m["P2O5"].fillna(0.0)
    cao = (m["CaO"] - (10.0 / 3.0) * p).clip(lower=0)
    return np.minimum(cao, m["Na2O"]).where(cao > m["Na2O"], cao)


def m_weathering(df):
    d = df.dropna(subset=NEEDS["weathering"]).copy()
    m = _molar(d, ["Al2O3", "CaO", "Na2O", "K2O", "MgO", "P2O5"])
    ca = _cao_star(m)
    na, k, al = m["Na2O"], m["K2O"], m["Al2O3"]
    out = pd.DataFrame({
        "CIA": 100 * al / (al + ca + na + k),
        "CIW": 100 * al / (al + ca + na),
        "PIA": 100 * (al - k) / (al + ca + na - k),
    }, index=d.index)
    if d["MgO"].notna().any():  # Parker (1970) WIP on molar element proportions with bond-strength weights
        out["WIP"] = 100 * (2 * na / 0.35 + m["MgO"] / 0.9 + 2 * k / 0.25 + m["CaO"] / 0.7)
    stats = {k2: _q(out[k2]) for k2 in out.columns}
    cia = out["CIA"].dropna()
    stats["CIA_bands_share"] = {"<50 (fresh feldspar-bearing)": round(float((cia < 50).mean()), 3),
                                "50-70 (incipient-moderate)": round(float(((cia >= 50) & (cia < 70)).mean()), 3),
                                "70-85 (intense)": round(float(((cia >= 70) & (cia < 85)).mean()), 3),
                                ">=85 (extreme, kaolinite/gibbsite-rich)": round(float((cia >= 85).mean()), 3)}
    fig, ax = plt.subplots(figsize=(7, 6.5))
    x, y = _tern(al, ca + na, k)
    _tern_frame(ax, "A (Al2O3)", "CN (CaO*+Na2O)", "K (K2O)")
    for lit in d["litho"].unique():
        sel = d["litho"] == lit
        ax.scatter(x[sel], y[sel], s=8, alpha=0.6, color=LITHO_COLOURS.get(lit, "#7f8c8d"), label=lit.replace("_", " ").title(), edgecolors="none")
    for cia_v in (50, 60, 70, 80, 90):  # CIA lines: A/(A+CN+K) = cia -> horizontal lines in this projection
        h = (np.sqrt(3) / 2) * cia_v / 100
        ax.plot([h / np.sqrt(3), 1 - h / np.sqrt(3)], [h, h], color="#bbb", lw=0.6, ls="--")
        ax.text(h / np.sqrt(3) - 0.02, h, str(cia_v), fontsize=7, ha="right", va="center", color="#777")
    refs = {"Plagioclase": (50, 50, 0), "K-feldspar": (50, 0, 50), "Kaolinite / gibbsite / chlorite": (100, 0, 0), "Muscovite / illite": (75, 0, 25)}
    for name, (a_, cn_, k_) in refs.items():
        rx, ry = _tern(np.array([a_]), np.array([cn_]), np.array([k_]))
        ax.scatter(rx, ry, marker="D", s=40, color="k", zorder=5); ax.text(rx[0] + 0.02, ry[0], name, fontsize=8, va="center")
    ax.set_title("A-CN-K diagram with CIA scale (Nesbitt & Young 1984)")
    ax.legend(fontsize=7, loc="lower right", bbox_to_anchor=(1.12, 0.12), markerscale=2, frameon=False)
    return fig, stats, out.round(1)


def m_porphyry(df):
    d = df.copy()
    eu_n = d["Eu"] / CHONDRITE["Eu"]; sm_n = d["Sm"] / CHONDRITE["Sm"]; gd_n = d["Gd"] / CHONDRITE["Gd"]
    out = pd.DataFrame({"Sr_Y": d["Sr"] / d["Y"], "V_Sc": d["V"] / d["Sc"], "Eu_Eu_star": eu_n / np.sqrt(sm_n * gd_n),
                        "La_Yb": d["La"] / d["Yb"], "SiO2": d["SiO2"]}, index=d.index)
    out = out.dropna(subset=["Sr_Y"])
    if out.empty:
        raise ValueError("No selected sample has both Sr and Y (total basis).")
    stats = {k: _q(out[k]) for k in ["Sr_Y", "V_Sc", "Eu_Eu_star", "La_Yb"]}
    stats["share_Sr_Y_at_least_40_adakite_like"] = round(float((out["Sr_Y"] >= 40).mean()), 3)
    vs = out["V_Sc"].dropna()
    stats["share_V_Sc_at_least_10"] = round(float((vs >= 10).mean()), 3) if len(vs) else None
    inter = out[(out["SiO2"] >= 55) & (out["SiO2"] <= 75)]
    stats["intermediate_felsic_SiO2_55_75"] = {"n": int(len(inter)), "share_Sr_Y_ge_40": round(float((inter["Sr_Y"] >= 40).mean()), 3) if len(inter) else None}
    d2 = d.loc[out.index].assign(**out[["Sr_Y", "V_Sc", "Eu_Eu_star"]])
    fig, (a1, a2) = plt.subplots(1, 2, figsize=(11, 5))
    p = d2.dropna(subset=["Sr_Y", "Eu_Eu_star"])
    if len(p):
        _colour_scatter(a1, p, "Eu_Eu_star", "Sr_Y", logy=True); a1.axhline(40, color="#999", ls="--", lw=0.8)
    a1.set_xlabel("Eu/Eu* (chondrite-normalised)"); a1.set_ylabel("Sr/Y"); a1.set_title("Sr/Y vs Eu/Eu*" + ("" if len(p) else " (no Eu, Sm, Gd data)"))
    p = d2.dropna(subset=["V_Sc", "SiO2"])
    if len(p):
        _colour_scatter(a2, p, "SiO2", "V_Sc", logy=True); a2.axhline(10, color="#999", ls="--", lw=0.8)
    a2.set_xlabel("SiO2 wt %"); a2.set_ylabel("V/Sc"); a2.set_title("V/Sc vs SiO2" + ("" if len(p) else " (no V, Sc, SiO2 data)"))
    if len(p): a2.legend(fontsize=7, markerscale=2)
    return fig, stats, out.round(3)


def m_pegmatite(df):
    d = df.copy()
    out = pd.DataFrame({"K_Rb": d["K"] / d["Rb"], "Rb": d["Rb"], "Rb_Sr": d["Rb"] / d["Sr"], "Nb_Ta": d["Nb"] / d["Ta"],
                        "Zr_Hf": d["Zr"] / d["Hf"], "Li": d["Li"], "Cs": d["Cs"]}, index=d.index)
    if out[["K_Rb", "Nb_Ta", "Zr_Hf"]].dropna(how="all").empty:
        raise ValueError("No selected sample has K+Rb, Nb+Ta or Zr+Hf (total basis).")
    stats = {k: _q(out[k]) for k in ["K_Rb", "Rb", "Rb_Sr", "Nb_Ta", "Zr_Hf", "Li", "Cs"]}
    kr, nt, zh = out["K_Rb"].dropna(), out["Nb_Ta"].dropna(), out["Zr_Hf"].dropna()
    stats["shares"] = {"K_Rb_below_150_evolved": round(float((kr < 150).mean()), 3) if len(kr) else None,
                       "K_Rb_below_30_highly_fractionated": round(float((kr < 30).mean()), 3) if len(kr) else None,
                       "Nb_Ta_below_5": round(float((nt < 5).mean()), 3) if len(nt) else None,
                       "Zr_Hf_below_25": round(float((zh < 25).mean()), 3) if len(zh) else None}
    # low-K rocks (mafic, carbonate) give low K/Rb without being evolved, so rank only samples with real Rb enrichment
    top = out[(out["Rb"] >= 50)].dropna(subset=["K_Rb"]).sort_values("K_Rb").head(15)
    stats["most_fractionated_by_K_Rb_with_Rb_at_least_50ppm"] = [{"sample_id": int(i), "K_Rb": round(float(r.K_Rb), 1), "Rb_ppm": round(float(r.Rb), 0),
                                           "Li_ppm": None if pd.isna(r.Li) else round(float(r.Li), 0)} for i, r in top.iterrows()]
    d2 = d.assign(**out[["K_Rb", "Nb_Ta", "Zr_Hf"]])
    fig, (a1, a2) = plt.subplots(1, 2, figsize=(11, 5))
    p = d2.dropna(subset=["K_Rb", "Rb"])
    if len(p):
        _colour_scatter(a1, p, "Rb", "K_Rb", logx=True, logy=True)
        for v in (150, 30): a1.axhline(v, color="#999", ls="--", lw=0.8)
    a1.set_xlabel("Rb ppm"); a1.set_ylabel("K/Rb"); a1.set_title("K/Rb vs Rb" + ("" if len(p) else " (no K+Rb data)"))
    p = d2.dropna(subset=["Nb_Ta", "Zr_Hf"])
    if len(p):
        _colour_scatter(a2, p, "Zr_Hf", "Nb_Ta", logx=True, logy=True)
        a2.axhline(5, color="#999", ls="--", lw=0.8); a2.axvline(25, color="#999", ls="--", lw=0.8)
        a2.scatter([36], [17.5], marker="*", s=120, color="k", zorder=5); a2.text(36.5, 17.5, " chondrite", fontsize=8)
        a2.legend(fontsize=7, markerscale=2)
    a2.set_xlabel("Zr/Hf"); a2.set_ylabel("Nb/Ta"); a2.set_title("Nb/Ta vs Zr/Hf" + ("" if len(p) else " (no Nb, Ta, Zr, Hf data)"))
    return fig, stats, out.round(2)


def m_harker(df):
    d = df.dropna(subset=["SiO2"]).copy()
    d["Na2O+K2O"] = d["Na2O"] + d["K2O"]
    panels = ["TiO2", "Al2O3", "FeOT", "MgO", "CaO", "Na2O", "K2O", "P2O5"]
    fig, axes = plt.subplots(2, 4, figsize=(14, 6.5))
    stats = {"n_with_SiO2": int(len(d)), "spearman_vs_SiO2": {}}
    for ax, ox in zip(axes.ravel(), panels):
        p = d.dropna(subset=[ox])
        if len(p):
            _colour_scatter(ax, p, "SiO2", ox, s=5)
            stats["spearman_vs_SiO2"][ox] = round(float(p["SiO2"].corr(p[ox], method="spearman")), 2)
        ax.set_xlabel("SiO2 wt %", fontsize=8); ax.set_ylabel(f"{ox} wt %", fontsize=8); ax.tick_params(labelsize=7)
    h, l = axes.ravel()[0].get_legend_handles_labels()
    if h: fig.legend(h, l, loc="lower center", ncol=5, fontsize=7, markerscale=2)
    fig.suptitle("Harker variation diagrams"); fig.tight_layout(rect=(0, 0.06, 1, 0.97))
    return fig, stats, d[["SiO2"] + panels].round(2)


def m_jensen(df):
    from pyrolite.plot.templates import JensenPlot
    d = df.dropna(subset=NEEDS["jensen"]).copy()
    d["TiO2"] = d["TiO2"].fillna(0.0)
    # Jensen (1976): cation proportions of Al, Fe(total)+Ti, Mg
    cat = pd.DataFrame({"Al": 2 * d["Al2O3"] / MW["Al2O3"], "FeTi": d["FeOT"] / MW["FeO"] + d["TiO2"] / MW["TiO2"], "Mg": d["MgO"] / MW["MgO"]})
    cat = cat.div(cat.sum(axis=1), axis=0) * 100
    ax = JensenPlot()
    fig = ax.figure
    tern = pd.DataFrame({"FeOT+TiO2": cat["FeTi"], "Al2O3": cat["Al"], "MgO": cat["Mg"]})
    try:
        tern[["FeOT+TiO2", "Al2O3", "MgO"]].pyroplot.scatter(ax=ax, s=8, alpha=0.6, c="#c0392b")
    except Exception:
        tern.pyroplot.scatter(ax=ax, s=8, alpha=0.6, c="#c0392b")
    ax.set_title("Jensen (1976) cation plot")
    stats = {"n": int(len(cat)), "median_cation_pct": {k: round(float(v), 1) for k, v in cat.median().items()},
             "note": "Field counts are not computed; read the series from the figure. Al-rich points plot toward calc-alkaline fields, Fe+Ti-rich toward high-Fe tholeiite, Mg-rich toward komatiite."}
    return fig, stats, cat.round(1)


RUN = {"niggli": m_niggli, "cipw_norm": m_cipw, "weathering": m_weathering, "porphyry_fertility": m_porphyry,
       "pegmatite_fractionation": m_pegmatite, "harker": m_harker, "jensen": m_jensen}


def generate_geochem_indices(sample_ids=None, label=None, method="niggli", source_system=None, lithology_category=None,
                             min_lon=None, min_lat=None, max_lon=None, max_lat=None, max_samples=30000, save_path=None):
    if method not in METHODS:
        raise ValueError(f"Unknown method '{method}'. Choose one of: {', '.join(METHODS)}.")
    max_samples = int(min(max(int(max_samples), 500), 100000))
    df, info = fetch(sample_ids, source_system, lithology_category, (min_lon, min_lat, max_lon, max_lat), max_samples)
    need = NEEDS[method]
    cover = {e: int(df[e].notna().sum()) for e in need}
    missing = [e for e, c in cover.items() if c == 0]
    if missing:
        raise ValueError(f"None of the {len(df):,} selected samples has a total-basis value for {missing}, which '{method}' needs. "
                         "Only total-basis analyses are used (partial digestions such as aqua regia are not).")
    usable = int(df[need].dropna().shape[0])
    if usable == 0:
        raise ValueError(f"No selected sample has all of {need} together, so '{method}' cannot be calculated.")
    fig, stats, per_sample = RUN[method](df)
    title = " | ".join(x for x in [label or source_system or f"{len(df):,} samples",
                                   lithology_category.replace("_", " ").title() if lithology_category else None] if x)
    fig.text(0.01, 0.005, title, fontsize=8, color="#555")
    per = per_sample.copy()
    per.insert(0, "lithology", df.loc[per.index, "lithology_name"].fillna(df.loc[per.index, "litho"]))
    summary = {
        "method": method,
        "selection": {"label": label, "source_system": source_system, "lithology_category": lithology_category, **info},
        "samples_with_each_needed_value_total_basis": cover,
        "samples_with_all_needed_values": usable,
        "lithology_mix": {k: int(v) for k, v in df.loc[per_sample.index, "litho"].value_counts().items()},
        "statistics": stats,
        "per_sample_first_200": json.loads(per.head(200).reset_index().to_json(orient="records")),
        "notes": ["Total-basis analyses only; below-detection, zero and negative values dropped.",
                  "Indicative cut-offs are literature screening values, not proof of fertility or fractionation.",
                  "Regional surveys mix rock types: compare like with like (use lithology_category)."],
    }
    print(json.dumps(summary, indent=2, default=str))
    if save_path:
        fig.savefig(save_path, dpi=130, bbox_inches="tight")
        plt.close(fig)
    else:
        plt.show()


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", default=None)
    parser.add_argument("--ids", default=None, help="comma-separated sample_ids")
    parser.add_argument("--method", default="niggli", choices=METHODS)
    parser.add_argument("--lithology", default=None)
    parser.add_argument("--label", default=None)
    parser.add_argument("--max-samples", type=int, default=30000)
    parser.add_argument("--save", default=None)
    a = parser.parse_args()
    if a.save:
        plt.switch_backend("Agg")
    generate_geochem_indices(sample_ids=[int(x) for x in a.ids.split(",")] if a.ids else None, label=a.label, method=a.method,
                             source_system=a.source, lithology_category=a.lithology, max_samples=a.max_samples, save_path=a.save)
