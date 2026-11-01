"""
Halley (2020) "Mapping magmatic and hydrothermal processes from routine exploration geochemical analyses"
(Economic Geology 115, 1-15): the rock-composition and alteration chart workflow, run on a set of samples from
geochem.sample_chemistry_wide. One figure per call.

FIGURES (parameter `figure`; the number is the figure number in the paper):
  sc_vs        1  Sc versus Th, Ti, V and Nb (four panels, point-density contours)
  v_sc         2  V/Sc versus Sc            - magnetite versus amphibole/pyroxene fractionation
  sr_y         3  Sr/Y versus Y             - high-pressure hydrous melting; the paper's "fertile porphyry" fields are NOT drawn
  sc_ni_cu     4  Sc versus Ni and Cu       - departures from the Sc trend: sulfide saturation or leaching
  hf_zr        5  Hf versus Zr              - zircon fractionation
  ti_nb        6  Ti versus Nb
  ta_nb_ti     7  Ta/Nb versus Ti           - biotite fractionation
  k_al_na_al   8  K/Al versus Na/Al (molar) - alteration mineralogy, with end-member minerals
  ca_k_na      9, 14  Ca-K-Na ternary (element wt %)  - hydrothermal feldspar, sericite, carbonate
  al_k_mg      10 Al-K-Mg ternary (element wt %)      - sericite, chlorite, advanced argillic clays
  rb_k         11 Rb versus K                         - coloured by lithology (the paper colours by SWIR mineral: NOT possible here)
  ca_mg        12 Ca versus Mg (element wt %) with the dolomite line (Ca:Mg molar 1:1)
  ca_fe_mg     13 Ca-Fe-Mg ternary (element wt %)     - hydrothermal carbonate (ankerite/dolomite) and pyrite
  fe_s         15 Fe versus S (element wt %) with the pyrite line (Fe:S molar 1:2) - sulfidation
  ca_fe_s      16 Ca-Fe-S ternary (element wt %)      - anhydrite versus pyrite

NOT INCLUDED, on purpose:
  - anything that depends on SWIR spectra (the paper's Fig. 11 colours points by SWIR mineral and several plots take their
    mineral classes from SWIR). Points are coloured here by logged lithology category.
  - the "ore-related" / "normal arc" fields of Fig. 3 (Loucks 2014 / Richards & Kerrich 2007): they have to be digitised and
    checked before they are drawn.
  - the paper's sample classes (logged mineralogy, SWIR, the shaded zones and ellipses it draws by hand): points are coloured by
    lithology, and only the end-member minerals are marked.

DATA RULES. TOTAL-basis values only (the *_t columns of geochem.sample_chemistry_wide). Partial digestions (*_p, for example
aqua regia) are never used: they do not dissolve zircon, rutile or framework silicates, so Zr, Hf, Nb, Ta, Ti, K, Na and Al
would be wrong. Trace elements are ppm, major oxides wt %. Zero, negative and below-detection values are not plotted.
The paper's workflow was written for four-acid ICP data from drill core through ONE deposit; on a regional rock-sample survey
the rock types are mixed, so read clusters as compositional groups, not as the products of one magmatic system.

SAMPLE SELECTION: pass sample_ids, or let the script select by source_system (a dataset such as FINLAND_GTK_ROCK),
lithology_category and/or a bounding box (min_lon, min_lat, max_lon, max_lat). Selections over max_samples are thinned
deterministically (md5 of the sample id), and the summary says so.

Designed to run as a cell in an E2B code-interpreter sandbox (via runCode): the entry point prints a JSON summary and then
calls plt.show(). Also runnable directly:
    python halley_plots.py --source FINLAND_GTK_ROCK --figure v_sc --save out.png
"""
import json
import os
import warnings

warnings.filterwarnings("ignore")

import numpy as np
import pandas as pd
import psycopg2
import matplotlib.pyplot as plt
from matplotlib.ticker import FuncFormatter, NullFormatter

REQUIRED_KEYS = ["PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD"]

