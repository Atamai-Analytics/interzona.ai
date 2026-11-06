import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";
import { admit, checkMessages, LIMITS } from "@/lib/guard";
import { getSession } from "@/lib/auth";
import { depositFingerprint } from "@/lib/fingerprint";
import { assayNext } from "@/lib/assay-next";
import { supplyConcentration } from "@/lib/supply";
import { priceOutlook } from "@/lib/outlook";
import { futureOrVerdictNote } from "@/lib/intent";
import { rankLeads } from "@/lib/leads";
import { getMemo } from "@/lib/memo";
import { MEMO_CASES } from "@/lib/memo-cases";
import { creditsForSource, creditsFromText, limitRestrictedRows } from "@/lib/licence";
import { getApproved, replayResponse, saveDraft, savedNotice } from "@/lib/demo-cache";
import { rememberAnswer } from "@/lib/shared-answers";
import { getInvite, inviteStatus, recordInviteUse } from "@/lib/invites";
import { recordActivity } from "@/lib/activity";
import { runReadOnlyQuery } from "@/lib/db";
import { embedQuery, toVectorLiteral } from "@/lib/voyage";
import { CORE_PROMPT, REFERENCE_NOTES, TOPIC_IDS, notesBlock, selectTopics, type TopicId } from "@/lib/schema-context";
import { runAnalyticsScript, listRegisteredScripts } from "@/lib/sandbox";
import { findGeochemicalAnomalies, type AnomalyParams } from "@/lib/anomalies";
import { mapFromAnomalies, mapFromRows } from "@/lib/map";
import { companyAssets } from "@/lib/assets";
import type { MapData } from "@/lib/types";
import { makeSanitizer, wantsTechnicalDetail } from "@/lib/sanitize";
import { companyFinancials, peerComparison, priceHistory, priceSensitivity, operatingData, OPERATING_METRIC_NAMES, SENSITIVITY_METRICS, FINANCIAL_METRICS, type Dataset, type Evidence } from "@/lib/finance-tools";

export const runtime = "nodejs";
export const maxDuration = 240;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.CHAT_MODEL || "claude-sonnet-5-5";
// Simple single-fact lookups go to the smaller, cheaper model; everything else (analysis, comparisons, literature, follow-ups) stays on MODEL.
// CHAT_ROUTING=off turns routing off (used by the evals to compare); CHAT_FAST_MODEL overrides the small model.
const FAST_MODEL = process.env.CHAT_FAST_MODEL || "claude-haiku-5-5";

