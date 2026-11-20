import { runReadOnlyQuery } from "@/lib/db";
import type { Dataset, Evidence, MapData, MapPoint } from "@/lib/types";

// Supply-disruption scenario: "what if <country> cuts <x>% of its <mineral> supply at <stage>?". Joins, through the risk crosswalk
// (markets.risk_minerals / risk_mineral_stages, gold_schema/build_risk_crosswalk.py), the USGS supply tables, CEPII BACI trade, USGS
// facility lists, the project records, the OECD export-restriction inventory and price series. Every number and every summary sentence is
// computed HERE and returned as ready-made statements: it is scenario arithmetic on recorded data, not a forecast of events or prices.

type Out = { content: string; evidence?: Evidence[]; datasets?: Dataset[]; maps?: MapData[] };
type Q = Record<string, unknown>;

const esc = (s: string) => s.replace(/'/g, "''");
const r1 = (x: number | null | undefined) => (x === null || x === undefined || !isFinite(x) ? null : Math.round(x * 10) / 10);
const n = (x: unknown) => (x === null || x === undefined || x === "" ? null : Number(x));
const usd = (kusd: number) => (kusd < 100 ? "less than US$0.1 million" : kusd >= 1e6 ? `US$${(kusd / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 })} billion` : `US$${(kusd / 1e3).toLocaleString("en-US", { maximumFractionDigits: 1 })} million`);
const q = async (sql: string, max = 500) => (await runReadOnlyQuery(sql, max)).rows as unknown as Q[];

const TRADE_YEARS = [2022, 2024] as const;
const EU27 = ["AUT", "BEL", "BGR", "HRV", "CYP", "CZE", "DNK", "EST", "FIN", "FRA", "DEU", "GRC", "HUN", "IRL", "ITA", "LVA", "LTU", "LUX", "MLT", "NLD", "POL", "PRT", "ROU", "SVK", "SVN", "ESP", "SWE"];
const ALWAYS = ["USA", "JPN", "KOR", "IND", "CHN"];
const GROUPED_ONLY = new Set(["gallium", "germanium", "indium", "rhenium"]);
const ALIASES: Record<string, string> = {
  ree: "rare_earths", "rare earth": "rare_earths", "rare earths": "rare_earths", "rare-earth": "rare_earths", "rare-earths": "rare_earths", neodymium: "rare_earths", dysprosium: "rare_earths",
  aluminum: "aluminium", bauxite: "aluminium", alumina: "aluminium", pgm: "platinum", pgms: "platinum", "platinum group": "platinum", columbium: "niobium", "phosphate rock": "phosphate",
  "natural graphite": "graphite", "graphite (natural)": "graphite", chrome: "chromium", chromite: "chromium", ferrochrome: "chromium", titanium: "titanium", ilmenite: "titanium", rutile: "titanium",
  zircon: "zirconium", "magnesium metal": "magnesium", spodumene: "lithium", "lithium carbonate": "lithium", "lithium hydroxide": "lithium", npi: "nickel",
};
const COUNTRY_ALIASES: Record<string, string> = { drc: "COD", "dr congo": "COD", "democratic republic of the congo": "COD", congo: "COD", us: "USA", usa: "USA", "united states": "USA", america: "USA", uk: "GBR", "south korea": "KOR", korea: "KOR", russia: "RUS", turkey: "TUR", vietnam: "VNM", burma: "MMR", myanmar: "MMR", "ivory coast": "CIV" };
// Short names for countries whose official names read badly in a sentence.
const DISPLAY: Record<string, string> = { COD: "DR Congo", COG: "Republic of the Congo", KOR: "South Korea", PRK: "North Korea", RUS: "Russia", IRN: "Iran", LAO: "Laos", VNM: "Vietnam", BOL: "Bolivia", TZA: "Tanzania", SYR: "Syria", VEN: "Venezuela", USA: "United States", GBR: "United Kingdom", CIV: "Côte d'Ivoire", MMR: "Myanmar", TUR: "Türkiye", HKG: "Hong Kong", MDA: "Moldova", CZE: "Czechia" };
let NAMES: Map<string, string> | null = null;
/** Readable country name for an ISO3 code (short forms for awkward official names); BACI's "Other Asia, n.e.s." is Taiwan. */
async function countryNames(): Promise<(iso: unknown, fallback?: unknown) => string> {
  if (!NAMES) NAMES = new Map((await q(`SELECT iso_code3, name FROM core.jurisdictions WHERE level = 'COUNTRY' AND iso_code3 IS NOT NULL`, 400)).map((r) => [String(r.iso_code3), String(r.name)]));
  return (iso, fallback) => {
    const i = iso ? String(iso) : "";
    if (DISPLAY[i]) return DISPLAY[i];
    if (NAMES!.has(i)) return NAMES!.get(i)!;
    const f = String(fallback ?? i);
    return /^other asia/i.test(f) ? "Taiwan (reported as Other Asia)" : f;
  };
}
const STAGE_WORDS: Record<string, string> = { mine: "mine_production", mining: "mine_production", ore: "mine_production", mined: "mine_production", refining: "refined", refinery: "refined", refined: "refined", processing: "refined", smelting: "smelter_production", smelter: "smelter_production", metal: "refined", intermediate: "intermediate" };
const STAGE_LABEL: Record<string, string> = { mine_production: "mine production", refinery_production: "refinery production", smelter_production: "smelter production", primary_production: "primary production", sponge_production: "sponge production", production: "production" };
const CREDITS = {
  usgs: "U.S. Geological Survey, Mineral Commodity Summaries 2026 (public domain)",
  baci: "CEPII BACI (version 202601, HS12), Gaulier and Zignago (2010), Etalab Open Licence 2.0",
  oecd: "OECD Inventory of Export Restrictions on Industrial Raw Materials (2009-2024)",
  fac: "USGS Minerals Yearbook facility tables and regional compilations (public domain)",
};

type Mineral = { mineral: string; label: string; restriction_commodities: string[]; price_series_monthly: number | null; price_series_annual: number | null; price_series_historical: number | null; facility_commodities: string[]; notes: string | null; project_commodities: string[] };
type Stage = { id: number; mineral: string; usgs_commodity: string | null; usgs_stage: string | null; trade_form: string; hs6: string[]; facility_stages: string[]; flag: string | null };
const arr = (x: unknown): string[] => (Array.isArray(x) ? x.map(String) : typeof x === "string" ? x.replace(/^\{|\}$/g, "").split(",").map((s) => s.replace(/^"|"$/g, "")).filter(Boolean) : []);

async function resolveMineral(raw: string): Promise<{ m: Mineral; stages: Stage[] } | { error: string }> {
  const all = (await q(`SELECT * FROM markets.risk_minerals ORDER BY mineral`)).map((r) => ({ ...r, restriction_commodities: arr(r.restriction_commodities), facility_commodities: arr(r.facility_commodities), project_commodities: arr(r.project_commodities) })) as unknown as Mineral[];
  const t = raw.trim().toLowerCase();
  const key = ALIASES[t] ?? t.replace(/\s+/g, "_");
  const m = all.find((x) => x.mineral === key) ?? all.find((x) => x.label.toLowerCase() === t) ?? all.find((x) => x.label.toLowerCase().startsWith(t) || (t.length > 3 && x.mineral.startsWith(t.slice(0, 5))));
  if (!m) return { error: `No scenario data for "${raw}". Minerals covered: ${all.map((x) => x.label).join("; ")}.` };
  const stages = (await q(`SELECT * FROM markets.risk_mineral_stages WHERE mineral = '${esc(m.mineral)}' ORDER BY id`)).map((r) => ({ ...r, hs6: arr(r.hs6), facility_stages: arr(r.facility_stages) })) as unknown as Stage[];
  return { m, stages };
}

async function resolveCountry(raw: string): Promise<{ iso3: string; name: string; codes: number[] } | { error: string }> {
  const t = raw.trim();
  const alias = COUNTRY_ALIASES[t.toLowerCase()];
  const iso = alias ?? (/^[A-Za-z]{3}$/.test(t) ? t.toUpperCase() : ((await q(`SELECT core.iso3_of('${esc(t)}') AS iso`))[0]?.iso as string | null));
  if (!iso) return { error: `Country "${raw}" not recognised.` };
  const rows = await q(`SELECT country_code, country_name FROM markets.trade_countries WHERE iso3 = '${esc(iso)}'`);
  const nm = (await q(`SELECT name FROM core.jurisdictions WHERE level = 'COUNTRY' AND iso_code3 = '${esc(iso)}' LIMIT 1`))[0]?.name as string | undefined;
  return { iso3: iso, name: DISPLAY[iso] ?? nm ?? String(rows[0]?.country_name ?? iso), codes: rows.map((r) => Number(r.country_code)) };
}

export async function supplyDisruption(input: Record<string, unknown>): Promise<Out> {
  const mineralIn = String(input.commodity ?? input.mineral ?? "").trim();
  const countryIn = String(input.country ?? "").trim();
  if (!mineralIn || !countryIn) return { content: "Give a mineral (commodity) and the country whose supply is cut, e.g. commodity cobalt, country DRC." };
  const cut = Math.max(1, Math.min(100, Number(input.cut_pct) || 100));
  const stageIn = String(input.stage ?? "").trim().toLowerCase().replace(/\s+/g, "_");

  const mr = await resolveMineral(mineralIn);
  if ("error" in mr) return { content: mr.error };
  const cr = await resolveCountry(countryIn);
  if ("error" in cr) return { content: cr.error };
  const { m, stages } = mr;
  const C = cr;
  const nameOf = await countryNames();

  // ---- supply shares for every USGS stage of this mineral (latest year), to pick the stage and to report alternatives ---------------
  const usgsStages = stages.filter((s) => s.usgs_commodity && s.usgs_stage);
  const groups = usgsStages.length
    ? await q(`SELECT DISTINCT ON (g.commodity, g.stage) g.group_id, g.commodity, g.stage, g.data_year, g.is_estimate, g.unit, g.world_total_reported, g.denominator_basis, g.top3_share_pct, g.hhi_named, g.detail
               FROM markets.supply_concentration g WHERE g.is_active AND (g.commodity, g.stage) IN (${usgsStages.map((s) => `('${esc(s.usgs_commodity!)}','${esc(s.usgs_stage!)}')`).join(",")})
               ORDER BY g.commodity, g.stage, g.data_year DESC, g.group_id`)
    : [];
  const shares = groups.length
    ? await q(`SELECT c.group_id, c.country, core.iso3_of(c.country) AS iso3, c.value_num, c.share_pct, c.row_kind FROM markets.supply_concentration_countries c WHERE c.group_id IN (${groups.map((g) => g.group_id).join(",")})`, 1000)
    : [];
  const shareOf = (gid: unknown) => shares.find((s) => s.group_id === gid && s.iso3 === C.iso3);

  // the country's share of world exports at every stage's trade codes (2022-2024), to compare stages
  const tradeable = GROUPED_ONLY.has(m.mineral) || !C.codes.length ? [] : stages.filter((s) => s.hs6.length);
  const expShare = new Map<number, number>();
  if (tradeable.length) {
    const allHs = [...new Set(tradeable.flatMap((s) => s.hs6))].map((h) => `'${h}'`).join(",");
    const ex = await q(`SELECT hs6, sum(value_kusd) FILTER (WHERE exporter_code IN (${C.codes.join(",")})) AS x, sum(value_kusd) AS w FROM markets.trade_flows WHERE hs6 IN (${allHs}) AND year BETWEEN ${TRADE_YEARS[0]} AND ${TRADE_YEARS[1]} GROUP BY 1`, 200);
    for (const s of tradeable) {
      const rows = ex.filter((r) => s.hs6.includes(String(r.hs6)));
      const w = rows.reduce((a, r) => a + Number(r.w ?? 0), 0);
      if (w > 0) expShare.set(s.id, (100 * rows.reduce((a, r) => a + Number(r.x ?? 0), 0)) / w);
    }
  }
  const stageLabelOf = (s: Stage) => (s.usgs_stage ? STAGE_LABEL[s.usgs_stage] ?? s.usgs_stage : `${s.trade_form} (trade only)`);

  // stage choice: explicit, else the USGS stage where this country's share is largest (or, with no USGS share, the largest export share)
  const want = STAGE_WORDS[stageIn] ?? stageIn;
  let stage: Stage | undefined =
    stages.find((s) => s.usgs_stage === want) ?? (want === "refined" || want === "intermediate" ? stages.find((s) => s.trade_form === want) ?? stages.find((s) => s.usgs_stage && s.usgs_stage !== "mine_production") : undefined);
  if (!stage) {
    const ranked = usgsStages
      .map((s) => ({ s, share: n(shareOf(groups.find((g) => g.commodity === s.usgs_commodity && g.stage === s.usgs_stage)?.group_id)?.share_pct) ?? -1 }))
      .sort((a, b) => b.share - a.share);
    stage = ranked[0]?.share > 0 ? ranked[0].s : [...stages].sort((a, b) => (expShare.get(b.id) ?? -1) - (expShare.get(a.id) ?? -1))[0];
  }
  if (!stage) return { content: `No stages are set up for ${m.label}.` };
  const stageName = stage.usgs_stage ? STAGE_LABEL[stage.usgs_stage] ?? stage.usgs_stage : `${stage.trade_form} trade (no USGS production table)`;
  const evidence: Evidence[] = [];
  const statements: string[] = [];
  const caveats: string[] = [];
  const datasets: Dataset[] = [];
  const maps: MapData[] = [];
  const better = stages.filter((s) => s.id !== stage!.id && (expShare.get(s.id) ?? 0) >= 10 && (expShare.get(s.id) ?? 0) > 2 * (expShare.get(stage!.id) ?? 0));
  if (better.length)
    statements.push(`Note: ${C.name}'s share of world exports is larger at another stage - ${better.map((s) => `${stageLabelOf(s)} ${r1(expShare.get(s.id)!)}%`).join(", ")} against ${r1(expShare.get(stage.id) ?? 0)}% at the ${stageLabelOf(stage)} stage shown here; run the scenario for that stage too if the question is about trade.`);

  // ---- 1. supply lost ------------------------------------------------------------------------------------------------------------------
  let supply: Q | null = null;
  const g = stage.usgs_stage ? groups.find((x) => x.commodity === stage!.usgs_commodity && x.stage === stage!.usgs_stage) : undefined;
  if (g) {
    evidence.push({ kind: "data", label: CREDITS.usgs, detail: `${g.commodity} ${STAGE_LABEL[String(g.stage)] ?? g.stage}, ${g.data_year}${g.is_estimate ? " (estimate)" : ""}` });
    const rows = shares.filter((s) => s.group_id === g.group_id);
    const mine = rows.find((s) => s.iso3 === C.iso3);
    const share = n(mine?.share_pct);
    const listed = rows.filter((s) => s.row_kind === "listed" && n(s.share_pct) !== null).sort((a, b) => Number(b.share_pct) - Number(a.share_pct));
    const others = listed.filter((s) => s.iso3 !== C.iso3);
    const qty = n(mine?.value_num);
    supply = {
      table: `${g.commodity}: ${STAGE_LABEL[String(g.stage)] ?? g.stage}, ${g.data_year}${g.is_estimate ? " (USGS estimate)" : ""}`, unit: String(g.unit).trim(),
      country_quantity: qty, country_share_pct: r1(share), country_row: mine ? mine.row_kind : "not listed",
      lost_quantity: qty !== null ? Math.round((qty * cut) / 100) : null, lost_share_of_world_pct: share !== null ? r1((share * cut) / 100) : null,
      world_total: n(g.world_total_reported), shares_are_of: g.denominator_basis,
      other_producers: others.slice(0, 8).map((s) => ({ country: nameOf(s.iso3, s.country), share_pct: r1(n(s.share_pct)), quantity: n(s.value_num) })),
      others_combined_share_pct: r1(others.reduce((a, s) => a + Number(s.share_pct), 0)),
    };
    if (share !== null) {
      statements.push(`${C.name} accounts for ${r1(share)}% of world ${m.label.toLowerCase()} ${STAGE_LABEL[String(g.stage)] ?? g.stage} (${g.data_year}${g.is_estimate ? ", USGS estimate" : ""}${qty !== null ? `; ${qty.toLocaleString("en-US")} ${String(g.unit).trim()}` : ""}); a ${cut}% cut removes about ${r1((share * cut) / 100)}% of world supply at this stage${qty !== null ? ` (about ${Math.round((qty * cut) / 100).toLocaleString("en-US")} ${String(g.unit).trim()})` : ""}.`);
      if (others.length) statements.push(`The other listed producers: ${others.slice(0, 5).map((s) => `${nameOf(s.iso3, s.country)} ${r1(n(s.share_pct))}%`).join(", ")}.`);
    } else statements.push(`USGS gives no ${STAGE_LABEL[String(g.stage)] ?? g.stage} figure for ${C.name} (${mine ? String(mine.row_kind).replace(/_/g, " ") : "not listed"}), so the share of world supply lost cannot be computed; the trade and history sections still apply.`);
    datasets.push({ id: `dis-supply-${g.group_id}`, title: `Who else produces: ${g.commodity}, ${STAGE_LABEL[String(g.stage)] ?? g.stage}, ${g.data_year}`, columns: ["Country", "Share (%)", `Quantity (${String(g.unit).trim()})`], rows: listed.slice(0, 15).map((s) => [nameOf(s.iso3, s.country), r1(n(s.share_pct)), n(s.value_num)]) });
  } else {
    statements.push(`There is no USGS world production table for ${m.label.toLowerCase()} at the ${stage.trade_form} stage, so the share of world supply lost cannot be computed; only the trade, facility and history sections apply.`);
  }

  // ---- 2. trade exposure -------------------------------------------------------------------------------------------------------------
  let trade: Q | null = null;
  if (!stage.hs6.length) caveats.push("No trade codes are loaded for this mineral and stage, so importer exposure cannot be computed.");
  else if (GROUPED_ONLY.has(m.mineral)) caveats.push(`Importer exposure is not computed: the trade codes for ${m.label.toLowerCase()} (${stage.hs6.join(", ")}) also cover several other metals and do not show who trades ${m.label.toLowerCase()}.`);
  else if (!C.codes.length) caveats.push(`${C.name} is not in the BACI country list, so trade exposure cannot be computed.`);
  else {
    const hs = stage.hs6.map((h) => `'${h}'`).join(",");
    const xc = C.codes.join(",");
    const flows = await q(
      `WITH f AS (SELECT importer_code, exporter_code, sum(value_kusd)/3.0 AS v, sum(quantity_t)/3.0 AS qt FROM markets.trade_flows WHERE hs6 IN (${hs}) AND year BETWEEN ${TRADE_YEARS[0]} AND ${TRADE_YEARS[1]} GROUP BY 1, 2)
       SELECT f.importer_code, t.iso3, t.country_name, sum(f.v) FILTER (WHERE f.exporter_code IN (${xc})) AS from_x, sum(f.qt) FILTER (WHERE f.exporter_code IN (${xc})) AS qt_x, sum(f.v) AS total,
              sum(f.v) FILTER (WHERE te.iso3 = ANY (ARRAY[${EU27.map((e) => `'${e}'`).join(",")}])) AS from_eu
       FROM f LEFT JOIN markets.trade_countries t ON t.country_code = f.importer_code LEFT JOIN markets.trade_countries te ON te.country_code = f.exporter_code GROUP BY 1, 2, 3`,
      400
    );
    const worldExports = flows.reduce((a, r) => a + Number(r.total ?? 0), 0);
    const xExports = flows.reduce((a, r) => a + Number(r.from_x ?? 0), 0);
    const imp = flows.filter((r) => Number(r.from_x ?? 0) >= 100 && r.iso3 !== C.iso3).map((r) => ({ iso3: String(r.iso3 ?? ""), name: nameOf(r.iso3, r.country_name), from_x: Number(r.from_x), total: Number(r.total), qt: n(r.qt_x) }));
    imp.sort((a, b) => b.from_x - a.from_x);
    const eu = flows.filter((r) => EU27.includes(String(r.iso3)));
    const euFromX = eu.reduce((a, r) => a + Number(r.from_x ?? 0), 0);
    const euExtra = eu.reduce((a, r) => a + Number(r.total ?? 0) - Number(r.from_eu ?? 0), 0);
    const row = (iso: string) => imp.find((r) => r.iso3 === iso);
    const watch = ALWAYS.filter((i) => i !== C.iso3).map((i) => { const r = row(i); const tot = Number(flows.find((f) => f.iso3 === i)?.total ?? 0); return { importer: r?.name ?? i, iso3: i, imports_from_country: r ? usd(r.from_x) : "none recorded", share_of_its_imports_pct: tot > 0 ? r1((100 * (r?.from_x ?? 0)) / tot) : null }; });
    trade = {
      codes: stage.hs6, form: stage.trade_form, years: `${TRADE_YEARS[0]}-${TRADE_YEARS[1]} annual average (2024 provisional)`,
      country_share_of_world_exports_pct: worldExports > 0 ? r1((100 * xExports) / worldExports) : null, country_exports_per_year: usd(xExports),
      top_importers: imp.slice(0, 10).map((r) => ({ importer: r.name, imports_from_country_per_year: usd(r.from_x), share_of_its_imports_of_these_codes_pct: r1((100 * r.from_x) / r.total), tonnes_per_year: r.qt !== null ? Math.round(r.qt) : null })),
      eu27: { imports_from_country_per_year: usd(euFromX), share_of_extra_eu_imports_pct: euExtra > 0 ? r1((100 * euFromX) / euExtra) : null },
      watch_list: watch,
    };
    evidence.push({ kind: "data", label: CREDITS.baci, detail: `HS ${stage.hs6.join(", ")}, ${TRADE_YEARS[0]}-${TRADE_YEARS[1]}` });
    if (imp.length) {
      if (stage.trade_form !== "ore" && (stage.flag || m.notes)) statements.push(`What is traded at this stage: ${[stage.flag, stage.trade_form === "intermediate" ? m.notes : null].filter(Boolean).join(" ")}`);
      statements.push(`${C.name} supplied ${r1((100 * xExports) / worldExports)}% of world exports of these codes (HS ${stage.hs6.join(", ")}; ${usd(xExports)} a year, ${TRADE_YEARS[0]}-${TRADE_YEARS[1]} average).`);
      statements.push(`Largest importers from ${C.name}: ${imp.slice(0, 5).map((r) => `${r.name} ${usd(r.from_x)} (${r1((100 * r.from_x) / r.total)}% of its imports of these codes)`).join("; ")}.`);
      const dependent = imp.filter((r) => r.total > 1000 && r.from_x / r.total >= 0.5).slice(0, 8);
      if (dependent.length) statements.push(`Importers that got half or more of their imports of these codes from ${C.name}: ${dependent.map((r) => `${r.name} ${r1((100 * r.from_x) / r.total)}%`).join(", ")} (importers with at least US$1 million a year).`);
      statements.push(`EU-27: ${usd(euFromX)} a year from ${C.name}${euExtra > 0 ? `, ${r1((100 * euFromX) / euExtra)}% of EU imports of these codes from outside the EU` : ""}.`);
    } else statements.push(`No exports of these codes (HS ${stage.hs6.join(", ")}) from ${C.name} are recorded in ${TRADE_YEARS[0]}-${TRADE_YEARS[1]}.`);
    datasets.push({ id: "dis-importers", title: `Importers of ${m.label.toLowerCase()} (${stage.trade_form}) from ${C.name}, ${TRADE_YEARS[0]}-${TRADE_YEARS[1]} average`, columns: ["Importer", "Imports from country (US$ million/yr)", "Share of its imports of these codes (%)", "Tonnes/yr"], rows: imp.slice(0, 40).map((r) => [r.name, r1(r.from_x / 1000), r1((100 * r.from_x) / r.total), r.qt !== null ? Math.round(r.qt) : null]) });
    caveats.push("Trade is CEPII BACI's reconciled bilateral data: neighbouring or transit countries (for example ports and corridors) can appear as importers, and some flows are re-exported; use the largest importers and the EU-27 line for exposure.");
    caveats.push("Exposure counts direct trade in these codes only: not material embedded in products, re-exports, or what an importer then processes and sells on (for example ore refined in China and exported as metal).");
  }

  // ---- 3. facilities outside the country at this stage --------------------------------------------------------------------------------
  const facRows: Q[] = [];
  for (const fc of m.facility_commodities) facRows.push(...(await q(`SELECT *, core.iso3_of(country) AS iso3 FROM core.facility_list(NULL, '${esc(fc)}', NULL, false)`, 3000)));
  const stageSet = new Set(stage.facility_stages.flatMap((s) => s.split(", ")));
  const seen = new Set<string>();
  const fac = facRows.filter((r) => { const k = String(r.facility_key); if (seen.has(k)) return false; seen.add(k); return stageSet.has(String(r.stage_group)); });
  const outside = fac.filter((r) => r.iso3 !== C.iso3);
  const inside = fac.filter((r) => r.iso3 === C.iso3);
  if (fac.length) {
    evidence.push({ kind: "data", label: CREDITS.fac, detail: `${m.facility_commodities.join(", ")}: ${[...stageSet].join(", ")}` });
    const byC = new Map<string, number>();
    for (const r of outside) { const c = nameOf(r.iso3, r.country); byC.set(c, (byC.get(c) ?? 0) + 1); }
    const topC = [...byC.entries()].sort((a, b) => b[1] - a[1]);
    statements.push(`USGS facility lists name ${fac.length} ${m.label.toLowerCase()} facility lines at this stage (${[...stageSet].join(", ").toLowerCase()}): ${inside.length} in ${C.name} and ${outside.length} elsewhere, led by ${topC.slice(0, 6).map(([c, k]) => `${c} ${k}`).join(", ")}.`);
    caveats.push("Facility capacities are nameplate figures from USGS lists of various years (2024 table and older regional compilations); spare capacity, current output and ramp-up times are not known, so the facilities show where substitute supply exists, not how fast it could replace a loss.");
    const pts: MapPoint[] = outside.filter((r) => typeof r.lat === "number" && typeof r.lon === "number").slice(0, 400).map((r) => ({ lat: Number(r.lat), lon: Number(r.lon), label: String(r.name), group: String(r.stage_group), detail: [nameOf(r.iso3, r.country), r.capacity_as_published ? `Capacity: ${r.capacity_as_published}` : "", r.owners ? `Owners: ${r.owners}` : "", r.status ? `Status: ${r.status}` : "", `${r.data_year ?? ""} data`].filter(Boolean).join("\n") }));
    if (pts.length >= 2) maps.push({ id: "map-dis-" + Date.now(), title: `${m.label} facilities outside ${C.name} (${[...stageSet].join(", ").toLowerCase()})`, note: "USGS facility lists; positions are the matched catalogue site or the named town. Nameplate capacity, not spare capacity.", points: pts });
    datasets.push({ id: "dis-facilities", title: `${m.label} facilities outside ${C.name}`, columns: ["Facility", "Country", "Stage", "Capacity (as published)", "Owners", "Status", "Data year"], rows: outside.sort((a, b) => Number(b.capacity_sort ?? 0) - Number(a.capacity_sort ?? 0)).slice(0, 100).map((r) => [String(r.name), nameOf(r.iso3, r.country), String(r.stage_group), (r.capacity_as_published as string) ?? null, (r.owners as string) ?? null, (r.status as string) ?? null, n(r.data_year)]) });
  } else caveats.push(`No ${m.label.toLowerCase()} facilities at this stage are in the USGS facility lists.`);

  // ---- 4. project pipeline outside the country -----------------------------------------------------------------------------------------
  let pipeline: Q | null = null;
  if (m.project_commodities.length) {
    const pr = await q(
      `SELECT p.name, p.status, p.asset_type, coalesce(par.iso_code3, j.iso_code3) AS iso3, coalesce(par.name, j.name) AS country, co.name AS company,
              (SELECT min(d.est_start_production) FROM core.project_designations d WHERE d.project_id = p.project_id AND d.is_active) AS crma_start,
              EXISTS (SELECT 1 FROM core.project_designations d WHERE d.project_id = p.project_id AND d.is_active) AS crma
       FROM core.projects p JOIN core.commodities cm ON cm.commodity_id = p.primary_commodity_id
       LEFT JOIN core.jurisdictions j ON j.jurisdiction_id = p.jurisdiction_id LEFT JOIN core.jurisdictions par ON par.jurisdiction_id = j.parent_jurisdiction_id AND j.level <> 'COUNTRY'
       LEFT JOIN core.companies co ON co.company_id = p.company_id
       WHERE p.is_active AND cm.commodity_name IN (${m.project_commodities.map((c) => `'${esc(c)}'`).join(",")}) AND p.status IN ('DEVELOPMENT', 'EXPLORATION')`,
      1000
    );
    const out = pr.filter((r) => r.iso3 !== C.iso3);
    const dev = out.filter((r) => r.status === "DEVELOPMENT");
    const crma = out.filter((r) => r.crma);
    const byC = new Map<string, number>();
    for (const r of out) { const c = nameOf(r.iso3, r.country); byC.set(c, (byC.get(c) ?? 0) + 1); }
    pipeline = {
      projects_outside_country: out.length, in_development: dev.length, in_exploration: out.length - dev.length, eu_strategic_projects: crma.length,
      by_country: [...byC.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([c, k]) => ({ country: c, projects: k })),
      named_development_projects: dev.slice(0, 15).map((r) => ({ project: r.name, country: nameOf(r.iso3, r.country), company: r.company, eu_strategic: r.crma, eu_listed_production_start: r.crma_start ?? null })),
    };
    if (out.length) statements.push(`Our project records hold ${out.length} ${m.label.toLowerCase()} projects outside ${C.name} that are in development (${dev.length}) or exploration (${out.length - dev.length}), ${crma.length} of them EU CRMA strategic projects; most are in ${[...byC.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([c, k]) => `${c} (${k})`).join(", ")}.`);
    caveats.push("The project pipeline is the projects in our records (EU CRMA strategic projects, NRCan's Canadian list, the Austrade Prospectus and company reports), not a global inventory, and statuses are as recorded: do not turn it into tonnes or a timeline.");
  }

  // ---- 5. history: this country's past export restrictions on the mineral and how prices moved --------------------------------------
  const ev = await q(
    `SELECT to_char(date_introduced, 'YYYY-MM-DD') AS d, string_agg(DISTINCT measure_type, '; ') AS measures, string_agg(DISTINCT hs6, ',') AS hs, string_agg(DISTINCT direction_of_change, ',') AS dir, max(value_text) FILTER (WHERE measure_type ILIKE '%tax%') AS rate
     FROM markets.export_restrictions WHERE country_iso3 = '${esc(C.iso3)}' AND commodity IN (${m.restriction_commodities.map((c) => `'${esc(c)}'`).join(",")})
       AND direction_of_change IN ('introduction', 'increase') AND date_introduced IS NOT NULL GROUP BY 1 ORDER BY 1`,
    200
  );
  const allMeasures = (await q(`SELECT count(DISTINCT (measure_type, hs6, date_introduced)) AS k, min(year) AS y0, max(year) AS y1 FROM markets.export_restrictions WHERE country_iso3 = '${esc(C.iso3)}' AND commodity IN (${m.restriction_commodities.map((c) => `'${esc(c)}'`).join(",")})`))[0];
  evidence.push({ kind: "data", label: CREDITS.oecd, detail: `${C.name}, ${m.restriction_commodities.join(" / ")}` });
  const series = m.price_series_monthly ?? m.price_series_annual ?? m.price_series_historical;
  let prices: Q[] = [];
  let seriesInfo: Q | undefined;
  const histSeries = m.price_series_monthly ? null : m.price_series_historical;
  if (series) {
    const ids = [series, histSeries].filter(Boolean).join(",");
    seriesInfo = (await q(`SELECT series_id, series_name, frequency, unit, source FROM markets.price_series WHERE series_id = ${series}`))[0];
    if (histSeries && histSeries !== series) seriesInfo = { ...seriesInfo, series_name: `${seriesInfo?.series_name ?? "USGS annual price"} from 2021; before 2021 USGS DS140 historical unit values (a different measure)` };
    prices = await q(`SELECT series_id, to_char(period_start, 'YYYY-MM-DD') AS d, value FROM markets.prices WHERE series_id IN (${ids}) AND value IS NOT NULL ORDER BY series_id, period_start`, 5000);
  }
  const monthly = m.price_series_monthly ? prices.filter((p) => p.series_id === m.price_series_monthly) : [];
  const ym = (d: unknown) => { const t = new Date(String(d)); return t.getUTCFullYear() * 12 + t.getUTCMonth(); };
  const mval = new Map(monthly.map((p) => [ym(p.d), Number(p.value)]));
  const chg = (a?: number, b?: number) => (a && b ? r1((100 * (b - a)) / a) : null);
  // background: distribution of all 12-month changes since 1990, to say whether a move after an event was unusual
  const all12 = [...mval.entries()].filter(([k]) => k >= 1990 * 12).map(([k, v]) => chg(v, mval.get(k + 12))).filter((x): x is number => x !== null).sort((a, b) => a - b);
  const pct = (x: number | null) => (x === null || !all12.length ? null : Math.round((100 * all12.filter((y) => y <= x).length) / all12.length));
  const annualOf = (sid: number | null | undefined, y: number) => { const p = prices.find((r) => r.series_id === sid && new Date(String(r.d)).getUTCFullYear() === y); return p ? Number(p.value) : undefined; };
  const events = ev.map((e) => {
    const k = ym(e.d);
    const base = mval.get(k - 1);
    const y = new Date(String(e.d)).getUTCFullYear();
    const annualSid = y >= 2021 ? m.price_series_annual : histSeries ?? m.price_series_annual;
    const a0 = annualOf(annualSid, y - 1), a1 = annualOf(annualSid, y), a2 = annualOf(annualSid, y + 1);
    const c12 = monthly.length ? chg(base, mval.get(k + 11)) : null;
    return {
      date: String(e.d).slice(0, 10), measures: e.measures, hs6: e.hs, change: e.dir, tax_rate: e.rate ?? null,
      price_change_3m_pct: monthly.length ? chg(base, mval.get(k + 2)) : null, price_change_6m_pct: monthly.length ? chg(base, mval.get(k + 5)) : null, price_change_12m_pct: c12,
      percentile_of_12m_change_vs_all_months_since_1990: c12 !== null ? pct(c12) : null,
      annual_price_change_pct: !monthly.length ? { year_before_to_year_of: chg(a0, a1), year_of_to_year_after: chg(a1, a2), series: annualSid } : undefined,
    };
  });
  if (ev.length) {
    statements.push(`The OECD inventory records ${ev.length} date${ev.length === 1 ? "" : "s"} on which ${C.name} introduced or tightened export restrictions on ${m.label.toLowerCase()} (${allMeasures?.y0}-${allMeasures?.y1}), most recently ${events.slice(-3).map((e) => `${e.date} (${e.measures})`).join("; ")}.`);
    const withP = events.filter((e) => e.price_change_12m_pct !== null);
    const withA = events.filter((e) => e.annual_price_change_pct && (e.annual_price_change_pct.year_before_to_year_of !== null || e.annual_price_change_pct.year_of_to_year_after !== null));
    if (!withP.length && withA.length) statements.push(`Annual price around these dates (${seriesInfo?.series_name ?? "USGS annual series"}; year on year, coarse): ${withA.slice(-6).map((e) => { const a = e.annual_price_change_pct!; const f = (x: number | null) => (x === null ? "n/a" : `${x > 0 ? "+" : ""}${x}%`); return `${e.date}: ${f(a.year_before_to_year_of)} into that year, ${f(a.year_of_to_year_after)} the next year`; }).join("; ")}.`);
    if (withP.length) statements.push(`Price 12 months after these dates (${seriesInfo?.series_name ?? "monthly series"}): ${withP.slice(-6).map((e) => `${e.date}: ${e.price_change_12m_pct! > 0 ? "+" : ""}${e.price_change_12m_pct}% (percentile ${e.percentile_of_12m_change_vs_all_months_since_1990} of all 12-month changes since 1990)`).join("; ")}.`);
  } else statements.push(`The OECD inventory (2009-2024) records no export restriction introduced or tightened by ${C.name} on ${m.label.toLowerCase()}.`);
  caveats.push("Price moves after a restriction are not caused by it alone: demand, other supply changes and the wider commodity cycle move prices at the same time. Read them as what happened, not as an estimate of what this scenario would do. The OECD inventory ends in 2024; later measures (for example China's 2025 rare-earth and magnet controls) are not in it - search the documents for them.");
  if (!monthly.length && series) caveats.push(`Only annual prices exist for ${m.label.toLowerCase()} (${seriesInfo?.series_name ?? "USGS series"}; older years from the USGS DS140 historical unit values), so price changes are year on year and coarse.`);
  if (events.length) datasets.push({ id: "dis-history", title: `${C.name}: export restrictions introduced or tightened on ${m.label.toLowerCase()} (OECD inventory)`, columns: ["Date", "Measures", "HS6 codes", "Change", "Tax rate", "Price +3m (%)", "Price +6m (%)", "Price +12m (%)", "Percentile of +12m vs all"], rows: events.map((e) => [e.date, String(e.measures), String(e.hs6), String(e.change), e.tax_rate as string | null, e.price_change_3m_pct, e.price_change_6m_pct, e.price_change_12m_pct, e.percentile_of_12m_change_vs_all_months_since_1990]) });

  if (m.notes) caveats.unshift(m.notes);
  if (stage.flag) caveats.unshift(stage.flag);
  const otherStages = stages.filter((s) => s.id !== stage!.id).map((s) => (s.usgs_stage ? STAGE_LABEL[s.usgs_stage] ?? s.usgs_stage : `${s.trade_form} (trade only)`));
  return {
    content: JSON.stringify({
      what: `Scenario: ${C.name} cuts ${cut}% of its ${m.label.toLowerCase()} supply at the ${stageName} stage. Scenario arithmetic on recorded data - not a forecast of whether it will happen or of prices.`,
      mineral: m.label, country: C.name, cut_pct: cut, stage: stageName, trade_form: stage.trade_form, other_stages_available: otherStages,
      statements, supply_lost: supply, trade_exposure: trade, project_pipeline: pipeline, past_restrictions: events.slice(-15),
      price_series: seriesInfo ? { name: seriesInfo.series_name, frequency: seriesInfo.frequency, unit: seriesInfo.unit } : null,
      caveats,
      how_to_answer:
        "Quote the statements for every number. Structure: supply lost, who is exposed, who else produces (and that capacity is nameplate, not spare), the project pipeline as recorded, and the history of this country's restrictions with what prices did. " +
        "BEFORE answering, call search_documents with document_search_query (the restriction history above ends in 2024, so measures from 2025 onward - bans, quotas, export controls - are only in the documents) and add what they say, cited, as a short 'recent measures and policy context' part; if they hold nothing, say the record above ends in 2024. " +
        "Never give a probability that the event happens, never forecast the price, and never add producers, importers or projects not listed here. Say which caveats matter for the reader.",
      document_search_query: `${C.name} ${m.label} export ban quota export controls restrictions 2025 2026`,
      credits: Object.values(CREDITS),
    }),
    evidence,
    datasets,
    maps,
  };
}
