// The analyses offered on the Geochemistry page (/tools/geochemistry): each one is a vetted analytics script (src/lib/sandbox.ts) run on the
// chosen sample_ids. `needs` lists, per required quantity, the geochem.sample_chemistry_wide columns that can supply it (any one will do); a
// sample counts as usable for a method when every quantity has a value. Shared by the page (to grey out what a selection cannot support) and
// the API routes (to count usable samples and to run the scripts). Total-basis (_t) columns only: the scripts never use partial digestions.

export type MethodGroup = "Classification" | "Norms and variation" | "Alteration and weathering" | "Fertility" | "Rare earths and trace elements";

export type GeochemMethod = {
  id: string;
  group: MethodGroup;
  label: string;
  blurb: string;
  script: string;
  options?: Record<string, string>;
  needs: string[][];
  /** Igneous/whole-rock diagrams that are meaningless for soils, sediments, till, plants or water. */
  rockOnly: boolean;
};

const FE = ["feto3_t", "fe2o3_t", "feo_t"];
const REE_MIN = [["la_t"], ["ce_t"], ["nd_t"], ["sm_t"], ["eu_t"], ["gd_t"], ["yb_t"]];

export const METHODS: GeochemMethod[] = [
  { id: "tas", group: "Classification", label: "TAS (total alkali-silica)", blurb: "Volcanic rock names from Na2O + K2O against SiO2 (Le Bas et al. 1986).", script: "tas_classification_plot", needs: [["sio2_t"], ["na2o_t"], ["k2o_t"]], rockOnly: true },
  { id: "jensen", group: "Classification", label: "Jensen cation plot", blurb: "Tholeiitic, calc-alkaline or komatiitic affinity (Jensen 1976).", script: "geochem_indices", options: { method: "jensen" }, needs: [["al2o3_t", "al_t"], FE, ["mgo_t", "mg_t"]], rockOnly: true },
  { id: "pearce", group: "Classification", label: "Pearce Th/Yb–Nb/Yb", blurb: "Mantle array versus subduction or crustal input in basalts (Pearce 2008).", script: "pearce_discrimination_plot", needs: [["th_t"], ["nb_t"], ["yb_t"]], rockOnly: true },
  { id: "pearce_ti", group: "Classification", label: "Pearce TiO2/Yb–Nb/Yb", blurb: "MORB versus OIB melting depth in basalts (Pearce 2008).", script: "pearce_ti_discrimination_plot", needs: [["ti_t"], ["nb_t"], ["yb_t"]], rockOnly: true },
  { id: "niggli", group: "Norms and variation", label: "Niggli numbers", blurb: "si, al, fm, c, alk, k, mg, qz and a Niggli variation diagram.", script: "geochem_indices", options: { method: "niggli" }, needs: [["sio2_t"], ["al2o3_t", "al_t"], FE, ["mgo_t", "mg_t"], ["cao_t", "ca_t"], ["na2o_t", "na_t"], ["k2o_t", "k_t"]], rockOnly: true },
  { id: "cipw", group: "Norms and variation", label: "CIPW norm", blurb: "Normative minerals and silica saturation (Verma et al. 2003), Q-Ab-Or ternary.", script: "geochem_indices", options: { method: "cipw_norm" }, needs: [["sio2_t"], ["al2o3_t", "al_t"], FE, ["mgo_t", "mg_t"], ["cao_t", "ca_t"], ["na2o_t", "na_t"], ["k2o_t", "k_t"]], rockOnly: true },
  { id: "harker", group: "Norms and variation", label: "Harker diagrams", blurb: "Major oxides against SiO2: fractionation trends.", script: "geochem_indices", options: { method: "harker" }, needs: [["sio2_t"], ["al2o3_t", "mgo_t", "cao_t", "tio2_t"]], rockOnly: true },
  { id: "alteration_box", group: "Alteration and weathering", label: "Alteration box plot", blurb: "Ishikawa alteration index against the chlorite-carbonate-pyrite index (Large et al. 2001).", script: "alteration_box_plot", needs: [["sio2_t"], ["al2o3_t"], ["cao_t"], ["na2o_t"], ["k2o_t"], ["mgo_t"], FE], rockOnly: true },
  { id: "halley_k_na", group: "Alteration and weathering", label: "Halley K/Al–Na/Al", blurb: "Molar K/Al against Na/Al: feldspar, sericite, clay alteration (Halley 2020).", script: "halley_plots", options: { figure: "k_al_na_al" }, needs: [["k2o_t", "k_t"], ["na2o_t", "na_t"], ["al2o3_t", "al_t"]], rockOnly: true },
  { id: "weathering", group: "Alteration and weathering", label: "Weathering indices (CIA)", blurb: "CIA, CIW, PIA, WIP and the A-CN-K diagram: regolith, laterite, clay-hosted REE/Li.", script: "geochem_indices", options: { method: "weathering" }, needs: [["al2o3_t", "al_t"], ["cao_t", "ca_t"], ["na2o_t", "na_t"], ["k2o_t", "k_t"]], rockOnly: false },
  { id: "porphyry", group: "Fertility", label: "Porphyry fertility", blurb: "Sr/Y, V/Sc, Eu/Eu*, La/Yb: hydrous, oxidised magmas that make porphyry Cu.", script: "geochem_indices", options: { method: "porphyry_fertility" }, needs: [["sr_t"], ["y_t"]], rockOnly: true },
  { id: "halley_v_sc", group: "Fertility", label: "Halley V/Sc–Sc", blurb: "Magnetite versus amphibole/pyroxene fractionation (Halley 2020).", script: "halley_plots", options: { figure: "v_sc" }, needs: [["v_t"], ["sc_t"]], rockOnly: true },
  { id: "pegmatite", group: "Fertility", label: "Pegmatite / granite fractionation", blurb: "K/Rb, Rb/Sr, Nb/Ta, Zr/Hf, Li, Cs: evolved granites and LCT pegmatites.", script: "geochem_indices", options: { method: "pegmatite_fractionation" }, needs: [["k2o_t", "k_t"], ["rb_t"]], rockOnly: true },
  { id: "ree_spider", group: "Rare earths and trace elements", label: "REE spider diagram", blurb: "Chondrite-normalised rare-earth patterns.", script: "ree_spider_plot", needs: REE_MIN, rockOnly: false },
  { id: "ree_lambda", group: "Rare earths and trace elements", label: "REE shape (lambda)", blurb: "Pattern slope and curvature (O'Neill 2016) to group REE patterns.", script: "ree_lambda_shape_plot", needs: REE_MIN, rockOnly: false },
  { id: "extended_spider", group: "Rare earths and trace elements", label: "Extended trace-element spider", blurb: "Primitive-mantle-normalised multi-element pattern (Nb, Ta, Zr, Hf, Th anomalies).", script: "extended_spider_plot", needs: [["th_t"], ["nb_t"], ["la_t"], ["zr_t"], ["y_t"]], rockOnly: false },
];