const tools: Anthropic.ToolUnion[] = [
  {
    type: "web_search_20250305",
    name: "web_search",
    max_uses: 2,
  },
  {
    type: "web_fetch_20250910",
    name: "web_fetch",
    max_uses: 2,
    max_content_tokens: 6000,
  },
  {
    name: "get_reference_notes",
    description:
      "Load the detailed reference notes (coverage, caveats, table layouts, script lists) for subjects whose notes are not " +
      "already loaded in your instructions. Call this BEFORE writing SQL or interpreting results for such a subject.",
    input_schema: {
      type: "object",
      properties: {
        topics: {
          type: "array",
          items: { type: "string", enum: TOPIC_IDS },
          description: "One or more subjects.",
        },
      },
      required: ["topics"],
    },
  },
  {
    name: "company_financials",
    description:
      "Annual financial statements for one or more companies over several fiscal years, converted to US dollars in a single step. " +
      "USE THIS (not run_sql) for any question about company revenue, profit, cash flow, debt, equity or margins, and for comparing companies, " +
      "especially across currencies: it applies the exchange-rate method correctly (average rate for income statement and cash flow, " +
      "year-end rate for the balance sheet) and returns each rate used. Also returns each year's explanatory note. The user is shown a downloadable table automatically. " +
      "When comparing companies side by side, pass fiscal_years explicitly so every company covers the same years (a June year end and a December year end are different calendar spans; say so). When the user asks about one company's own figure and does not ask for US dollars, use currency \"reported\" and give the amount in the company's own currency. Use run_sql only for things this tool cannot give (quarterly or half-year periods, line items outside the metric list).",
    input_schema: {
      type: "object",
      properties: {
        companies: { type: "array", items: { type: "string" }, description: "Company names, short names or tickers, e.g. [\"Lynas\", \"Iluka\", \"ALB\"]. Omit if using peer_group." },
        peer_group: { type: "string", description: "Optional named peer group instead of a company list (Lithium, Rare earths, Rare earth producers, Uranium, Uranium producers, Platinum group metals, Diversified miners, Battery materials, Greenland-focused)." },
        metrics: {
          type: "array",
          items: { type: "string", enum: [...FINANCIAL_METRICS, "all"] },
          description: "Items to return (default revenue, operating_income, net_income, free_cash_flow, total_debt, total_equity). Margins and returns are fractions and are not converted.",
        },
        last_n: { type: "number", description: "Most recent N fiscal years per company (default 5, max 12). Ignored if fiscal_years is given." },
        fiscal_years: { type: "array", items: { type: "number" }, description: "Specific fiscal years (the calendar year in which the fiscal year ends)." },
        currency: { type: "string", enum: ["USD", "reported"], description: "USD (default) converts to US dollars; reported keeps each company's own currency." },
      },
      required: [],
    },
  },
  {
    name: "operating_data",
    description:
      "Operating figures taken from company annual reports, each with its source report and page: production and sales volumes, average realised prices, unit costs " +
      "(for example Lynas REO and NdPr volumes and prices, Cameco uranium production/sales/price/unit cost, Iluka zircon/rutile/ilmenite, Kazatomprom 100% vs attributable output, " +
      "Glencore copper/cobalt/zinc/nickel/coal output, Syrah graphite, MP Materials, Energy Fuels, Paladin, China Northern Rare Earth). USE THIS for questions about volumes, " +
      "realised prices, unit costs or what drove revenue and margins. Combine with company_financials for results. Coverage is partial; the tool says when nothing matches. " +
      "The user is shown the sources and a downloadable table (and a chart when comparable).",
    input_schema: {
      type: "object",
      properties: {
        companies: { type: "array", items: { type: "string" }, description: "Company names, short names or tickers. Omit to search all companies." },
        commodity: { type: "string", description: "Optional product or asset filter, e.g. NdPr, zircon, uranium, copper, graphite, Balama." },
        metrics: { type: "array", items: { type: "string", enum: OPERATING_METRIC_NAMES }, description: "Optional metric filter." },
        from_year: { type: "number" },
        to_year: { type: "number" },
      },
      required: [],
    },
  },
  {
    name: "peer_comparison",
    description:
      "Side-by-side snapshot of companies for the latest (or a chosen) fiscal year in US dollars: revenue, growth, margins, free-cash-flow margin, return on equity, leverage and net debt, " +
      "with each company's rank on every measure and the peer median. Use for 'how does X compare with its peers', 'who is most profitable', league tables. " +
      "Omit companies to compare every company that has at least five years of statements. The user is shown a downloadable table automatically.",
    input_schema: {
      type: "object",
      properties: {
        companies: { type: "array", items: { type: "string" }, description: "Optional company names, short names or tickers." },
        peer_group: { type: "string", description: "Optional named peer group instead of a company list: Lithium, Rare earths, Rare earth producers, Uranium, Uranium producers, Platinum group metals, Diversified miners, Battery materials, Greenland-focused." },
        fiscal_year: { type: "number", description: "Optional fiscal year to align everyone on; default is each company's latest year." },
      },
      required: [],
    },
  },
  {
    name: "price_history",
    description:
      "Commodity price history from the stored price series (World Bank and IMF monthly series, USGS annual prices). Finds the best-matching series for a commodity name, " +
      "returns summary statistics and yearly averages, and the user is shown a line chart and a downloadable data file automatically. " +
      "Use for 'how has the price of X moved', price levels in a given year, and price comparisons. To overlay several series, call once with series_ids " +
      "(take the ids from other_matching_series of an earlier call). Prices are in US dollars; read each series' unit.",
    input_schema: {
      type: "object",
      properties: {
        commodity: { type: "string", description: "Commodity name, e.g. copper, uranium, lithium carbonate, gold." },
        series_ids: { type: "array", items: { type: "number" }, description: "Specific series ids (up to 4, same unit) to chart together." },
        from_year: { type: "number" },
        to_year: { type: "number" },
      },
      required: [],
    },
  },
  {
    name: "price_sensitivity",
    description:
      "How far a company's results have moved with a commodity price over its stored fiscal years: fits revenue, EBITDA, operating profit, net income, free cash flow or a margin against the price, " +
      "and returns the strength of the fit (R-squared, p-value, a plain strong/moderate/weak label), the elasticity, and a what-if table for price moves of plus or minus 10% and 20%. " +
      "USE THIS for 'how sensitive is X to the price of Y', 'does Y's price drive X's earnings', 'which uranium/copper/PGM producer is most exposed to the price', and operating leverage questions. " +
      "Several companies can be compared on one commodity (a peer group works). Market prices exist as long monthly series (10+ years) for uranium, copper, aluminium, iron ore, nickel, zinc, cobalt, platinum, palladium, gold, silver and potash; " +
      "lithium, rare earths, graphite and zircon have only 2021-2025 annual market series, which is too short, so for those use price_source \"realised\" (the company's own reported average realised price: Lynas rare earth oxides, Iluka zircon and rutile, Cameco and Kazatomprom uranium, Syrah graphite). " +
      "This is a historical association, not a forecast. The user is shown a chart (price and results, each scaled 0-100) and a downloadable table automatically.",
    input_schema: {
      type: "object",
      properties: {
        companies: { type: "array", items: { type: "string" }, description: "Up to 6 company names, short names or tickers. Omit if using peer_group." },
        peer_group: { type: "string", description: "Optional named peer group instead of a company list (for example Uranium producers)." },
        commodity: { type: "string", description: "Commodity whose price to use (uranium, copper, platinum...). With price_source \"realised\" it picks which of the company's realised-price series (for example zircon, rutile, uranium, graphite, rare earth)." },
        price_source: { type: "string", enum: ["market", "realised"], description: "market (default): a benchmark price series. realised: the company's own average realised price from its annual reports." },
        series_id: { type: "number", description: "Optional specific market price series id (from price_history's other_matching_series)." },
        metric: { type: "string", enum: SENSITIVITY_METRICS, description: "Result to explain (default revenue). Margins are fractions." },
        lag_years: { type: "number", description: "Optional 0-2: compare results with the price of an earlier year (useful where sales are on long-term contracts, such as uranium). Default 0." },
        from_year: { type: "number" },
        to_year: { type: "number" },
      },
      required: [],
    },
  },
  {
    name: "investor_memo",
    description:
      "Opens a printable 2-page investor memo for a region and commodity, built only from stored data and the document library: the geochemical leads (with a map), the deposit-type signature of the enriched rocks, the catalogued occurrences, who holds the projects, " +
      "short quoted passages from the literature with their sources, price context where it exists, and a boxed list of what is not known. It can be printed to PDF or shared by a 30-day link from the page. " +
      "USE THIS when the user asks for a memo, brief, one-pager, write-up or summary document on a region or commodity opportunity to send on or present. Memos available: " +
      Object.values(MEMO_CASES).map((c) => `${c.id} (${c.title})`).join("; ") + ". If the region or commodity asked for is not one of these, say which memos exist and offer an analysis in the chat instead. " +
      "The result gives the link and the memo's own content (key points, leads, deposit-type signal, holders, project status, permitting and finance passages with sources, and what is not known): brief the user from it and add nothing that is not in it.",
    input_schema: {
      type: "object",
      properties: { memo: { type: "string", enum: Object.keys(MEMO_CASES), description: "Which memo." } },
      required: ["memo"],
    },
  },
  {
    name: "rank_leads",
    description:
      "A league table of the best UNEXPLORED geochemical leads for a commodity across ALL our geochemical surveys at once (Argentina, Greenland, Finland, Sweden, the USA, Victoria and Tasmania): " +
      "runs the anomaly screen on each survey and ranks the cells together by how unlikely their anomaly count is by chance within their own survey (raw ppm values are not comparable between surveys). " +
      "Only 'new lead' cells (no catalogued occurrence of any kind nearby) are ranked unless include_near_known is true. Shows the user a map (coloured by survey) and a table, " +
      "and says which surveys had data for the elements and which did not. USE THIS for 'where are the best new lithium / rare earth / cobalt / tungsten / copper leads across everything we have', " +
      "'which survey has the strongest unexplored anomalies for X', 'rank the leads'. For ONE region use find_geochemical_anomalies instead. " +
      "Give commodity (REE, LREE, HREE or PGE) or elements (symbols such as [\"li\"], [\"cu\",\"mo\"]). Coverage varies a lot by element: say which surveys were screened. Anomalies are not deposits.",
    input_schema: {
      type: "object",
      properties: {
        commodity: { type: "string", description: "Preset indicator: REE, LREE, HREE or PGE. Omit when using elements." },
        elements: { type: "array", items: { type: "string" }, description: "Element symbols to sum, e.g. [\"li\"], [\"w\"], [\"co\"]." },
        surveys: { type: "array", items: { type: "string" }, description: "Optional subset of surveys: ARGENTINA_SEGEMAR, GREENLAND_GEUS, FINLAND_GTK_ROCK, SWEDEN_SGU_LITHOGEOCHEMISTRY, USA_USGS_NGDB, AUSTRALIA_VIC_GSV_GEOCHEMISTRY, AUSTRALIA_TAS_MRT, CANADA_QC_SIGEOM, CANADA_QC_SIGEOM_SED, CANADA_SK_SGS, CANADA_NRCAN_CDOGS. Default all." },
        basis: { type: "string", description: "total, partial or any (default any: total-digestion value where there is one, otherwise the partial-leach value)." },
        percentile: { type: "number", description: "Anomaly threshold percentile within each sample type, 0.9 to 0.99, default 0.95." },
        top_n: { type: "number", description: "Leads in the table, default 12, max 25." },
        max_per_survey: { type: "number", description: "Most leads taken from any one survey so one survey does not fill the list, default 4." },
        include_near_known: { type: "boolean", description: "Also rank cells near catalogued occurrences (default false: new leads only)." },
      },
      required: [],
    },
  },
  {
    name: "deposit_fingerprint",
    description:
      "Which kinds of mineral deposit do a set of ROCK samples resemble in trace-element chemistry? Compares the samples (for example the rare-earth-rich rocks of an area, or the anomalous leads from the anomaly screen) with the chemistry of about 1,250 known deposits in 23 deposit groups " +
      "(porphyry, VMS, orogenic, epithermal, IOCG, skarn, carbonatite / peralkaline, pegmatite and others; Geoscience Australia / CMMI database), relative to the regional background of the same survey. " +
      "USE THIS for 'what kind of deposit does this lead look like', 'does this resemble a carbonatite / porphyry / VMS', 'what is the geochemical signature of these samples'. Works on rock and drill-core samples that have many elements analysed: Greenland (GEUS), Sweden (SGU), the USA (USGS), Finland (GTK), Tasmania (MRT), Québec (SIGÉOM) and Canada-wide federal surveys (GSC CDoGS, rock samples only); " +
      "not on stream sediments, lake sediments, till or soils (Argentina, Victoria, Saskatchewan and the Québec / CDoGS sediment data). Choose the area with bbox [west, south, east, north] and, to pick out the enriched samples of a lead, lead_filter {element, min_ppm} (for example La at least 300 ppm). " +
      "It shows the user a bar chart and a table (lead versus background) and gives the accuracy on known deposits. It is a screening aid, never proof: say the accuracy, the elements used and that types needing unmeasured elements cannot be separated.",
    input_schema: {
      type: "object",
      properties: {
        source_system: { type: "string", enum: ["GREENLAND_GEUS", "SWEDEN_SGU_LITHOGEOCHEMISTRY", "USA_USGS_NGDB", "FINLAND_GTK_ROCK", "AUSTRALIA_TAS_MRT", "CANADA_QC_SIGEOM", "CANADA_NRCAN_CDOGS"], description: "Which survey's rock samples to use." },
        bbox: { type: "array", items: { type: "number" }, description: "Optional area of the leads: [west, south, east, north] in decimal degrees." },
        lead_filter: {
          type: "object",
          properties: { element: { type: "string", description: "Element symbol, for example La, Zr, Cu, Zn." }, min_ppm: { type: "number", description: "Keep only samples with at least this many ppm (total-digestion value)." } },
          description: "Optional: select the enriched samples that make up the lead.",
        },
        background_bbox: { type: "array", items: { type: "number" }, description: "Optional area for the background rocks to compare with (default: the whole survey)." },
      },
      required: ["source_system"],
    },
  },
  {
    name: "assay_next",
    description:
      "Which extra element should be assayed next to tell apart the deposit types a lead could be? Starts from the deposit fingerprint of the lead (same inputs), takes the leading types (the three with the biggest difference from the regional background, or the types the user names), " +
      "and for each trace element NOT yet measured on the lead samples tests on the ~1,250 known reference deposits how much adding it would raise the confidence in the right type among those types, with and without it on the same deposits, with a range widened for the number of elements tried. " +
      "USE THIS for 'what should I assay next', 'which element would settle what kind of deposit this is', 'what should we add to the analysis package for these samples', 'which extra element would help most'. Works for the same rock surveys as deposit_fingerprint (Greenland GEUS, Sweden SGU, USA USGS, Finland GTK, Tasmania MRT, Québec SIGÉOM, CDoGS rock). " +
      "Shows a bar chart and table. A gain whose range includes zero is not a recommendation: if none is clear, say so plainly. These are single-element additions on reference deposits, not costs or lab methods, and not proof that the lead is any of the types.",
    input_schema: {
      type: "object",
      properties: {
        source_system: { type: "string", enum: ["GREENLAND_GEUS", "SWEDEN_SGU_LITHOGEOCHEMISTRY", "USA_USGS_NGDB", "FINLAND_GTK_ROCK", "AUSTRALIA_TAS_MRT", "CANADA_QC_SIGEOM", "CANADA_NRCAN_CDOGS"], description: "Which survey's rock samples to use." },
        bbox: { type: "array", items: { type: "number" }, description: "Optional area of the leads: [west, south, east, north] in decimal degrees." },
        lead_filter: {
          type: "object",
          properties: { element: { type: "string", description: "Element symbol, for example La, Zr, Cu, Zn." }, min_ppm: { type: "number", description: "Keep only samples with at least this many ppm (total-digestion value)." } },
          description: "Optional: select the enriched samples that make up the lead.",
        },
        background_bbox: { type: "array", items: { type: "number" }, description: "Optional area for the background rocks (default: the whole survey)." },
        types: { type: "array", items: { type: "string" }, description: "Optional: two to four deposit type names (as shown by deposit_fingerprint) to tell apart. Default: the top three for the lead." },
      },
      required: ["source_system"],
    },
  },
  {
    name: "price_outlook",
    description:
      "A tested RANGE around the latest monthly price of a commodity, 1, 3, 6 and 12 months ahead, for uranium, cobalt, palladium, platinum, gold, silver, copper, nickel, tin, zinc, lead, aluminium, iron ore, phosphate rock and potash. " +
      "USE THIS for 'what will the X price be', 'where is X heading', 'how high / low could X go', 'forecast X', 'will X go up' and any question about future commodity prices, BEFORE you decline: it gives the figures to put beside the decline. " +
      "It is not a forecast: the range is centred on the latest price (no change) and says nothing about direction, because in a pre-registered back-test (selection 2005-2015, test 2016 onward) no tested model beat 'no change' at any horizon. " +
      "Report the latest price and month, the 50% and 80% ranges, and that about half and about four in five of past outcomes fell inside them; never present a bound as a target or prediction. Lithium, rare earths, graphite and other minerals without a monthly series return a message saying so: say there is no tested range and do not estimate one.",
    input_schema: {
      type: "object",
      properties: { commodity: { type: "string", description: "Commodity name, for example copper, cobalt, uranium, nickel, gold, iron ore." } },
      required: ["commodity"],
    },
  },
  {
    name: "supply_concentration",
    description:
      "How concentrated the world supply of a critical mineral is, by country and stage: mine production, refinery or smelter production, capacity and reserves, from the USGS Mineral Commodity Summaries 2026 (loaded into the database and checked against the published tables). " +
      "Gives the largest producers with their share, the top-three share and the HHI, how much of the world the named countries cover, and what USGS withheld. " +
      "USE THIS for 'who dominates cobalt / lithium / graphite / rare earth production', 'what share of X does China produce or refine', 'which critical minerals are most concentrated', 'where are the reserves', 'is mining or refining more concentrated'. " +
      "With a commodity it shows the stages USGS publishes for it; without one it ranks the critical minerals by concentration at one stage (default mine production, 2025 estimate). " +
      "Only stages in the USGS tables exist: if a stage is not returned (for example lithium refining), say there is no figure and do not quote one. These are estimates of where material is produced, not who owns it, and say nothing about causes or risk. " +
      "Boron, silicon and scandium are not available.",
    input_schema: {
      type: "object",
      properties: {
        commodity: { type: "string", description: "Commodity, for example cobalt, lithium, rare earths, graphite, nickel, copper, tungsten, gallium, PGM. Omit for the league table across all critical minerals." },
        stage: { type: "string", enum: ["mine_production", "refinery_production", "smelter_production", "primary_production", "sponge_production", "production", "capacity", "reserves"], description: "Optional: one stage only. For the league table the default is mine_production." },
        year: { type: "number", description: "2025 (USGS estimate, default) or 2024 (latest reported). Reserves are 2025 only." },
        rank_by: { type: "string", enum: ["top_share", "hhi"], description: "League table only: rank by the largest country's share (default) or by HHI." },
        top_n: { type: "number", description: "League table rows, default 12, max 20." },
      },
      required: [],
    },
  },
  {
    name: "company_assets",
    description:
      "A company's mines, plants and projects with the company's ownership interest in each (from its annual report), plus a map of those that have a position. " +
      "Each asset comes with its type and stage (producing, development, exploration, care and maintenance), so it also answers 'which of X's projects are in development'. " +
      "USE THIS for 'where are X's mines', 'what does X own and what share', 'which of X's projects are at what stage', 'show X's assets on a map', and to compare the assets of several companies or a peer group. " +
      "Ownership has been loaded for Glencore, Rio Tinto, South32, Cameco, Kazatomprom, Energy Fuels, Paladin, Iluka, Lynas, MP Materials, Syrah and a few Greenland and Australian developers; " +
      "not for Albemarle, SQM, Impala, Sibanye, Umicore, China Northern, Boss or smaller explorers. About a third of the assets can be placed on a map because only those are matched to the occurrence catalogue; " +
      "the result says how many could not be placed (smelters, refineries and many in-situ uranium operations are mostly not in the catalogue). It gives no output or size figures.",
    input_schema: {
      type: "object",
      properties: {
        companies: { type: "array", items: { type: "string" }, description: "Up to 6 company names, short names or tickers. Omit if using peer_group." },
        peer_group: { type: "string", description: "Optional named peer group instead of a company list (for example Diversified miners, Uranium producers)." },
        commodity: { type: "string", description: "Optional filter on the asset's main commodity or name, for example copper, uranium, aluminium." },
      },
      required: [],
    },
  },
  {
    name: "run_sql",
    description:
      "Run a read-only SELECT query against the interzona_cm database (core/geochem/docs/financials/markets schemas). " +
      "Only SELECT statements are permitted; results are capped at 200 rows.",
    input_schema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "A single SELECT statement." },
      },
      required: ["sql"],
    },
  },
  {
    name: "search_documents",
    description:
      "Hybrid vector + full-text search over ingested documents (reports, filings, investor decks). " +
      "Use for narrative/literature questions rather than structured data questions. " +
      "Results are balanced across documents (at most max_per_document chunks per document, default 2, among " +
      "comparably relevant matches) so one large report cannot crowd out others. For questions that compare or " +
      "synthesise ACROSS sources use result_limit 8-10 with the default. For a deep dive into ONE named document, " +
      "set max_per_document to 8 or more (or 0 for no cap). Each result is the best part of a longer passage, marked [\u2026] where it is cut: if what you need may continue past a cut, call read_document with the result's chunk_id.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language search query." },
        domain: {
          type: "string",
          description: "Optional filter: POLICY, SUPPLY_CHAIN, TECHNOLOGY, TECHNICAL_REPORT, ANNUAL_REPORT, RESEARCH, or NEWS.",
        },
        result_limit: { type: "number", description: "Max results to return (default 5)." },
        max_per_document: {
          type: "number",
          description: "Max chunks returned from any single document (default 2; 0 = no cap).",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "read_document",
    description:
      "Reads the FULL text of one passage of a document, and optionally the passage after it (or before it), using the chunk_id that search_documents returned. " +
      "search_documents shows only the best part of each passage and marks a cut with [\u2026]. USE THIS whenever the text you need (a list, a definition, a table, a number, the end of a sentence that introduces one) may sit just past a [\u2026] or at the edge of an excerpt: " +
      "read on before answering. Never tell the user that an excerpt was cut off or that the retrieval was limited: read the rest, and if the document still does not say it, say the document does not state it.",
    input_schema: {
      type: "object",
      properties: {
        chunk_id: { type: "number", description: "The chunk_id from a search_documents result." },
        include_next: { type: "boolean", description: "Also return the following passage (default true)." },
        include_previous: { type: "boolean", description: "Also return the preceding passage (default false)." },
      },
      required: ["chunk_id"],
    },
  },
  {
    name: "run_geochem_analysis",
    description:
      "Run a vetted geochemical analysis script in a sandboxed environment, against a set of " +
      "samples YOU resolve first (via run_sql) â€” not tied to a single occurrence. This is how you " +
      "answer questions like 'find LCT pegmatite occurrences in Argentina and analyze their " +
      "geochemistry': first run_sql to find the matching occurrence_ids/sample_ids, then pass the " +
      "combined sample_ids list here. Available scripts: " +
      listRegisteredScripts("geochem")
        .map((s) => `"${s.name}" â€” ${s.description}`)
        .join("; ") +
      ". This does NOT execute arbitrary code â€” only these specific, reviewed scripts.",
    input_schema: {
      type: "object",
      properties: {
        script: { type: "string", description: "Name of the registered script to run." },
        sample_ids: {
          type: "array",
          items: { type: "number" },
          description:
            "The sample_ids to analyze â€” required for every script EXCEPT lineament_network_stats " +
            "and lineament_rose_diagram, and EXCEPT halley_plots, which can instead select a whole dataset itself " +
            "(source_system, lithology_category, bounding box). Resolve these yourself first via run_sql (e.g. 'SELECT " +
            "sample_id FROM geochem.samples s JOIN core.occurrences o ON o.occurrence_id = " +
            "s.occurrence_id WHERE o.occurrence_type_name = ...'). Can span one occurrence or many â€” " +
            "a combined selection across multiple occurrences works the same way as a single one.",
        },
        occurrence_id: {
          type: "number",
          description:
            "Required ONLY for lineament_network_stats and lineament_rose_diagram, which search a " +
            "radius around one point and so need a single location, not a sample set. Not used by " +
            "any other script.",
        },
        label: {
          type: "string",
          description:
            "Optional free-text label for what this selection represents (e.g. 'LCT pegmatite " +
            "occurrences, Argentina' or 'stream-sediment samples, Greenland'), used in plot titles " +
            "instead of a bare occurrence number. Supply this whenever sample_ids spans more than " +
            "one occurrence, or whenever the user wouldn't recognize a single occurrence_id anyway.",
        },
        reference: {
          type: "string",
          description: "Optional reference composition for normalization scripts (REE/extended spider plots â€” default varies by script).",
        },
        radius_km: {
          type: "number",
          description: "Optional search radius in km for lineament scripts (default 50).",
        },
        top_n: {
          type: "number",
          description: "Optional number of top results for clr_correlation_analysis (default 10).",
        },
        figure: {
          type: "string",
          enum: ["sc_vs", "v_sc", "sr_y", "sc_ni_cu", "hf_zr", "ti_nb", "ta_nb_ti", "k_al_na_al", "ca_k_na", "al_k_mg", "rb_k", "ca_mg", "ca_fe_mg", "fe_s", "ca_fe_s"],
          description: "halley_plots only: which figure to draw (one per call). Default sc_vs.",
        },
        source_system: {
          type: "string",
          description:
            "halley_plots only: select the samples by dataset instead of listing sample_ids (FINLAND_GTK_ROCK, GREENLAND_GEUS, " +
            "USA_USGS_NGDB, SWEDEN_SGU_LITHOGEOCHEMISTRY, AUSTRALIA_TAS_MRT, CANADA_QC_SIGEOM, CANADA_NRCAN_CDOGS; only their rock and drill samples are used. " +
            "ARGENTINA_SEGEMAR, AUSTRALIA_VIC_GSV_GEOCHEMISTRY, CANADA_SK_SGS and CANADA_QC_SIGEOM_SED are sediments and soils with no rock data it can use).",
        },
        lithology_category: {
          type: "string",
          description: "halley_plots only: optionally restrict to one lithology category, e.g. IGNEOUS_INTRUSIVE, IGNEOUS_EXTRUSIVE, METAMORPHIC_FOLIATED, SEDIMENTARY_CLASTIC.",
        },
        min_lon: { type: "number", description: "halley_plots only: bounding box west edge (decimal degrees); give all four edges or none." },
        min_lat: { type: "number", description: "halley_plots only: bounding box south edge." },
        max_lon: { type: "number", description: "halley_plots only: bounding box east edge." },
        max_lat: { type: "number", description: "halley_plots only: bounding box north edge." },
        max_samples: {
          type: "number",
          description: "halley_plots only: cap on samples plotted (default 30,000; larger selections are thinned evenly and the summary says so).",
        },
      },
      required: ["script"],
    },
  },
  {
    name: "find_geochemical_anomalies",
    description:
      "THE tool for exploration-targeting questions ('where should I explore for X in Y?', 'what is prospective for X?', 'any new targets?'): " +
      "it screens the sample geochemistry itself for anomalies, in one call, instead of starting from known deposits. For the chosen " +
      "indicator (a preset such as REE/LREE/HREE/PGE, or any element symbols summed) it takes a percentile threshold separately for each " +
      "sample type, bins the anomalous samples to a grid, and for every cell reports samples analysed, anomalous count, maximum, sample types, " +
      "the top sample_ids (pass them to run_geochem_analysis), the nearest catalogued occurrence of that commodity and of ANY kind, " +
      "and a group: NEW_LEAD (nothing catalogued nearby), NEAR_OTHER_OCCURRENCE, or NEAR_KNOWN_COMMODITY (the data see a known system). " +
      "Also returns coverage by sample type. Needs a region: source_system (ARGENTINA_SEGEMAR, GREENLAND_GEUS, FINLAND_GTK_ROCK, " +
      "SWEDEN_SGU_LITHOGEOCHEMISTRY, USA_USGS_NGDB, AUSTRALIA_VIC_GSV_GEOCHEMISTRY, AUSTRALIA_TAS_MRT, CANADA_QC_SIGEOM, CANADA_QC_SIGEOM_SED, CANADA_SK_SGS, CANADA_NRCAN_CDOGS) and/or a bbox. Non-oxide elements only, in ppm. Drill-hole assays are left out unless include_drill_samples is true. " +
      "Lead your answer with the NEW_LEAD cells, then confirmation near known deposits; say how many samples have the data.",
    input_schema: {
      type: "object",
      properties: {
        commodity: { type: "string", description: "Preset indicator: REE, LREE, HREE or PGE. Omit when using elements." },
        elements: {
          type: "array",
          items: { type: "string" },
          description: "Element symbols to sum, e.g. [\"li\"], [\"cu\",\"mo\"], [\"w\"]. Used when no preset fits.",
        },
        source_system: { type: "string", description: "Dataset/region, e.g. GREENLAND_GEUS." },
        bbox: { type: "array", items: { type: "number" }, description: "Optional [west, south, east, north] in degrees." },
        basis: { type: "string", description: "total (default), partial (aqua-regia/leach columns) or any." },
        percentile: { type: "number", description: "Anomaly threshold percentile within each sample type, default 0.95." },
        grid_deg: { type: "number", description: "Cell size in degrees, default 0.25." },
        min_anomalous: { type: "number", description: "Minimum anomalous samples for a cell to be reported, default 3." },
        min_elements: { type: "number", description: "Elements that must have been analysed for a sample to count, default 60% of the list." },
        sample_type_contains: { type: "array", items: { type: "string" }, description: "Optional filter on sample type names, e.g. [\"stream\"] or [\"rock\"]." },
        include_drill_samples: { type: "boolean", description: "Include drill-hole assays (default false: they come from known mineralised zones and would swamp a new-leads screen; set true only when the user asks about drill results)." },
        occurrence_commodity_pattern: { type: "string", description: "Optional regex over core.occurrences.commodities to define 'known occurrence of this commodity'; presets and element lists have sensible defaults." },
        near_km: { type: "number", description: "Distance counted as 'near' a catalogued occurrence, default 15 km." },
        limit: { type: "number", description: "Cells returned, default 15, max 40." },
      },
      required: [],
    },
  },
  {
    name: "run_financial_model",
    description:
      "Run a vetted project-economics financial model in a sandboxed environment, given assumptions YOU or the user supply directly â€” this schema has NO mine-plan/capex/opex/project-economics data anywhere (financials.* is company-level statements only), so nothing here is looked up from the database. NEVER invent plausible-sounding numbers (tons, grades, prices, costs) yourself â€” ask the user for real assumptions, or use numbers explicitly sourced from search_documents/web_search and cite them. Available scripts: " +
      listRegisteredScripts("financial")
        .map((s) => `"${s.name}" â€” ${s.description}`)
        .join("; ") +
      ".",
    input_schema: {
      type: "object",
      properties: {
        script: { type: "string", description: "Name of the registered financial model script." },
        assumptions: {
          type: "object",
          description:
            "Annual assumptions, all dollar fields in the SAME currency scale (e.g. all $ million, or all raw $). Required: recovered_units_annual (array, one entry per year), price_per_unit (number or array matching length), operating_costs_annual (array), capex_annual (array), tax_rate (0-1), discount_rate (0-1). Optional: royalty_pct (0-1, default 0), refining_cost_per_unit (default 0), commodity_name, commodity_unit (labels only).",
        },
        label: { type: "string", description: "Optional label for the scenario, used in the chart title." },
      },
      required: ["script", "assumptions"],
    },
  },
];

