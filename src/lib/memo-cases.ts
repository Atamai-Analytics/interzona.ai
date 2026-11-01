// The investor memos on offer. A case names a region and a commodity and which of the app's analyses to run for it; the memo itself is built only from stored data
// and the document library (see memo.ts), so nothing here is a claim about the geology, only where to look.

export type MemoCase = {
  id: string;
  title: string;
  subtitle: string;
  commodity: string;
  leads: { source_system: string; bbox: number[]; commodity?: string; elements?: string[]; basis?: string };
  fingerprint?: { source_system: string; bbox?: number[]; lead_filter?: { element: string; min_ppm: number } };
  occurrences: { country: string; pattern: string; label: string };
  companies: string[];
  companyCommodity?: string;
  literature: string[];
  /** A passage is quoted only if it mentions one of these (so a quote about another country is not shown). */
  literatureMust: string;
  /** Project status, permitting and finance: each topic is searched in the document library and its passages are quoted with their sources. */
  context?: { topic: string; query: string; /** phrases (regular expressions, most specific first): the quoted passage must contain one, and is centred on the first that matches, so it is about the topic and not just the region */ require: string[] }[];
  /** The leads come from a sediment or soil survey, whose anomalies point to catchments rather than to points. */
  sedimentSurvey?: boolean;
  priceCommodity?: string;
};

export const MEMO_CASES: Record<string, MemoCase> = {
  "greenland-ree": {
    id: "greenland-ree",
    title: "Greenland rare earths",
    subtitle: "Geochemical leads, deposit-type signature, catalogued deposits, project holders and the literature",
    commodity: "rare earth elements",
    leads: { source_system: "GREENLAND_GEUS", bbox: [-75, 59, -10, 84], commodity: "REE" },
    fingerprint: { source_system: "GREENLAND_GEUS", lead_filter: { element: "La", min_ppm: 300 } },
    occurrences: { country: "Greenland", pattern: "rare earth|^l?h?ree$|^y2o3$|^(la|ce|pr|nd|sm|eu|gd|tb|dy|ho|er|tm|yb|lu|y)$", label: "rare earth occurrences" },
    companies: ["Energy Transition Minerals", "Greenland Mines", "80 Mile", "Amaroq"],
    companyCommodity: "rare earth",
    literatureMust: "greenland|gardar|ilimaussaq|ilímaussaq|kvanefjeld|kuannersuit|tanbreez|sarfartoq|motzfeldt",
    context: [
      { topic: "Tanbreez (Kringlerne): resource, licence and finance", query: "Tanbreez Kringlerne Critical Metals mineral resource estimate exploitation licence financing feasibility", require: ["mineral resource estimate", "feasibility stage", "exploitation licen[cs]e", "tanbreez", "kringlerne", "killavaat"] },
      { topic: "Kvanefjeld (Kuannersuit): uranium ban and legal position", query: "Kvanefjeld Kuannersuit uranium ban arbitration Energy Transition Minerals Greenland Minerals", require: ["uranium (mining )?ban", "law banning", "banning mining", "arbitration", "ban on (the )?(mining|uranium)"] },
      { topic: "United States government and EXIM support", query: "EXIM conditional loan commitment Tanbreez Critical Metals Greenland", require: ["exim", "conditional loan", "loan commitment"] },
      { topic: "Offtake, licences and permitting", query: "Greenland rare earth offtake agreement mining licence permit approval Tanbreez Sarfartoq", require: ["offtake agreement", "mining licen[cs]e", "exploitation licen[cs]e", "permit", "approval"] },
      { topic: "Other projects: Sarfartoq and Motzfeldt", query: "Sarfartoq Greenland Mines Motzfeldt rare earth project assessment", require: ["sarfartoq", "motzfeldt"] },
    ],
    literature: [
      "rare earth deposits of Greenland, Gardar province and Ilimaussaq geology",
      "Tanbreez Kvanefjeld Sarfartoq rare earth resources and development status",
      "Greenland uranium mining ban and its effect on rare earth projects",
    ],
  },
  "argentina-lithium": {
    id: "argentina-lithium",
    title: "Argentina lithium",
    subtitle: "Geochemical leads, catalogued lithium sites, project holders, price context and the literature",
    commodity: "lithium",
    leads: { source_system: "ARGENTINA_SEGEMAR", bbox: [-74, -56, -52, -21], elements: ["li"], basis: "any" },
    occurrences: { country: "Argentina", pattern: "^li$|lithium", label: "lithium occurrences" },
    companies: ["Rio Tinto"],
    companyCommodity: "lithium",
    literatureMust: "argentin|puna|salar de (olaroz|hombre muerto|cauchari|rincon|rincón)|jujuy|catamarca|olaroz|hombre muerto",
    context: [
      { topic: "Projects and production", query: "Argentina lithium brine projects production expansion Olaroz Cauchari Hombre Muerto Sal de Vida", require: ["olaroz", "cauchari", "hombre muerto", "sal de vida", "fenix", "argentin"] },
      { topic: "Policy, royalties and investment regime", query: "Argentina lithium provincial royalties investment incentive regime export duties RIGI", require: ["royalt", "rigi", "incentive", "export dut", "fiscal", "tax"] },
    ],
    sedimentSurvey: true,
    literature: ["lithium brine deposits of the Argentine Puna salars", "lithium extraction and processing from brine and pegmatite"],
    priceCommodity: "lithium",
  },
};