export const METHOD_BY_ID = Object.fromEntries(METHODS.map((m) => [m.id, m])) as Record<string, GeochemMethod>;
export const METHOD_GROUPS: MethodGroup[] = ["Classification", "Norms and variation", "Alteration and weathering", "Fertility", "Rare earths and trace elements"];
export const MAX_METHODS_PER_RUN = 6;
export const MIN_USABLE_SAMPLES = 5;
export const SAMPLE_LIMITS = [250, 500, 1000, 2000, 3000] as const;
export const MAX_SELECTED_SAMPLES = 3000;

/** Every wide-table column any method reads (for the selection query). */
export const NEEDED_COLUMNS = [...new Set(METHODS.flatMap((m) => m.needs.flat()))];

/** Soils, sediments, till, plants, water, tailings, concentrates and QC samples are not rocks: igneous classification does not apply to them. */
export const isRockSampleType = (t: string) => !/sediment|soil|till|vegetation|plant|water|tailing|concentrate|quality control|unknown/i.test(t);

export const DATASET_NAMES: Record<string, string> = {
  ARGENTINA_SEGEMAR: "Argentina (SEGEMAR)",
  AUSTRALIA_VIC_GSV_GEOCHEMISTRY: "Victoria, Australia (GSV)",
  AUSTRALIA_TAS_MRT: "Tasmania, Australia (MRT)",
  CANADA_QC_SIGEOM: "Québec, Canada (SIGÉOM rock)",
  CANADA_QC_SIGEOM_SED: "Québec, Canada (SIGÉOM sediment, soil, till)",
  CANADA_NRCAN_CDOGS: "Canada (NRCan CDoGS federal surveys)",
  CANADA_ATHABASCA_OF7792: "Athabasca Basin, Canada (GSC OF 7792 uranium drill core)",
  CANADA_SK_SGS: "Saskatchewan, Canada (SGS)",
  FINLAND_GTK_ROCK: "Finland (GTK)",
  GREENLAND_GEUS: "Greenland (GEUS)",
  SWEDEN_SGU_LITHOGEOCHEMISTRY: "Sweden (SGU rock)",
  SWEDEN_SGU_MARKGEOKEMI: "Sweden (SGU till, sediment, soil)",
  SWEDEN_SGU_BIOGEOKEMI: "Sweden (SGU stream plants, dry weight)",
  USA_USGS_NGDB: "USA (USGS NGDB)",
  SPAIN_IGME_GEOCHEMISTRY: "Spain (IGME, Li, Cu and W so far)",
  GERMANY_GFZ_ERZGEBIRGE: "Germany (GFZ Erzgebirge granites)",
};
export const datasetName = (s: string) => DATASET_NAMES[s] ?? s;

export type Selection = {
  ids: number[];
  matching: number;
  bySource: { source: string; n: number }[];
  bySampleType: { type: string; n: number }[];
  byLithology: { category: string; n: number }[];
  usable: Record<string, number>; // method id -> selected samples with every needed quantity
  nonRock: number; // selected samples whose sample type is not a rock
  credits: string[];
};

/** Is this wide-table row usable for the method? */
export const usableFor = (m: GeochemMethod, has: (col: string) => boolean) => m.needs.every((alts) => alts.some(has));