# wide-table columns (all TOTAL basis) -> short names
COLUMNS = {
    "sc_t": "Sc", "th_t": "Th", "ti_t": "Ti", "v_t": "V", "nb_t": "Nb", "zr_t": "Zr", "hf_t": "Hf", "ta_t": "Ta",
    "sr_t": "Sr", "y_t": "Y", "ni_t": "Ni", "cu_t": "Cu", "k2o_t": "K2O", "na2o_t": "Na2O", "al2o3_t": "Al2O3",
    # major elements reported as elements (ppm) and as oxides (wt %); both are converted to element wt % in fetch()
    "ca_t": "Ca_el", "cao_t": "CaO", "mg_t": "Mg_el", "mgo_t": "MgO", "al_t": "Al_el", "k_t": "K_el", "na_t": "Na_el",
    "fe_t": "Fe_el", "fe2o3_t": "Fe2O3", "feto3_t": "FeTO3", "feo_t": "FeO", "s_t": "S_el", "rb_t": "Rb",
}
# oxide molecular weights for the molar K/Al and Na/Al (each oxide carries 2 cations, which cancel)
MW = {"K2O": 94.196, "Na2O": 61.979, "Al2O3": 101.961}

# what each figure needs (derived columns are built in fetch())
NEEDS = {
    "sc_vs": ["Sc", "Th", "Ti", "V", "Nb"], "v_sc": ["Sc", "V"], "sr_y": ["Sr", "Y"], "sc_ni_cu": ["Sc", "Ni", "Cu"],
    "hf_zr": ["Hf", "Zr"], "ti_nb": ["Ti", "Nb"], "ta_nb_ti": ["Ta", "Nb", "Ti"], "k_al_na_al": ["K2O", "Na2O", "Al2O3"],
    "ca_k_na": ["Ca_wt", "K_wt", "Na_wt"], "al_k_mg": ["Al_wt", "K_wt", "Mg_wt"], "rb_k": ["Rb", "K_wt"],
    "ca_mg": ["Ca_wt", "Mg_wt"], "ca_fe_mg": ["Ca_wt", "Fe_wt", "Mg_wt"], "fe_s": ["Fe_wt", "S_wt"], "ca_fe_s": ["Ca_wt", "Fe_wt", "S_wt"],
}
# element weight fractions of the oxides (to turn oxide wt % into element wt %), and atomic weights for the end-member minerals
OXIDE_TO_EL = {"K2O": 0.8301, "Na2O": 0.7419, "CaO": 0.7147, "MgO": 0.6030, "Al2O3": 0.5293, "Fe2O3": 0.6994, "FeTO3": 0.6994, "FeO": 0.7773}
AW = {"Ca": 40.078, "K": 39.098, "Na": 22.990, "Mg": 24.305, "Al": 26.982, "Fe": 55.845, "S": 32.06}
FIGURES = list(NEEDS)

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
    """Returns (dataframe, selection info). Raises a clear error when nothing is selected."""
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
    env = load_env()
    conn = psycopg2.connect(host=env["PGHOST"], port=env["PGPORT"], dbname=env["PGDATABASE"],
                            user=env["PGUSER"], password=env["PGPASSWORD"])
    cur = conn.cursor()
    cur.execute(f"SELECT count(*) FROM geochem.sample_chemistry_wide WHERE {' AND '.join(where)}", params)
    n_matched = int(cur.fetchone()[0])
    if n_matched == 0:
        conn.close()
        raise ValueError("No samples matched the selection.")
    cols = ", ".join(COLUMNS)
    order = "ORDER BY md5(sample_id::text) LIMIT %s" if n_matched > max_samples else ""
    sql = (f"SELECT sample_id, source_system, lithology_category, {cols} FROM geochem.sample_chemistry_wide "
           f"WHERE {' AND '.join(where)} {order}")
    df = pd.read_sql(sql, conn, params=params + ([max_samples] if order else []))
    conn.close()
    df = df.rename(columns=COLUMNS)
    for c in COLUMNS.values():
        df[c] = pd.to_numeric(df[c], errors="coerce")
        df.loc[df[c] <= 0, c] = np.nan              # zero / negative = not a usable detected value
    df["Ti_wt"] = df["Ti"] / 1e4                      # ppm -> wt %, the unit the paper plots Ti in
    df["V_Sc"] = df["V"] / df["Sc"]
    df["Sr_Y"] = df["Sr"] / df["Y"]
    df["Ta_Nb"] = df["Ta"] / df["Nb"]
    df["K_Al"] = (df["K2O"] / MW["K2O"]) / (df["Al2O3"] / MW["Al2O3"])
    df["Na_Al"] = (df["Na2O"] / MW["Na2O"]) / (df["Al2O3"] / MW["Al2O3"])
    # element weight % (total basis): the element column (ppm) where there is one, otherwise the oxide (wt %) converted
    def el(el_col, *oxides):
        out = df[el_col] / 1e4
        for ox in oxides:
            out = out.combine_first(df[ox] * OXIDE_TO_EL[ox])
        return out
    df["Ca_wt"] = el("Ca_el", "CaO"); df["K_wt"] = el("K_el", "K2O"); df["Na_wt"] = el("Na_el", "Na2O")
    df["Mg_wt"] = el("Mg_el", "MgO"); df["Al_wt"] = el("Al_el", "Al2O3")
    df["Fe_wt"] = el("Fe_el", "FeTO3", "Fe2O3", "FeO"); df["S_wt"] = df["S_el"] / 1e4
    df["litho"] = df["lithology_category"].fillna("OTHER")
    return df, {"samples_matched": n_matched, "samples_used": int(len(df)), "thinned": n_matched > max_samples}


