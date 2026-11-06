// The demo cards shown first in the app. Each one is a self-contained question; the saved answers (src/lib/demo-cache.ts) are keyed by this exact
// wording, so changing a prompt here means recording and approving a new answer for it.
export type DemoCard = { icon: string; title: string; description: string; prompt: string };

export const DEMO_CARDS: DemoCard[] = [
  {
    icon: "🧭",
    title: "Greenland rare earths: from anomalies to owners",
    description: "Screens the sample geochemistry for new leads, finds the companies holding projects there, and pulls the geology from the literature, with the leads and the projects shown on maps.",
    prompt: "Where should I explore for rare earth elements in Greenland, which companies hold projects there, and what does our literature say about the geology of the main deposits? Keep it to the top leads.",
  },
  {
    icon: "🗺️",
    title: "Where does Rio Tinto operate?",
    description: "A world map of Rio Tinto's mines and plants with its ownership share in each, and an honest count of the ones that could not be placed.",
    prompt: "Show me where Rio Tinto's mines and plants are and what share Rio Tinto owns in each.",
  },
  {
    icon: "📍",
    title: "Producing lithium sites in Argentina",
    description: "Maps the producing and past-producing lithium occurrences in Argentina, coloured by status, with a download of the places.",
    prompt: "Show me the producing and past-producing lithium occurrences in Argentina on a map.",
  },
  {
    icon: "☢️",
    title: "Who is most exposed to the uranium price?",
    description: "Tests how Cameco, Kazatomprom and Energy Fuels revenue has moved with the uranium price, with a chart, a strength rating and what-if moves.",
    prompt: "How sensitive are Cameco's, Kazatomprom's and Energy Fuels' revenue to the uranium price, and who is most exposed? Show the chart.",
  },
  {
    icon: "🔋",
    title: "The lithium price cycle: who was resilient?",
    description: "Albemarle and SQM through the 2022 to 2024 boom and bust: revenue, margins, cash flow and debt against the lithium price.",
    prompt: "How did Albemarle and SQM come through the 2022 to 2024 lithium price cycle? Compare their revenue and margins with the lithium price and tell me who was more resilient.",
  },
  {
    icon: "🧲",
    title: "The rare earth value chain",
    description: "Lynas, MP Materials and China Northern Rare Earth side by side, with realised prices per kilogram and what the policy reports say about China's share of processing.",
    prompt: "Compare Lynas, MP Materials and China Northern Rare Earth: revenue, margins and what each earns per kilogram of rare earths, then tell me what our reports say about China's share of rare earth processing.",
  },
  {
    icon: "⛏️",
    title: "Diversified miners against their commodities",
    description: "Glencore, Rio Tinto and South32 earnings against copper, iron ore and aluminium prices, plus their assets, ownership shares and a map of where they are.",
    prompt: "Compare Glencore, Rio Tinto and South32: how have their earnings tracked their main commodity prices, and what are their biggest copper, iron ore or aluminium assets and ownership shares?",
  },
  {
    icon: "🏆",
    title: "The best new leads, across every survey",
    description: "Screens six national geochemical surveys at once for rare earths and ranks the unexplored anomalies together, on a map, with how much data each survey has.",
    prompt: "Where are the best new rare earth leads across all the geochemical surveys you have? Rank them.",
  },
  {
    icon: "🧬",
    title: "What kind of deposit is it?",
    description: "Compares the chemistry of Greenland's rare-earth-rich rocks with 1,250 known deposits and the regional background, and says how reliable that is.",
    prompt: "What kind of deposit do the rare-earth-rich rocks in Greenland look like? Use rock samples with lanthanum above 300 ppm.",
  },
  {
    icon: "🌍",
    title: "Who controls the supply?",
    description: "Ranks the critical minerals by how concentrated their mining is in one country, with the top producers, shares and caveats, from the USGS 2026 summaries.",
    prompt: "Which critical minerals have the most concentrated mining supply?",
  },
  {
    icon: "📈",
    title: "Where is copper heading?",
    description: "Shows what a tested price range looks like and what it does not say: the latest copper price, how far past prices strayed over 1 to 12 months, and why we publish no predicted price.",
    prompt: "Where is the copper price heading over the next year?",
  },
  {
    icon: "🧪",
    title: "What should we assay next?",
    description: "For zinc-rich Swedish rock samples, tests which extra element would best tell sediment-hosted, replacement and skarn deposits apart, and how big the gain really is.",
    prompt: "What should I assay next for Sweden SGU rock samples with zinc above 5000 ppm to tell what type of deposit they might be?",
  },
  {
    icon: "🔬",
    title: "From rock chemistry to recovery",
    description: "Runs the Halley scandium chart on Finnish rock samples, then explains how scandium is actually recovered commercially.",
    prompt: "Run the Halley scandium chart (scandium against thorium, titanium, vanadium and niobium) on Finnish rock samples, then tell me what our literature says about how scandium is recovered commercially.",
  },
  {
    icon: "📑",
    title: "An investor memo to send on",
    description: "Opens a printable memo on Greenland rare earths: the leads on a map, what the rocks look like, who holds the projects, what the literature says, and a boxed list of what we don't know.",
    prompt: "Prepare an investor memo on Greenland rare earths.",
  },
  {
    icon: "🍁",
    title: "Québec lithium, study by study",
    description: "Lines up the after-tax NPV, capex, IRR and mine life from each Québec lithium project's own technical report, in Canadian dollars with study dates, on a map, and says why they are not directly comparable.",
    prompt: "Compare the study economics of Québec's lithium projects (after-tax NPV, initial capex, IRR and mine life) and show them on a map.",
  },
  {
    icon: "📄",
    title: "A company snapshot to send on",
    description: "Builds a printable one-to-two page profile with a shareable link, and summarises what stands out.",
    prompt: "Give me a one-page snapshot of Cameco I can send to a colleague, and summarise in three lines what stands out.",
  },
];