type GeneratedImage = { mimeType: string; base64: string; caption: string };

type ToolContent = string | Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam>;

// Shared by every tool that can return a sandbox-rendered plot: hands the image to the frontend
// for display, AND sends it back to Claude as a real image content block (Claude is multimodal â€”
// it can actually see this), plus whatever numeric summary the script printed before plt.show().
// Both together let the model give a real interpretation grounded in exact numbers, not a vague
// visual guess.
function handlePlotResult(
  result: { mimeType: "image/png"; base64: string; summary: string },
  scriptName: string,
  captionTarget: string,
  collectedImages: GeneratedImage[]
): ToolContent {
  collectedImages.push({
    mimeType: result.mimeType,
    base64: result.base64,
    caption: `${scriptName} for ${captionTarget}`,
  });
  const summaryText = result.summary
    ? `Computed values behind this plot:\n${result.summary}`
    : "(Script printed no numeric summary.)";
  return [
    { type: "image", source: { type: "base64", media_type: result.mimeType, data: result.base64 } },
    {
      type: "text",
      text: `The image above is the actual rendered plot from "${scriptName}" â€” look at it directly and describe what it shows. ${summaryText}`,
    },
  ];
}

// Keeps what goes back into the conversation small: every token of a tool result is re-read on each later step of the
// question, so long text fields are shortened and the whole result is capped.
const MAX_CELL_CHARS = 700;
const MAX_RESULT_CHARS = 45_000;