# ---- drawing helpers -------------------------------------------------------------------------------------------------
def _density_contours(ax, x, y, logx, logy):
    """Point-density contours from a smoothed 2-D histogram (numpy only: scipy is not in the sandbox image)."""
    px = np.log10(x) if logx else np.asarray(x)
    py = np.log10(y) if logy else np.asarray(y)
    h, xe, ye = np.histogram2d(px, py, bins=70)
    k = np.exp(-0.5 * (np.arange(-4, 5) / 1.6) ** 2)
    k /= k.sum()
    h = np.apply_along_axis(lambda m: np.convolve(m, k, mode="same"), 0, h)
    h = np.apply_along_axis(lambda m: np.convolve(m, k, mode="same"), 1, h)
    xc, yc = (xe[:-1] + xe[1:]) / 2, (ye[:-1] + ye[1:]) / 2
    gx, gy = np.meshgrid(xc, yc, indexing="ij")
    ax.contour(10 ** gx if logx else gx, 10 ** gy if logy else gy, h, levels=[h.max() * f for f in (0.08, 0.2, 0.4, 0.65, 0.85)],
               colors="black", linewidths=0.6, alpha=0.7)


def _plain_log_axes(ax, logx, logy):
    for use, axis, setter in ((logx, ax.xaxis, ax.set_xscale), (logy, ax.yaxis, ax.set_yscale)):
        if use:
            setter("log")
            axis.set_major_formatter(FuncFormatter(lambda v, _: f"{v:g}"))
            axis.set_minor_formatter(NullFormatter())


def _scatter(ax, df, x, y, xl, yl, logx=True, logy=True, contours=True):
    d = df[[x, y, "litho"]].dropna()
    for cat, g in d.groupby("litho"):
        ax.scatter(g[x], g[y], s=3.5, alpha=0.45, linewidths=0, c=LITHO_COLOURS.get(cat, "#7f8c8d"),
                   label=f"{cat.replace('_', ' ').title()} ({len(g):,})")
    _plain_log_axes(ax, logx, logy)
    if contours and len(d) >= 200:
        try:
            _density_contours(ax, d[x].values, d[y].values, logx, logy)
        except Exception:
            pass
    ax.set_xlabel(xl); ax.set_ylabel(yl); ax.grid(alpha=0.2)
    return len(d)


def _legend(fig, ax):
    h, l = ax.get_legend_handles_labels()
    if h:
        fig.legend(h, l, loc="lower center", ncol=min(len(l), 3), fontsize=7.5, frameon=False, markerscale=3)


def _q(s, qs=(0.1, 0.5, 0.9)):
    s = pd.Series(s).dropna()
    return {f"p{int(q * 100)}": round(float(s.quantile(q)), 3) for q in qs} if len(s) else {}


def _logr(a, b):
    d = pd.DataFrame({"a": a, "b": b}).dropna()
    d = d[(d["a"] > 0) & (d["b"] > 0)]
    return round(float(np.corrcoef(np.log10(d["a"]), np.log10(d["b"]))[0, 1]), 3) if len(d) > 10 else None



# ---- ternary diagrams (element wt %, top / bottom-left / bottom-right) -------------------------------------------------
def _tern_xy(top, left, right):
    """Barycentric fractions -> plot coordinates: top apex (0.5, 0.866), left apex (0, 0), right apex (1, 0)."""
    top, left, right = np.asarray(top, float), np.asarray(left, float), np.asarray(right, float)
    return right + 0.5 * top, top * (np.sqrt(3) / 2)


def _mineral_point(formula_moles, axes):
    """Projected composition of an ideal mineral onto the three plotted elements, as weight fractions summing to 1."""
    w = np.array([formula_moles.get(e, 0.0) * AW[e] for e in axes], float)
    return w / w.sum()


# figure -> ((top, left, right) elements, title, end-member minerals: name -> (moles of each element, label offset in points))
TERNARY = {
    "ca_k_na": (("Ca", "Na", "K"), "Fig. 9 / 14 - Ca-K-Na ternary (element wt %)", {
        "K-feldspar / muscovite / biotite": ({"K": 1}, (-40, -14)), "Albite / paragonite": ({"Na": 1}, (-30, -14)),
        "Calcite / anorthite / anhydrite": ({"Ca": 1}, (8, 0)), "Oligoclase (An25)": ({"Na": 0.75, "Ca": 0.25}, (-98, 2)),
        "Alkali feldspar (Or50)": ({"K": 0.5, "Na": 0.5}, (-40, -14)),
    }),
    "al_k_mg": (("Al", "Mg", "K"), "Fig. 10 - Al-K-Mg ternary (element wt %)", {
        "Kaolinite / pyrophyllite (Al)": ({"Al": 1}, (8, 0)), "Muscovite": ({"K": 1, "Al": 3}, (8, 2)),
        "K-feldspar": ({"K": 1, "Al": 1}, (8, 2)), "Chlorite (clinochlore)": ({"Mg": 5, "Al": 2}, (-104, 2)),
        "Biotite (phlogopite)": ({"K": 1, "Mg": 3, "Al": 1}, (-100, 2)),
    }),
    "ca_fe_mg": (("Ca", "Mg", "Fe"), "Fig. 13 - Ca-Fe-Mg ternary (element wt %)", {
        "Calcite (Ca)": ({"Ca": 1}, (8, 0)), "Dolomite": ({"Ca": 1, "Mg": 1}, (-52, 2)),
        "Ankerite (Fe end member)": ({"Ca": 1, "Fe": 1}, (8, 2)),
        "Magnesite (Mg)": ({"Mg": 1}, (-30, -14)), "Siderite / pyrite (Fe)": ({"Fe": 1}, (-70, -14)),
    }),
    "ca_fe_s": (("Ca", "Fe", "S"), "Fig. 16 - Ca-Fe-S ternary (element wt %)", {
        "Anhydrite / gypsum": ({"Ca": 1, "S": 1}, (8, 2)), "Pyrite": ({"Fe": 1, "S": 2}, (-18, -14)),
        "Alunite (S, no Ca or Fe)": ({"S": 1}, (-30, -14)), "Calcite (Ca)": ({"Ca": 1}, (8, 0)),
        "Fe (biotite, magnetite, siderite)": ({"Fe": 1}, (-70, -14)),
    }),
}