function trimRows(rows: Record<string, unknown>[]): { rows: Record<string, unknown>[]; shortened: boolean } {
  let shortened = false;
  const out = rows.map((r) => {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
      if (typeof v === "string" && v.length > MAX_CELL_CHARS) {
        o[k] = v.slice(0, MAX_CELL_CHARS) + "… [shortened]";
        shortened = true;
      } else o[k] = v;
    }
    return o;
  });
  return { rows: out, shortened };
}

function capJson(obj: { rows: unknown[] } & Record<string, unknown>): string {
  let json = JSON.stringify(obj);
  if (json.length <= MAX_RESULT_CHARS) return json;
  // Drop rows from the end until it fits, and say so.
  const rows = [...obj.rows];
  while (rows.length > 1 && JSON.stringify({ ...obj, rows }).length > MAX_RESULT_CHARS) rows.length = Math.ceil(rows.length * 0.8);
  json = JSON.stringify({ ...obj, rows, rowCount: rows.length, truncated: true, note: "Result cut to the first rows to keep it short; narrow the query (filters, fewer columns, aggregate) to see the rest." });
  return json;
}

// Chunks average ~5,600 characters. Return the part of each chunk that best matches the query rather than all of it.
// The cut is moved to the end of the sentence, and on through a list or quotation the sentence introduces (a colon or an open quotation mark),
// so a definition is not left hanging just before the thing it defines.
function snapEnd(content: string, end: number): number {
  if (end >= content.length) return content.length;
  const sentenceEnd = (from: number, limit: number) => {
    const m = /[.!?]["\u201d)]?\s/.exec(content.slice(from, Math.min(content.length, limit)));
    return m ? from + m.index + m[0].length : Math.min(content.length, limit);
  };
  let e = sentenceEnd(end, end + 700);
  const before = content.slice(0, e - 1);
  const lastStart = Math.max(before.lastIndexOf(". "), before.lastIndexOf("? "), before.lastIndexOf("! "), before.lastIndexOf("\n"), 0);
  const last = content.slice(lastStart, e);
  const opens = (last.match(/\u201c/g) ?? []).length;
  const closes = (last.match(/\u201d/g) ?? []).length;
  if (/:\s*$/.test(last.trim()) || opens > closes) e = sentenceEnd(e, e + 1200);
  return e;
}
const EXCERPT_CHARS = 3000;
function excerptFor(content: string, query: string): string {
  if (content.length <= EXCERPT_CHARS + 400) return content;
  const terms = Array.from(new Set(query.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []));
  const lower = content.toLowerCase();
  let best = 0;
  let bestScore = -1;
  // Score = distinct query terms in the window, ties broken by how often they occur, so the window settles where the terms cluster
  // (with distinct terms alone, the first of many tying windows won - e.g. a reference list full of 'porphyry' ahead of the passage itself).
  for (let start = 0; start + EXCERPT_CHARS <= content.length + 400; start += 300) {
    const win = lower.slice(start, start + EXCERPT_CHARS);
    let score = 0;
    for (const t of terms) {
      const n = win.split(t).length - 1;
      if (n > 0) score += 1000 + Math.min(n, 50);
    }
    if (score > bestScore) {
      bestScore = score;
      best = start;
    }
  }
  let start = best;
  if (start > 0) {
    // begin at a sentence start, not in the middle of a word or sentence
    const back = content.slice(Math.max(0, start - 250), start);
    const m = [...back.matchAll(/[.!?]["\u201d)]?\s+/g)].pop();
    if (m && m.index !== undefined) start = Math.max(0, start - 250) + m.index + m[0].length;
  }
  const end = snapEnd(content, Math.min(best + EXCERPT_CHARS, content.length));
  return (start > 0 ? "[…] " : "") + content.slice(start, end) + (end < content.length ? " […]" : "");
}

async function executeTool(
  name: string,
  input: Record<string, unknown>,
  collectedImages: GeneratedImage[],
  loadedTopics: Set<TopicId>,
  extras: { evidence: Evidence[]; datasets: Dataset[]; maps: MapData[] }
): Promise<ToolContent> {
  if (name === "investor_memo") {
    const id = String(input.memo ?? "");
    if (!MEMO_CASES[id]) return JSON.stringify({ found: false, available: Object.values(MEMO_CASES).map((c) => ({ id: c.id, title: c.title })) });
    const memo = await getMemo(id);
    extras.evidence.push({ kind: "data", label: `Investor memo, ${memo.title}`, detail: `built ${memo.generated} from stored data and the document library` });
    return JSON.stringify({
      found: true,
      link: `/memo/${id}`,
      title: memo.title,
      built: memo.generated,
      key_points: memo.keyPoints,
      top_leads: (memo.leads?.rows ?? []).slice(0, 4).map((r) => ({ area: r.area, anomalous: r.anomalous, analysed: r.analysed, highest_ppm: r.highest, nearest_occurrence: r.nearest ? `${r.nearest}, ${r.km} km` : null })),
      deposit_type_signal: memo.fingerprint ? { filter: memo.fingerprint.filter, ranked: memo.fingerprint.ranked.slice(0, 3).map((x) => ({ type: x.type, lead_pct: x.lead, background_pct: x.background })), accuracy_first_guess_pct: Math.round(memo.fingerprint.accuracy.first) } : (memo.fingerprintNote ?? null),
      occurrences: memo.occurrences ? { total: memo.occurrences.total, by_status: memo.occurrences.byStatus } : null,
      holders: memo.holders ? memo.holders.rows.map((r) => ({ asset: r.asset, company: r.company, interest_pct: r.interest, stage: r.status })) : null,
      project_status_permitting_finance: (memo.context ?? []).map((t) => ({ topic: t.topic, passages: t.items.map((i) => ({ source: i.title + (i.page ? `, p. ${i.page}` : ""), quote: i.excerpt })) })),
      geology_literature: memo.literature.flatMap((l) => l.items).slice(0, 4).map((i) => ({ source: i.title + (i.page ? `, p. ${i.page}` : ""), quote: i.excerpt })),
      not_known: memo.unknowns,
      note: "Give the user the link as a markdown link, then a short briefing from the content in this result: the leads, the deposit-type signal, who holds the projects, and the project status, permitting and finance passages (each with its source and the date shown in its title; say when they are old or the sources disagree). Everything in this result is the memo's own content, so you may describe it, but you have not seen the page layout. Say it can be printed to PDF or shared with a 30-day link from the page. Add the not-known list. Never add figures or claims that are not in this result.",
    });
  }
  if (name === "rank_leads") {
    const out = await rankLeads(input);
    extras.evidence.push(...(out.evidence ?? []));
    extras.datasets.push(...(out.datasets ?? []));
    extras.maps.push(...(out.maps ?? []));
    return out.content;
  }
  if (name === "price_outlook") {
    const out = await priceOutlook(input);
    extras.evidence.push(...(out.evidence ?? []));
    extras.datasets.push(...(out.datasets ?? []));
    return out.content;
  }
  if (name === "supply_concentration") {
    const out = await supplyConcentration(input);
    extras.evidence.push(...(out.evidence ?? []));
    extras.datasets.push(...(out.datasets ?? []));
    return out.content;
  }
  if (name === "assay_next") {
    const out = await assayNext(input);
    extras.evidence.push(...(out.evidence ?? []));
    extras.datasets.push(...(out.datasets ?? []));
    return out.content;
  }
  if (name === "deposit_fingerprint") {
    const out = await depositFingerprint(input);
    extras.evidence.push(...(out.evidence ?? []));
    extras.datasets.push(...(out.datasets ?? []));
    return out.content;
  }
  if (name === "company_assets") {
    const out = await companyAssets(input);
    extras.evidence.push(...(out.evidence ?? []));
    extras.maps.push(...(out.maps ?? []));
    return out.content;
  }
  if (name === "company_financials" || name === "peer_comparison" || name === "price_history" || name === "operating_data" || name === "price_sensitivity") {
    const out =
      name === "company_financials"
        ? await companyFinancials(input)
        : name === "peer_comparison"
          ? await peerComparison(input)
          : name === "operating_data"
            ? await operatingData(input)
            : name === "price_sensitivity"
              ? await priceSensitivity(input)
              : await priceHistory(input);
    extras.evidence.push(...(out.evidence ?? []));
    extras.datasets.push(...(out.datasets ?? []));
    return out.content;
  }
  if (name === "get_reference_notes") {
    const wanted = (Array.isArray(input.topics) ? input.topics : []).filter((t): t is TopicId => TOPIC_IDS.includes(t as TopicId));
    if (wanted.length === 0) throw new Error("Name at least one subject.");
    const parts: string[] = [];
    for (const t of wanted) {
      if (loadedTopics.has(t)) parts.push(`(${t}: already loaded above.)`);
      else {
        loadedTopics.add(t);
        parts.push(REFERENCE_NOTES[t]);
      }
    }
    return parts.join("\n\n");
  }
  if (name === "run_sql") {
    const result = await runReadOnlyQuery(input.sql as string);
    // Licence limit (src/lib/licence.ts): individual Greenland (GEUS) samples are cut to a short list before anything is shown, mapped or offered for download.
    const limited = await limitRestrictedRows(String(input.sql ?? ""), result.rows as Record<string, unknown>[]);
    const t = trimRows(limited.rows);
    const map = mapFromRows(limited.rows);
    if (map) extras.maps.push(map);
    return capJson({ ...result, rows: t.rows, ...(limited.note ? { licence_note: limited.note } : {}) });
  }
  if (name === "search_documents") {
    const embedding = await embedQuery(input.query as string);
    const vec = toVectorLiteral(embedding);
    const domain = (input.domain as string) || null;
    const limit = Math.min(Math.max(Math.floor((input.result_limit as number) || 5), 1), 25);
    const rawCap = input.max_per_document;
    const maxPerDoc =
      typeof rawCap === "number" && Number.isFinite(rawCap) ? Math.min(Math.max(Math.floor(rawCap), 0), 50) : 2;
    const { rows } = await runReadOnlyQuery(
      `SELECT chunk_id, document_id, domain, page_number,
              (SELECT title FROM docs.documents d WHERE d.document_id = c.document_id) AS title,
              content
       FROM docs.hybrid_search(
         ${escapeSqlString(input.query as string)},
         '${vec}'::vector,
         ${domain ? escapeSqlString(domain) : "NULL"},
         NULL, NULL, NULL, NULL, NULL,
         ARRAY['DISCLAIMER','TABLE_OF_CONTENTS','GLOSSARY','LEGAL','HEADER_FOOTER','REFERENCES']::varchar[],
         150, ${limit}, ${maxPerDoc}
       ) c`,
      limit
    );
    const q = input.query as string;
    return JSON.stringify(rows.map((r) => ({ ...r, content: excerptFor(String(r.content ?? ""), q) })));
  }
  if (name === "read_document") {
    const id = Math.floor(Number(input.chunk_id));
    if (!Number.isFinite(id) || id < 1) return JSON.stringify({ error: "chunk_id must be a number from a search_documents result." });
    const next = input.include_next !== false;
    const prev = input.include_previous === true;
    const { rows } = await runReadOnlyQuery(
      `SELECT c.chunk_id, c.document_id, c.page_number, c.chunk_index, c.content,
              (SELECT title FROM docs.documents d WHERE d.document_id = c.document_id) AS title
       FROM docs.document_chunks c
       WHERE c.document_id = (SELECT document_id FROM docs.document_chunks WHERE chunk_id = ${id})
         AND c.chunk_index BETWEEN (SELECT chunk_index FROM docs.document_chunks WHERE chunk_id = ${id}) - ${prev ? 1 : 0}
                               AND (SELECT chunk_index FROM docs.document_chunks WHERE chunk_id = ${id}) + ${next ? 1 : 0}
       ORDER BY c.chunk_index`,
      3
    );
    if (rows.length === 0) return JSON.stringify({ error: "No passage with that chunk_id." });
    return JSON.stringify(rows.map((r) => ({ chunk_id: r.chunk_id, document_id: r.document_id, title: r.title, page_number: r.page_number, content: String(r.content ?? "").slice(0, 9000) })));
  }
  if (name === "run_geochem_analysis") {
    const options: Record<string, string | number> = {};
    if (input.reference) options.reference = input.reference as string;
    if (input.radius_km) options.radius_km = input.radius_km as number;
    if (input.top_n) options.top_n = input.top_n as number;
    // halley_plots selects its own samples from these filters (regional runs would need thousands of sample_ids otherwise).
    for (const k of ["figure", "source_system", "lithology_category"] as const) {
      if (typeof input[k] === "string" && input[k]) options[k] = input[k] as string;
    }
    for (const k of ["min_lon", "min_lat", "max_lon", "max_lat", "max_samples"] as const) {
      if (typeof input[k] === "number" && Number.isFinite(input[k] as number)) options[k] = input[k] as number;
    }
    if (input.script === "halley_plots" && options.max_samples === undefined) options.max_samples = 30000;
    const label = input.label as string | undefined;
    const sampleIds = input.sample_ids as number[] | undefined;
    const occurrenceId = input.occurrence_id as number | undefined;
    const hasFilter = options.source_system !== undefined || options.min_lon !== undefined;
    if (!sampleIds && occurrenceId === undefined && !hasFilter) {
      throw new Error("run_geochem_analysis needs sample_ids, an occurrence_id, or (halley_plots only) a source_system or bounding box.");
    }
    const selection = sampleIds ? { sampleIds } : occurrenceId !== undefined ? { occurrenceId } : {};
    const result = await runAnalyticsScript(input.script as string, selection, options, label);
    if (result.kind === "json") {
      return JSON.stringify(result.data);
    }
    const captionTarget = label ?? (sampleIds ? `${sampleIds.length} samples` : occurrenceId !== undefined ? `occurrence ${occurrenceId}` : "the selected region");
    return handlePlotResult(result, input.script as string, captionTarget, collectedImages);
  }
  if (name === "find_geochemical_anomalies") {
    const result = await findGeochemicalAnomalies(input as AnomalyParams);
    const map = mapFromAnomalies(result as Parameters<typeof mapFromAnomalies>[0]);
    if (map) extras.maps.push(map);
    return JSON.stringify(result);
  }
  if (name === "run_financial_model") {
    const label = input.label as string | undefined;
    const assumptions = input.assumptions as Record<string, unknown> | undefined;
    if (!assumptions) {
      throw new Error("run_financial_model needs an assumptions object.");
    }
    const result = await runAnalyticsScript(input.script as string, { assumptions }, {}, label);
    if (result.kind === "json") {
      return JSON.stringify(result.data);
    }
    const captionTarget = label ?? "financial scenario";
    return handlePlotResult(result, input.script as string, captionTarget, collectedImages);
  }
  throw new Error(`Unknown tool: ${name}`);
}

function escapeSqlString(s: string) {
  return `'${s.replace(/'/g, "''")}'`;
}

// Prompt caching: the tools + core instructions and the growing conversation are identical from one turn of a question to
// the next, so mark them cacheable. The system block breakpoint covers tools + system; the second breakpoint sits on the last block of
// the conversation so each later turn only pays full price for what is new.
// The core instructions never change, so they cache across every question; the notes block depends on the subjects selected for the
// question and gets its own breakpoint.
function systemBlocks(topics: TopicId[]): Anthropic.TextBlockParam[] {
  return [
    { type: "text", text: CORE_PROMPT, cache_control: { type: "ephemeral" } },
    { type: "text", text: notesBlock(topics), cache_control: { type: "ephemeral" } },
  ];
}

function withTrailingCacheBreakpoint(conversation: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const last = conversation[conversation.length - 1];
  if (!last || last.role !== "user") return conversation;
  const blocks: Anthropic.ContentBlockParam[] =
    typeof last.content === "string" ? [{ type: "text", text: last.content }] : [...last.content];
  if (blocks.length === 0) return conversation;
  const tail = blocks[blocks.length - 1];
  if (tail.type === "text" || tail.type === "tool_result") {
    blocks[blocks.length - 1] = { ...tail, cache_control: { type: "ephemeral" } };
  }
  return [...conversation.slice(0, -1), { role: "user", content: blocks }];
}


// ---- Streaming protocol --------------------------------------------------------------------------------------------
// The response is newline-delimited JSON. The browser shows friendly step labels only: tool names, table names and
// SQL never leave the server (see the plain-language rule at the top of SCHEMA_CONTEXT).
type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "turn_end"; final: boolean }
  | { type: "step_start"; id: string; label: string }
  | { type: "step_end"; id: string; ok: boolean; ms: number }
  | { type: "image"; image: GeneratedImage }
  | { type: "evidence"; items: Evidence[] }
  | { type: "dataset"; dataset: Dataset }
  | { type: "map"; map: MapData }
  | { type: "notice"; message: string }
  | { type: "error"; message: string }
  | { type: "usage"; turns: number; input: number; cache_read: number; cache_write: number; output: number; ms: number; models: string[]; tools: string[]; effort: string; topics: string[] }
  | { type: "answer"; id: string }
  | { type: "done" };

// What an answer was based on, in plain language for the "Sources" panel: documents (with page where known), web pages, and
// the kinds of data consulted. Built from what the tools actually returned, not from the model's own account.
function dataLabelForSql(sql: string): string {
  if (/markets\.fx_rates/.test(sql)) return "Exchange rates (Bank for International Settlements)";
  if (/markets\./.test(sql)) return "Commodity prices (World Bank, IMF and USGS)";
  if (/financials\./.test(sql)) return "Company financial statements (filings and annual reports)";
  if (/docs\./.test(sql)) return "Document library";
  if (/geochem\./.test(sql)) return "Sample geochemistry (national geological survey datasets)";
  if (/occurrence/.test(sql)) return "Mineral occurrence catalogue (USGS and national surveys)";
  return "Database records";
}

async function evidenceFor(name: string, input: Record<string, unknown>, result: ToolContent): Promise<Evidence[]> {
  const out: Evidence[] = [];
  const text = typeof result === "string" ? result : "";
  try {
    if (name === "run_sql") {
      const parsed = JSON.parse(text) as { rows?: Record<string, unknown>[]; rowCount?: number };
      const rows = parsed.rows ?? [];
      const sqlText = String(input.sql ?? "").toLowerCase();
      const credits = /geochem\.|occurrence/.test(sqlText) ? creditsFromText(sqlText) : [];
      const label = dataLabelForSql(sqlText) + (credits.length > 0 ? `: ${credits.join("; ")}` : "");
      // A lookup in the document list is bookkeeping for finding a source, not a source itself.
      if (label !== "Document library" && rows.length > 0) out.push({ kind: "data", label, detail: `${rows.length}${parsed.rowCount === 200 ? "+" : ""} record${rows.length === 1 ? "" : "s"}` });
      const ids = new Set<number>();
      for (const r of rows) for (const k of ["source_document_id", "document_id"]) {
        const v = r[k];
        if (typeof v === "number" && Number.isInteger(v)) ids.add(v);
      }
      // Statements loaded straight from SEC filings carry the filing reference in a text field rather than a document id.
      const filings = new Set<string>();
      for (const r of rows) for (const [k, v] of Object.entries(r)) {
        if (/source$/i.test(k) && !/document|id$/i.test(k) && typeof v === "string" && v.trim() && v.length < 200) filings.add(v.trim());
      }
      for (const f of [...filings].slice(0, 12)) {
        const cleaned = f.replace(/\s*\((?:source_)?documents?\s*(?:id\s*)?#?\d+\)/gi, "").trim();
        if (cleaned) out.push({ kind: "document", title: cleaned });
      }
      if (ids.size > 0 && ids.size <= 40) {
        const docs = await runReadOnlyQuery(`SELECT document_id, title FROM docs.documents WHERE document_id IN (${[...ids].join(",")})`, 40);
        for (const d of docs.rows) out.push({ kind: "document", title: String(d.title) });
      }
    } else if (name === "search_documents" || name === "read_document") {
      const rows = JSON.parse(text) as { title?: string; page_number?: number }[];
      for (const r of rows) if (r.title) out.push({ kind: "document", title: r.title, page: typeof r.page_number === "number" ? r.page_number : undefined });
    } else if (name === "find_geochemical_anomalies") {
      const cr = creditsForSource(typeof input.source_system === "string" ? input.source_system : undefined);
      out.push({ kind: "data", label: "Sample geochemistry anomaly screen" + (cr.length > 0 ? `: ${cr.join("; ")}` : ""), detail: cr.length > 0 ? undefined : "national geological survey datasets" });
    } else if (name === "run_geochem_analysis") {
      const n = Array.isArray(input.sample_ids) ? (input.sample_ids as unknown[]).length : undefined;
      out.push({ kind: "data", label: "Geochemical analysis", detail: n ? `${n.toLocaleString("en-US")} samples` : input.source_system ? "regional rock-sample data" : undefined });
    } else if (name === "run_financial_model") {
      out.push({ kind: "data", label: "Financial model", detail: "from the assumptions given in the conversation" });
    }
  } catch {
    /* evidence is best-effort; never break an answer for it */
  }
  return out;
}

function webEvidence(content: Anthropic.ContentBlock[]): Evidence[] {
  const out: Evidence[] = [];
  for (const b of content) {
    const blk = b as unknown as { type: string; content?: unknown };
    if (blk.type === "web_search_tool_result" && Array.isArray(blk.content)) {
      for (const r of blk.content as { url?: string; title?: string }[]) if (r.url) out.push({ kind: "web", title: r.title || r.url, url: r.url });
    } else if (blk.type === "web_fetch_tool_result" && blk.content && typeof blk.content === "object") {
      const c = blk.content as { url?: string; content?: { title?: string } };
      if (c.url) out.push({ kind: "web", title: c.content?.title || c.url, url: c.url });
    }
  }
  return out;
}

// Plain-language description of what a tool call is doing, derived from its input.
function stepLabel(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "run_sql": {
      const sql = String(input.sql ?? "").toLowerCase();
      if (/markets\.fx_rates/.test(sql)) return "Looking up exchange rates";
      if (/markets\./.test(sql)) return "Checking commodity prices";
      if (/financials\./.test(sql)) return "Checking company financial statements";
      if (/docs\./.test(sql)) return "Checking the document library";
      if (/geochem\./.test(sql)) return "Checking sample geochemistry";
      if (/occurrence/.test(sql)) return "Searching mineral occurrences";
      if (/core\.companies/.test(sql)) return "Looking up companies";
      return "Looking up records";
    }
    case "read_document":
      return "Reading the full passage";
    case "search_documents": {
      const q = String(input.query ?? "").trim();
      return q ? `Searching reports and filings: “${q.length > 70 ? q.slice(0, 70) + "…" : q}”` : "Searching reports and filings";
    }
    case "company_financials": {
      const c = Array.isArray(input.companies) ? (input.companies as unknown[]).map(String).slice(0, 4).join(", ") : "";
      return c ? `Getting financials in US dollars: ${c}` : "Getting company financials";
    }
    case "peer_comparison":
      return "Comparing peer companies";
    case "operating_data": {
      const c = Array.isArray(input.companies) ? (input.companies as unknown[]).map(String).slice(0, 3).join(", ") : "";
      return c ? `Reading company reports for operating data: ${c}` : "Reading company reports for operating data";
    }
    case "price_history": {
      const c = String(input.commodity ?? "").trim();
      return c ? `Pulling price history: ${c}` : "Pulling price history";
    }
    case "company_assets": {
      const c = Array.isArray(input.companies) ? (input.companies as unknown[]).map(String).slice(0, 3).join(", ") : String(input.company ?? input.peer_group ?? "").trim();
      return c ? `Looking up assets and ownership: ${c}` : "Looking up assets and ownership";
    }
    case "investor_memo":
      return "Preparing the investor memo";
    case "rank_leads":
      return "Ranking geochemical leads across all surveys";
    case "deposit_fingerprint":
      return "Comparing the chemistry with known deposit types";
    case "assay_next":
      return "Testing which extra element would separate the deposit types";
    case "supply_concentration":
      return "Looking up who supplies it, country by country";
    case "price_outlook":
      return "Working out the tested price range";
    case "price_sensitivity": {
      const c = String(input.commodity ?? "").trim();
      return c ? `Testing how results track the ${c} price` : "Testing how results track the price";
    }
    case "find_geochemical_anomalies":
      return "Screening sample geochemistry for anomalies";
    case "run_geochem_analysis":
      return "Running a geochemical analysis";
    case "run_financial_model":
      return "Running the financial model";
    case "get_reference_notes":
      return "Reading background notes";
    default:
      return "Working";
  }
}

// How hard the model thinks before answering. Lookups and comparisons over structured data need little; analysis and synthesis get more.
type Effort = "low" | "medium" | "high";
function chooseEffort(topics: TopicId[], userText = ""): Effort {
  if (process.env.CHAT_EFFORT && ["low", "medium", "high"].includes(process.env.CHAT_EFFORT)) return process.env.CHAT_EFFORT as Effort;
  const analytic = topics.some((t) => t === "geochemistry_workflow" || t === "geochemistry_scripts" || t === "project_economics");
  // Side-by-side comparisons, rankings and trends need care so the summary agrees with the numbers.
  const comparative = /\b(compar\w*|versus|vs\.?|rank\w*|trend\w*|split|decompos\w*|break ?down|drove|driver|sensitiv\w*|exposure|exposed|elasticit\w*|correlat\w*)\b/i.test(userText);
  return analytic || comparative ? "medium" : "low";
}

// The small model works from our own data only: if a figure is missing it should say so and offer to search the web, not search on its own.
const toolsWithoutWeb: Anthropic.ToolUnion[] = tools.filter((t) => !("name" in t && (t.name === "web_search" || t.name === "web_fetch")));

const SIMPLE_TOPICS: TopicId[] = ["financials", "markets", "occurrences"];
const NOT_SIMPLE = /\b(compar\w*|versus|vs\.?|rank\w*|trend\w*|since|over the|histor\w*|moved|why|explain\w*|analy[sz]\w*|summari[sz]\w*|reliab\w*|caveat\w*|forecast\w*|predict\w*|explor\w*|plot|chart|diagram|top \d+|which|who|best|worst|most|least|between|all|every|list|what does|literature|reports? says?|will|would|future|outlook|expect\w*|project(ed|ions?)|next (year|decade)|20[3-9]\d|us dollars?|usd|us\$|convert\w*|exchange rates?|fx|ebitda|interest cover|leverage|net debt|effective tax|sensitiv\w*|exposure|exposed|elasticit\w*|regress\w*|correlat\w*|beta|map\w*|where|located|locations?|positions?|sites?|assets?|own\w*|stakes?|plants?|refiner\w*|smelter\w*|facilit\w*)\b/i;
// Maps, locations and company assets stay on MODEL (2026-11-01): the small model skipped company_assets and named catalogue sites instead.

/** A question is "simple" when it asks for one fact from structured data: one user turn, short, only lookup subjects, no analytic wording. */
function isSimpleLookup(topics: TopicId[], userMessages: string[]): boolean {
  if (process.env.CHAT_ROUTING === "off") return false;
  if (userMessages.length !== 1) return false;
  const q = userMessages[0];
  if (q.length > 160 || NOT_SIMPLE.test(q)) return false;
  return topics.length > 0 && topics.every((t) => SIMPLE_TOPICS.includes(t));
}

export async function POST(req: NextRequest) {
  // Cost protection (see src/lib/guard.ts): validate and trim the input, then check the visitor and global limits before any billable work starts.
  const parsed = checkMessages(await req.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.message, code: parsed.code }, { status: parsed.status });
  const lastQuestion = parsed.messages[parsed.messages.length - 1]?.content ?? "";
  const session = await getSession(req);
  // Saved answers (src/lib/demo-cache.ts): a demo card's question returns its reviewed, saved answer without any model cost. The owner records a new one by
  // sending x-demo-record; scripts that send the guard bypass header always get a live answer, so evals keep testing the real thing.
  const recording = session?.r === "owner" && req.headers.get("x-demo-record") === "1";
  if (!recording && !req.headers.has("x-guard-bypass") && session) {
    const invite = session.r === "guest" && session.i ? await getInvite(session.i).catch(() => null) : null;
    const allowed = session.r === "owner" || (invite !== null && inviteStatus(invite) === "active");
    const pinned = allowed ? await getApproved(lastQuestion).catch(() => null) : null;
    if (pinned) {
      if (invite) await recordInviteUse(invite.id, { question: lastQuestion, units: 0, tools: ["saved answer"] }).catch(() => undefined);
      await recordActivity({ kind: "question", who: invite ? { role: "guest", name: invite.name, inviteId: invite.id } : { role: "owner" }, q: lastQuestion, outcome: "answered", tools: ["saved answer"], units: 0 });
      console.log(`[usage] ${JSON.stringify({ saved: true, v: invite ? `inv_${invite.id}` : "owner" })}`);
      const answerId = session
        ? await rememberAnswer([...pinned.lines, JSON.stringify({ type: "notice", message: savedNotice(pinned) })], lastQuestion, { r: session.r, i: session.i }).catch(() => null)
        : null;
      return replayResponse(pinned, {}, answerId);
    }
  }
  const admission = await admit(req, { session, question: lastQuestion });
  if (!admission.ok) {
    return NextResponse.json(
      { error: admission.message, code: admission.code, retryAfterSec: admission.retryAfterSec },
      { status: admission.status, headers: admission.retryAfterSec ? { "Retry-After": String(admission.retryAfterSec) } : undefined }
    );
  }
  const messages = parsed.messages;
  let sandboxRuns = 0;

  const conversation: Anthropic.MessageParam[] = messages
    .filter((m) => m.content && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content }));
  const collectedImages: GeneratedImage[] = [];
  const userText = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n").slice(-6000);
  const topics = selectTopics(userText);
  const loadedTopics = new Set<TopicId>(topics);
  const effort = chooseEffort(topics, userText);
  const userMessages = messages.filter((m) => m.role === "user").map((m) => m.content);
  let model = isSimpleLookup(topics, userMessages) ? FAST_MODEL : MODEL;
  const modelsUsed = new Set<string>();
  // A question that asks for a future value or a buy / sell / pick gets a short extra instruction at the end of the system prompt (src/lib/intent.ts).
  const lastUserText = messages.filter((m) => m.role === "user").slice(-1).map((m) => m.content).join(" ");
  const intentNote = futureOrVerdictNote(lastUserText);
  const technical = wantsTechnicalDetail(messages.filter((m) => m.role === "user").slice(-1).map((m) => m.content).join(" "));
  console.log(`[chat] notes loaded: ${topics.join(",") || "none"} effort=${chooseEffort(topics, userText)} model=${model}`);
  const signal = req.signal;
  const encoder = new TextEncoder();

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const recorded: string[] | null = recording ? [] : null;
      // Kept so the finished answer can be shared (src/lib/shared-answers.ts); not for scripts and evals, nor for recordings.
      const shareable = !recording && !req.headers.has("x-guard-bypass") && !!session;
      const captured: string[] = [];
      const emit = (ev: StreamEvent) => {
        if (closed) return;
        if (shareable && ev.type !== "usage") captured.push(JSON.stringify(ev));
        recorded?.push(JSON.stringify(ev));
        try {
          controller.enqueue(encoder.encode(JSON.stringify(ev) + "\n"));
        } catch {
          closed = true;
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      // Open-ended analysis questions can need a dozen sequential queries. Rather than failing with nothing when the tool-turn
      // budget or the time limit (maxDuration 240 s) is nearly used up, the last pass is made with tools switched off and the
      // model is told to answer from what it has already found and say what it did not get to.
      const startedAtMs = Date.now();
      const MAX_TURNS = 16;
      const SOFT_LIMIT_MS = 165_000;
      let finalPass = false;
      let stepSeq = 0;
      const totals = { turns: 0, input: 0, cache_read: 0, cache_write: 0, output: 0 };
      const toolsUsed = new Set<string>();
      let outcome: "answered" | "error" | "step_budget" = "answered"; // for the owner's Activity page
      const emitUsage = () =>
        emit({ type: "usage", ...totals, ms: Date.now() - startedAtMs, models: [...modelsUsed], tools: [...toolsUsed], effort, topics });

      try {
        for (let turn = 0; turn < MAX_TURNS; turn++) {
          if (signal.aborted) break;
          const stream = anthropic.messages.stream(
            {
              model,
              max_tokens: finalPass ? 5000 : 16000,
              system: intentNote ? [...systemBlocks(topics), { type: "text" as const, text: intentNote }] : systemBlocks(topics),
              output_config: { effort },
              tools: model === MODEL ? tools : toolsWithoutWeb,
              ...(finalPass ? { tool_choice: { type: "none" as const } } : {}),
              messages: withTrailingCacheBreakpoint(conversation),
            },
            { signal }
          );
          const serverSteps = new Map<number, string>();
          const san = makeSanitizer(!technical);
          let textEmitted = false;
          stream.on("text", (delta) => {
            const out = san.push(delta);
            if (out) {
              textEmitted = true;
              emit({ type: "text", delta: out });
            }
          });
          stream.on("streamEvent", (e) => {
            // Server-side tools (web search / fetch) run inside the model call: surface them as soon as they start.
            if (e.type === "content_block_start") {
              const t = e.content_block.type as string;
              if (t === "server_tool_use") {
                const id = `s${++stepSeq}`;
                serverSteps.set(e.index, id);
                const nm = (e.content_block as { name?: string }).name;
                emit({ type: "step_start", id, label: nm === "web_fetch" ? "Reading a web page" : "Searching the web" });
              } else if (t.endsWith("_tool_result")) {
                for (const [, id] of serverSteps) emit({ type: "step_end", id, ok: true, ms: 0 });
                serverSteps.clear();
              }
            }
          });
          let response;
          try {
            response = await stream.finalMessage();
          } catch (err) {
            // If the small model fails before anything reached the user, redo this step on the main model.
            if (model !== MODEL && !signal.aborted && !textEmitted) {
              console.warn(`[chat] ${model} failed (${String(err instanceof Error ? err.message : err).slice(0, 120)}); falling back to ${MODEL}`);
              model = MODEL;
              turn--;
              continue;
            }
            throw err;
          }
          modelsUsed.add(model);
          const tail = san.flush();
          if (tail) emit({ type: "text", delta: tail });
          for (const [, id] of serverSteps) emit({ type: "step_end", id, ok: true, ms: 0 });
          for (const b of response.content) {
            const blk = b as unknown as { type: string; name?: string; input?: Record<string, unknown> };
            if (blk.type === "server_tool_use" && blk.name) toolsUsed.add(blk.name);
            if (blk.type === "server_tool_use") console.log(`[chat] turn ${turn} ${blk.name}: ${JSON.stringify(blk.input).slice(0, 200)}`);
          }
          const web = webEvidence(response.content);
          if (web.length) emit({ type: "evidence", items: web });
          const u = response.usage;
          totals.turns++;
          totals.input += u.input_tokens;
          totals.cache_read += u.cache_read_input_tokens ?? 0;
          totals.cache_write += u.cache_creation_input_tokens ?? 0;
          totals.output += u.output_tokens;
          console.log(`[chat] turn ${turn} model tokens in=${u.input_tokens} cache_read=${u.cache_read_input_tokens ?? 0} cache_write=${u.cache_creation_input_tokens ?? 0} out=${u.output_tokens}`);

          if (response.stop_reason !== "tool_use" && response.stop_reason !== "pause_turn") {
            emit({ type: "turn_end", final: true });
            if (response.stop_reason === "max_tokens") {
              // Hit the token ceiling mid-turn: any tool_use block may be truncated, so treat this as final and say so plainly.
              emit({ type: "notice", message: "The response was cut off by the length limit. Ask me to continue, or narrow the question." });
            }
            emitUsage();
            if (shareable && session && !signal.aborted) {
              const id = await rememberAnswer(captured, lastQuestion, { r: session.r, i: session.i }).catch(() => null);
              if (id) emit({ type: "answer", id });
            }
            emit({ type: "done" });
            close();
            return;
          }

          // Text produced in a turn that ends in tool calls is working narration, not the answer: the client discards it.
          emit({ type: "turn_end", final: false });
          conversation.push({ role: "assistant", content: response.content });

          // pause_turn: a server-side tool paused mid-sequence; nothing for us to execute, just send the conversation back.
          if (response.stop_reason === "pause_turn") continue;

          // Run all tool calls from this turn in parallel.
          const calls = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
          for (const c of calls) toolsUsed.add(c.name);
          const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(
            calls.map(async (block): Promise<Anthropic.ToolResultBlockParam> => {
              const id = `t${++stepSeq}`;
              const input = block.input as Record<string, unknown>;
              emit({ type: "step_start", id, label: stepLabel(block.name, input) });
              const startedAt = Date.now();
              const localImages: GeneratedImage[] = [];
              const extras = { evidence: [] as Evidence[], datasets: [] as Dataset[], maps: [] as MapData[] };
              try {
                // Each analysis starts a billed sandbox: a single question may run only a few of them.
                if ((block.name === "run_geochem_analysis" || block.name === "run_financial_model") && ++sandboxRuns > LIMITS.sandboxRunsPerQuestion) {
                  throw new Error(`This question has already used its limit of ${LIMITS.sandboxRunsPerQuestion} analysis runs. Do not run more: answer from what you have and say what was not run.`);
                }
                const result = await executeTool(block.name, input, localImages, loadedTopics, extras);
                for (const ds of extras.datasets) emit({ type: "dataset", dataset: ds });
                for (const mp of extras.maps) emit({ type: "map", map: mp });
                console.log(`[chat] turn ${turn} ${block.name} ok ${Date.now() - startedAt}ms`);
                for (const img of localImages) {
                  collectedImages.push(img);
                  emit({ type: "image", image: img });
                }
                emit({ type: "step_end", id, ok: true, ms: Date.now() - startedAt });
                const items = [...extras.evidence, ...(await evidenceFor(block.name, input, result))];
                if (items.length) emit({ type: "evidence", items });
                return { type: "tool_result", tool_use_id: block.id, content: result };
              } catch (err) {
                console.error(
                  `[chat] turn ${turn} ${block.name} FAILED ${Date.now() - startedAt}ms:`,
                  String(err instanceof Error ? err.message : err).slice(0, 400),
                  block.name === "run_sql" ? `| sql: ${String(input.sql).replace(/\s+/g, " ").slice(0, 300)}` : ""
                );
                emit({ type: "step_end", id, ok: false, ms: Date.now() - startedAt });
                return {
                  type: "tool_result",
                  tool_use_id: block.id,
                  content: String(err instanceof Error ? err.message : err),
                  is_error: true,
                };
              }
            })
          );
          if (signal.aborted) break;

          const outOfRoom = turn + 2 >= MAX_TURNS || Date.now() - startedAtMs > SOFT_LIMIT_MS;
          if (outOfRoom && !finalPass) {
            finalPass = true;
            console.warn(`[chat] out of room at turn ${turn} (${Math.round((Date.now() - startedAtMs) / 1000)} s): forcing a final answer without tools`);
            conversation.push({
              role: "user",
              content: [
                ...toolResults,
                {
                  type: "text",
                  text:
                    "The tool and time budget for this question is used up. Do not call any more tools. Answer now from what you have already found: " +
                    "give the findings you are confident in, say plainly which parts you did not get to or could not verify, and suggest the next " +
                    "question to ask to continue.",
                },
              ],
            });
          } else {
            conversation.push({ role: "user", content: toolResults });
          }
        }
        if (!signal.aborted) {
          outcome = "step_budget";
          emit({ type: "error", message: "Sorry, I could not complete that within the step budget. Try a narrower question." });
        }
        emit({ type: "done" });
      } catch (err) {
        if (!signal.aborted) {
          outcome = "error";
          console.error("[chat] stream failed:", String(err instanceof Error ? err.message : err).slice(0, 500));
          emit({ type: "error", message: "Something went wrong while answering. Please try again." });
          emit({ type: "done" });
        }
      } finally {
        await admission.finish(totals, { models: [...modelsUsed], tools: [...toolsUsed], ms: Date.now() - startedAtMs, sandboxRuns, outcome: signal.aborted ? "stopped" : outcome });
        if (recorded && !signal.aborted) {
          const saved = await saveDraft(lastQuestion, recorded).catch((e) => ({ ok: false as const, error: String(e).slice(0, 120) }));
          console.log(`[demo] draft ${saved.ok ? `saved (${saved.bytes} chars)` : `not saved: ${saved.error}`}`);
        }
        close();
      }
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      ...(admission.setCookie ? { "Set-Cookie": admission.setCookie } : {}),
    },
  });
}