def _label_style(f):
    """Label offset (points) and alignment for an end-member, from where it sits in the triangle (apex, edge or interior)."""
    top, left, right = f
    if top > 0.98:
        return 8, 2, "left"
    if left > 0.98:
        return 6, 12, "left"
    if right > 0.98:
        return -6, 12, "right"
    if top < 0.02:
        return 0, -16, "center"
    if right < 0.02:
        return -8, 0, "right"
    if left < 0.02:
        return 8, 0, "left"
    return 8, 4, "left"


def draw_ternary(figure, df, title):
    axes_names, ttl, minerals = TERNARY[figure]
    top, left, right = axes_names
    cols = [f"{e}_wt" for e in axes_names]
    d = df[cols + ["litho"]].dropna()
    d = d[(d[cols] >= 0).all(axis=1)]
    tot = d[cols].sum(axis=1)
    d = d[tot > 0]
    tot = tot[d.index]
    ft, fl, fr = d[cols[0]] / tot, d[cols[1]] / tot, d[cols[2]] / tot
    x, y = _tern_xy(ft, fl, fr)
    x = pd.Series(np.asarray(x), index=d.index)
    y = pd.Series(np.asarray(y), index=d.index)
    fig, ax = plt.subplots(figsize=(8.2, 7.4))
    ax.plot([0, 1, 0.5, 0], [0, 0, np.sqrt(3) / 2, 0], color="black", lw=1)
    for k in (0.2, 0.4, 0.6, 0.8):
        for a, b in (((k, 1 - k, 0), (k, 0, 1 - k)), ((1 - k, k, 0), (0, k, 1 - k)), ((1 - k, 0, k), (0, 1 - k, k))):
            xa, ya = _tern_xy(*[np.array([v]) for v in a])
            xb, yb = _tern_xy(*[np.array([v]) for v in b])
            ax.plot([xa[0], xb[0]], [ya[0], yb[0]], color="grey", lw=0.4, alpha=0.5)
        xt, yt = _tern_xy(np.array([k]), np.array([1 - k]), np.array([0.0]))
        ax.text(xt[0] - 0.03, yt[0], f"{int(k * 100)}", fontsize=6.5, ha="right", color="grey")
        xr, yr = _tern_xy(np.array([0.0]), np.array([1 - k]), np.array([k]))
        ax.text(xr[0], yr[0] - 0.035, f"{int(k * 100)}", fontsize=6.5, ha="center", color="grey")
        xl, yl = _tern_xy(np.array([1 - k]), np.array([0.0]), np.array([k]))
        ax.text(xl[0] + 0.03, yl[0], f"{int(k * 100)}", fontsize=6.5, ha="left", color="grey")
    for cat, g in d.groupby("litho"):
        idx = g.index
        ax.scatter(x[idx], y[idx], s=3.5, alpha=0.45, linewidths=0, c=LITHO_COLOURS.get(cat, "#7f8c8d"),
                   label=f"{cat.replace('_', ' ').title()} ({len(g):,})")
    ax.text(0.5, np.sqrt(3) / 2 + 0.03, f"{top} (wt %)", ha="center", fontsize=10)
    ax.text(0.0, -0.10, f"{left} (wt %)", ha="center", fontsize=10)
    ax.text(1.0, -0.10, f"{right} (wt %)", ha="center", fontsize=10)
    near = {}
    for name, (moles, off) in minerals.items():
        f = _mineral_point(moles, axes_names)
        mx, my = _tern_xy(f[0:1], f[1:2], f[2:3])
        ax.scatter(mx, my, marker="*", s=130, c="black", zorder=6)
        dx, dy, ha = _label_style(f)
        ax.annotate(name, (mx[0], my[0]), textcoords="offset points", xytext=(dx, dy), ha=ha, fontsize=7.5, zorder=7)
        near[name] = round(float((np.hypot(x - mx[0], y - my[0]) < 0.10).mean()), 3)
    ax.set_xlim(-0.3, 1.3)
    ax.set_ylim(-0.14, 0.96)
    ax.set_aspect("equal")
    ax.axis("off")
    ax.set_title(f"{title}\n{ttl}   n={len(d):,}  (stars = end-member minerals)", fontsize=10)
    _legend(fig, ax)
    fig.tight_layout(rect=[0, 0.1, 1, 1])
    med = {e: round(float(np.median(v)), 3) for e, v in zip(axes_names, (ft, fl, fr))}
    return fig, {"n": int(len(d)), "median_share_of_the_three_elements": med,
                 "share_of_samples_within_0.10_of_each_end_member": near}


# ---- figures ---------------------------------------------------------------------------------------------------------
def draw(figure, df, title):
    stats = {}
    if figure in TERNARY:
        return draw_ternary(figure, df, title)
    if figure == "sc_vs":
        fig, axes = plt.subplots(2, 2, figsize=(11, 9))
        for ax, (y, lab, key) in zip(axes.ravel(), [("Th", "Th (ppm)", "Th"), ("Ti_wt", "Ti (wt %)", "Ti"), ("V", "V (ppm)", "V"), ("Nb", "Nb (ppm)", "Nb")]):
            n = _scatter(ax, df, "Sc", y, "Sc (ppm)", lab)
            ax.set_title(f"Sc vs {key}   n={n:,}", fontsize=10)
            stats[f"Sc_{key}"] = {"n": n, "log_correlation": _logr(df["Sc"], df[y])}
        fig.suptitle(f"{title}\nFig. 1 - Sc versus Th, Ti, V and Nb (contours = point density)", fontsize=11)
        _legend(fig, axes[0, 0]); fig.tight_layout(rect=[0, 0.08, 1, 0.95])
    elif figure == "sc_ni_cu":
        fig, axes = plt.subplots(1, 2, figsize=(11, 5.4))
        for ax, y in zip(axes, ["Ni", "Cu"]):
            n = _scatter(ax, df, "Sc", y, "Sc (ppm)", f"{y} (ppm)")
            ax.set_title(f"Sc vs {y}   n={n:,}", fontsize=10)
            stats[f"Sc_{y}"] = {"n": n, "log_correlation": _logr(df["Sc"], df[y]), f"{y}_ppm": _q(df[y])}
        fig.suptitle(f"{title}\nFig. 4 - Sc versus Ni and Cu (departures from the Sc trend: sulfide saturation or leaching)", fontsize=10)
        _legend(fig, axes[0]); fig.tight_layout(rect=[0, 0.11, 1, 0.93])
    elif figure == "k_al_na_al":
        fig, ax = plt.subplots(figsize=(7.8, 6.8))
        d = df[["K_Al", "Na_Al", "litho"]].dropna()
        d = d[(d["K_Al"] > 0) & (d["Na_Al"] > 0)]
        for cat, g in d.groupby("litho"):
            ax.scatter(g["Na_Al"], g["K_Al"], s=3.5, alpha=0.45, linewidths=0, c=LITHO_COLOURS.get(cat, "#7f8c8d"),
                       label=f"{cat.replace('_', ' ').title()} ({len(g):,})")
        # name: (Na/Al, K/Al, label offset in points); ideal-formula molar ratios
        ends = {
            "K-feldspar / biotite": (0.0, 1.0, (8, 4)), "Albite": (1.0, 0.0, (-34, 8)), "Muscovite / illite": (0.0, 1 / 3, (8, 4)),
            "Paragonite / andesine (An50)": (1 / 3, 0.0, (4, 30)), "Oligoclase (An25)": (0.6, 0.0, (2, 14)),
            "Kaolinite / pyrophyllite / chlorite / anorthite": (0.0, 0.0, (8, 14)),
        }
        for name, (nax, kax, off) in ends.items():
            ax.scatter([nax], [kax], marker="*", s=120, c="black", zorder=5)
            ax.annotate(name, (nax, kax), textcoords="offset points", xytext=off, fontsize=8,
                        arrowprops=dict(arrowstyle="-", lw=0.5, color="black") if off[1] > 10 else None)
        ax.set_xlim(-0.02, 1.15); ax.set_ylim(-0.02, 1.15)
        ax.set_xlabel("Na/Al (molar)"); ax.set_ylabel("K/Al (molar)"); ax.grid(alpha=0.2)
        ax.set_title(f"{title}\nFig. 8 - K/Al versus Na/Al   n={len(d):,}  (stars = end-member minerals)", fontsize=10)
        _legend(fig, ax); fig.tight_layout(rect=[0, 0.11, 1, 1])
        stats = {"n": int(len(d)), "K_Al": _q(d["K_Al"]), "Na_Al": _q(d["Na_Al"])}
    else:
        fig, ax = plt.subplots(figsize=(7.8, 6.4))
        spec = {
            "v_sc": ("Sc", "V_Sc", "Sc (ppm)", "V/Sc", "Fig. 2 - V/Sc versus Sc (V/Sc ~7 stays constant in reduced magmas)"),
            "sr_y": ("Y", "Sr_Y", "Y (ppm)", "Sr/Y", "Fig. 3 - Sr/Y versus Y (the paper's reference fields are not drawn)"),
            "hf_zr": ("Zr", "Hf", "Zr (ppm)", "Hf (ppm)", "Fig. 5 - Hf versus Zr (zircon fractionation: falling Zr, rising Hf/Zr)"),
            "ti_nb": ("Nb", "Ti_wt", "Nb (ppm)", "Ti (wt %)", "Fig. 6 - Ti versus Nb"),
            "ta_nb_ti": ("Ti_wt", "Ta_Nb", "Ti (wt %)", "Ta/Nb", "Fig. 7 - Ta/Nb versus Ti (rising Ta/Nb with falling Ti: biotite fractionation)"),
            "rb_k": ("K_wt", "Rb", "K (wt %)", "Rb (ppm)", "Fig. 11 - Rb versus K (coloured by lithology; the paper colours by SWIR mineral, which we do not have)"),
            "ca_mg": ("Mg_wt", "Ca_wt", "Mg (wt %)", "Ca (wt %)", "Fig. 12 - Ca versus Mg (dashed: dolomite, Ca:Mg molar 1:1)"),
            "fe_s": ("S_wt", "Fe_wt", "S (wt %)", "Fe (wt %)", "Fig. 15 - Fe versus S (dashed: pyrite, Fe:S molar 1:2)"),
        }[figure]
        x, y, xl, yl, ttl = spec
        n = _scatter(ax, df, x, y, xl, yl)
        if figure == "v_sc":
            ax.axhline(7, color="grey", ls="--", lw=0.8)
            ax.text(ax.get_xlim()[1], 7, " V/Sc = 7", va="bottom", ha="right", fontsize=7)
        if figure in ("ca_mg", "fe_s"):
            slope = AW["Ca"] / AW["Mg"] if figure == "ca_mg" else AW["Fe"] / (2 * AW["S"])
            xs = np.array(ax.get_xlim())
            ax.plot(xs, xs * slope, color="black", ls="--", lw=0.9)
            ax.set_xlim(*xs)
        ax.set_title(f"{title}\n{ttl}   n={n:,}", fontsize=10)
        _legend(fig, ax); fig.tight_layout(rect=[0, 0.11, 1, 1])
        d = df.dropna(subset=[x, y])
        stats = {"n": n, "log_correlation": _logr(d[x], d[y]), y: _q(d[y])}
        if figure == "v_sc":
            # the paper's own stated window for porphyry Cu magmas: 3-8 ppm Sc and V/Sc of 10-15
            win = d[(d["Sc"].between(3, 8)) & (d["V_Sc"].between(10, 15))]
            stats["share_with_V_Sc_between_5_and_9"] = round(float(d["V_Sc"].between(5, 9).mean()), 3)
            stats["samples_in_paper_porphyry_Cu_window_Sc_3_to_8_and_V_Sc_10_to_15"] = int(len(win))
        if figure == "hf_zr":
            stats["Zr_over_Hf"] = _q(d["Zr"] / d["Hf"])
        if figure == "rb_k":
            stats["Rb_ppm_per_K_wt_pct"] = _q(d["Rb"] / d["K_wt"])
        if figure == "ca_mg":
            stats["Ca_over_Mg_wt_ratio"] = _q(d["Ca_wt"] / d["Mg_wt"])
            stats["share_near_dolomite_line_Ca_over_Mg_between_1.3_and_2.0"] = round(float((d["Ca_wt"] / d["Mg_wt"]).between(1.3, 2.0).mean()), 3)
        if figure == "fe_s":
            molar = (d["S_wt"] / AW["S"]) / (d["Fe_wt"] / AW["Fe"])
            stats["S_over_Fe_molar"] = _q(molar)
            stats["share_with_S_over_Fe_molar_at_least_1.8_pyrite_is_2"] = round(float((molar >= 1.8).mean()), 3)
    return fig, stats


def generate_halley_plot(sample_ids=None, label=None, figure="sc_vs", source_system=None, lithology_category=None,
                         min_lon=None, min_lat=None, max_lon=None, max_lat=None, max_samples=50000, save_path=None):
    if figure not in FIGURES:
        raise ValueError(f"Unknown figure '{figure}'. Choose one of: {', '.join(FIGURES)}.")
    max_samples = int(min(max(int(max_samples), 1000), 100000))
    bbox = (min_lon, min_lat, max_lon, max_lat)
    df, info = fetch(sample_ids, source_system, lithology_category, bbox, max_samples)
    need = NEEDS[figure]
    cover = {e: int(df[e].notna().sum()) for e in need}
    missing = [e for e, c in cover.items() if c == 0]
    if missing:
        raise ValueError(
            f"None of the {len(df):,} selected samples has a total-basis value for {missing}, which the '{figure}' figure needs. "
            "Only total-basis analyses are used (partial digestions such as aqua regia are not). "
            "Choose a different figure or a dataset that has them."
        )
    if not df[need].dropna().shape[0]:
        raise ValueError(f"No selected sample has all of {need} together, so the '{figure}' figure cannot be drawn.")
    parts = [label] if label else []
    if source_system and not label:
        parts.append(source_system)
    if lithology_category:
        parts.append(lithology_category.replace("_", " ").title())
    title = " | ".join(parts) or f"{len(df):,} samples"
    fig, stats = draw(figure, df, title)

    summary = {
        "figure": figure, "selection": {"label": label, "source_system": source_system, "lithology_category": lithology_category, **info},
        "samples_with_each_needed_element_total_basis": cover,
        "samples_with_all_needed_elements": int(df[need].dropna().shape[0]),
        "lithology_mix_of_selection": {k: int(v) for k, v in df["litho"].value_counts().items()},
        "statistics": stats,
        "notes": [
            "Total-basis analyses only; partial digestions are never used.",
            "Colours are logged lithology categories. No SWIR information is used or available.",
            "Regional rock-sample surveys mix rock types and are not drill core through one deposit, so clusters are compositional groups, not one magmatic system.",
        ],
    }
    print(json.dumps(summary, indent=2))
    if save_path:
        fig.savefig(save_path, dpi=140)
        plt.close(fig)
    else:
        plt.show()


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--source", default=None)
    parser.add_argument("--figure", default="sc_vs", choices=FIGURES)
    parser.add_argument("--lithology", default=None)
    parser.add_argument("--label", default=None)
    parser.add_argument("--max-samples", type=int, default=50000)
    parser.add_argument("--save", default=None, help="Local PNG path (testing outside a sandbox).")
    args = parser.parse_args()
    if args.save:
        plt.switch_backend("Agg")
    generate_halley_plot(label=args.label, figure=args.figure, source_system=args.source, lithology_category=args.lithology,
                         max_samples=args.max_samples, save_path=args.save)
