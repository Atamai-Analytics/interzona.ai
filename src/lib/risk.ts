import { runReadOnlyQuery } from "@/lib/db";
import type { Dataset, Evidence } from "@/lib/types";
import { WGI_ENABLED } from "@/lib/flags";

// Geopolitical supply risk by mineral and stage, from observed behaviour rather than governance perceptions: how concentrated production is
// (USGS MCS 2026) and how much of it comes from producers with export controls in force (OECD export-restriction inventory, 2024), plus,
// for an importer, how much of its imports come from controlled suppliers (CEPII BACI 2022-2024). Single ranking number: the
// restriction-weighted HHI = the HHI counted over producers with export controls in force only (0-10,000). Every number and sentence is
// computed HERE. Political stability comes from the World Bank Worldwide Governance Indicators (combined indicators only, core.country_governance,
// CC BY 4.0; WGI team asked 20 Nov 2026 to confirm commercial display), shown beside the restriction measures, never replacing them.
// While WGI_ENABLED is false (since 25 Nov 2026, no reply yet) nothing about political stability is queried, computed or shown.

type Out = { content: string; evidence?: Evidence[]; datasets?: Dataset[] };
type Q = Record<string, unknown>;
const esc = (s: string) => s.replace(/'/g, "''");
const r1 = (x: number | null | undefined) => (x === null || x === undefined || !isFinite(x) ? null : Math.round(x * 10) / 10);
const q = async (sql: string, max = 2000) => (await runReadOnlyQuery(sql, max)).rows as unknown as Q[];

const YEAR = 2024; // last year of the OECD inventory
const CONTROL = ["Export prohibition", "Export quota", "Licensing requirement", "Qualified exporters list", "Domestic market obligation", "Captive mining"];
const HARD = ["Export prohibition", "Export quota", "Domestic market obligation", "Captive mining"];
const FISCAL = ["Export tax", "Export surtax", "Fiscal tax on exports", "VAT tax rebate reduction / withdrawal", "Minimum export price / price reference for exports"];
const STAGE_LABEL: Record<string, string> = { iea_refining: "refining (IEA 2025)", iea_battery_grade: "battery-grade graphite (IEA 2025)", mine_production: "mine production", refinery_production: "refinery production", smelter_production: "smelter production", primary_production: "primary production", sponge_production: "sponge production", production: "production" };
const ALIASES: Record<string, string> = { ree: "rare_earths", "rare earth": "rare_earths", "rare earths": "rare_earths", aluminum: "aluminium", bauxite: "aluminium", alumina: "aluminium", pgm: "platinum", pgms: "platinum", columbium: "niobium", "phosphate rock": "phosphate", "natural graphite": "graphite", chrome: "chromium", chromite: "chromium", zircon: "zirconium", "magnesium metal": "magnesium" };
const RMIS: Record<string, string[]> = { graphite: ["Graphite-natural"], rare_earths: ["Rare Earth Elements"], titanium: ["Titanium", "Titanium metal"], magnesium: ["Magnesium"] };
const EU27 = ["AUT", "BEL", "BGR", "HRV", "CYP", "CZE", "DNK", "EST", "FIN", "FRA", "DEU", "GRC", "HUN", "IRL", "ITA", "LVA", "LTU", "LUX", "MLT", "NLD", "POL", "PRT", "ROU", "SVK", "SVN", "ESP", "SWE"];
const IMPORTER_ALIASES: Record<string, string> = { eu: "EU27", "eu-27": "EU27", "eu27": "EU27", "european union": "EU27", europe: "EU27", us: "USA", usa: "USA", "united states": "USA", america: "USA", uk: "GBR", "south korea": "KOR", korea: "KOR", japan: "JPN", india: "IND", china: "CHN" };
const DISPLAY: Record<string, string> = { COD: "DR Congo", KOR: "South Korea", PRK: "North Korea", RUS: "Russia", IRN: "Iran", LAO: "Laos", VNM: "Vietnam", BOL: "Bolivia", TZA: "Tanzania", USA: "United States", GBR: "United Kingdom", MMR: "Myanmar", TUR: "Türkiye", CZE: "Czechia" };
const CREDITS = {
  usgs: "U.S. Geological Survey, Mineral Commodity Summaries 2026 (public domain)",
  oecd: "OECD Inventory of Export Restrictions on Industrial Raw Materials (2009-2024)",
  baci: "CEPII BACI (version 202601, HS12), Gaulier and Zignago (2010), Etalab Open Licence 2.0",
  rmis: "European Commission, Raw Materials Information System (2023 CRM assessment indicators)",
  wgi: "Worldwide Governance Indicators, 2026 Update, World Bank (www.govindicators.org), CC BY 4.0",
  iea: "IEA (2026), Critical Minerals Data Explorer / Global Critical Minerals Outlook 2026, IEA, Paris, Licence: CC BY 4.0",
};

const HOW_WGI =
  " Political stability: the World Bank Worldwide Governance Indicators (2026 update, data year 2025) score each country 0-100 on Political Stability and Absence of Violence/Terrorism (a composite of perception surveys, with a 90% confidence band); " +
  "the stability-weighted HHI weights each producer's squared share by (100 - its score)/100, and 'low stability' means a Political Stability estimate below -1 (about one standard deviation below the world average; 27 of 207 countries in 2025). These are perceptions of risk, not forecasts, and the World Bank advises they are not definitive criteria for investment or other critical financial decisions.";
const HOW =
  "Licensing ranges from routine export permits (for example South Africa's precious-metal export approvals, Brazil's authorisation for niobium-tantalum ores) to licences that work as bans; the data do not say which, so each producer is marked 'ban or quota' or 'licensing only' and the share under bans or quotas is given separately. " +
  "Export controls = an export ban, quota, licensing requirement (including non-automatic licensing, which can work as a ban: Indonesia's nickel-ore ban has been recorded as licensing since November 2021, and China's 2023 gallium, germanium and graphite controls are licensing), " +
  "qualified-exporter list, domestic market obligation or captive-mining rule in force in 2024 on that stage's products in the OECD inventory; fiscal measures (export taxes, rebate cuts, minimum prices) are counted separately. " +
  "Restriction-weighted HHI = the Herfindahl-Hirschman index counted over producers with export controls in force only (0-10,000): high when supply is concentrated in countries that already control exports. " +
  `The export-control measures are recorded behaviour, not intentions${WGI_ENABLED ? "; political stability is reported separately from the World Bank WGI" : ""}. The OECD inventory ends in 2024: measures since then (for example China's 2025 rare-earth and magnet controls, the DRC's 2025 cobalt ban and quotas) are not counted - search the documents for them. ` +
  "USGS shares are estimates and count named countries only; production location is not ownership. " +
  "Stages marked (IEA 2025) are refining shares from the IEA Global Critical Minerals Outlook 2026 (base year 2025 of its projections; top six countries named, so HHI is a lower bound; export measures matched on any product of the mineral); USGS has no refining table for cobalt, lithium, nickel, graphite or rare earths. IEA projections for 2030-2040 are scenarios built from announced projects, not forecasts of policy." +
  (WGI_ENABLED ? HOW_WGI : " Political-stability (governance) scores are not available in this tool at present.");

type Row = { id: number; mineral: string; label: string; usgs_commodity: string; usgs_stage: string; hs6: string[]; restriction_commodities: string[]; trade_form: string; flag: string | null };
const arr = (x: unknown): string[] => (Array.isArray(x) ? x.map(String) : typeof x === "string" ? x.replace(/^\{|\}$/g, "").split(",").map((s) => s.replace(/^"|"$/g, "")).filter(Boolean) : []);

/** Stage rows with USGS shares, per-producer measures in force in YEAR and new measures 2020-YEAR, for the selected stage ids. */
async function stageData(ids: number[]) {
  const idl = ids.join(",");
  const groups = await q(`WITH st AS (SELECT * FROM markets.risk_mineral_stages WHERE id IN (${idl}))
     SELECT DISTINCT ON (st.id) st.id, g.group_id, g.commodity, g.stage, g.data_year, g.is_estimate, g.hhi_named, g.top1_country, g.top1_share_pct
     FROM st JOIN markets.supply_concentration g ON g.is_active AND g.commodity = st.usgs_commodity AND g.stage = st.usgs_stage ORDER BY st.id, g.data_year DESC, g.group_id`);
  const shares = groups.length ? await q(`SELECT c.group_id, c.country, core.iso3_of(c.country) AS iso3, c.share_pct::float8 AS share FROM markets.supply_concentration_countries c
     WHERE c.group_id IN (${groups.map((g) => g.group_id).join(",")}) AND c.row_kind = 'listed' AND c.share_pct IS NOT NULL`, 3000) : [];
  const measures = await q(`WITH st AS (SELECT s.id, s.hs6, m.restriction_commodities FROM markets.risk_mineral_stages s JOIN markets.risk_minerals m USING (mineral) WHERE s.id IN (${idl}))
     SELECT st.id, e.country_iso3 AS iso3, string_agg(DISTINCT e.measure_type, '; ' ORDER BY e.measure_type) AS types,
            bool_or(e.measure_type IN (${CONTROL.map((c) => `'${esc(c)}'`).join(",")})) AS control, bool_or(e.measure_type IN (${HARD.map((c) => `'${esc(c)}'`).join(",")})) AS hard, bool_or(e.measure_type IN (${FISCAL.map((c) => `'${esc(c)}'`).join(",")})) AS fiscal
     FROM st JOIN markets.export_restrictions e ON e.commodity = ANY (st.restriction_commodities) AND (cardinality(st.hs6) = 0 OR e.hs6 = ANY (st.hs6))
     WHERE e.year = ${YEAR} AND coalesce(e.direction_of_change, '') <> 'elimination' AND NOT (e.measure_type = 'Export tax' AND e.value_text = '0') GROUP BY 1, 2`, 3000);
  const recent = await q(`WITH st AS (SELECT s.id, s.hs6, m.restriction_commodities FROM markets.risk_mineral_stages s JOIN markets.risk_minerals m USING (mineral) WHERE s.id IN (${idl}))
     SELECT st.id, e.country_iso3 AS iso3, count(DISTINCT (e.measure_type, e.date_introduced)) AS k, max(e.date_introduced)::date::text AS last
     FROM st JOIN markets.export_restrictions e ON e.commodity = ANY (st.restriction_commodities) AND (cardinality(st.hs6) = 0 OR e.hs6 = ANY (st.hs6))
     WHERE e.direction_of_change IN ('introduction', 'increase', 'reintroduction') AND e.date_introduced >= '2020-01-01' GROUP BY 1, 2`, 3000);
  const isos = [...new Set(shares.map((s) => String(s.iso3)).filter((x) => x && x !== "null"))];
  const gov = WGI_ENABLED && isos.length ? await q(`SELECT iso3, max(score) FILTER (WHERE dimension = 'PV')::float8 AS pv, max(estimate) FILTER (WHERE dimension = 'PV')::float8 AS pv_est, avg(score)::float8 AS avg6 FROM core.country_governance
     WHERE year = (SELECT max(year) FROM core.country_governance) AND iso3 IN (${isos.map((i) => `'${esc(i)}'`).join(",")}) GROUP BY 1`, 500) : [];
  // "Low stability" = Political Stability estimate below -1, about one standard deviation below the world average (the estimate is on a
  // standard-normal scale); the 2026 0-100 score is compressed (median 68, bottom third below 60, which would include Brazil and South Africa).
  const cut = WGI_ENABLED ? (await q(`SELECT max(year) AS y, count(*) FILTER (WHERE estimate < -1) AS k, count(*) AS n FROM core.country_governance WHERE dimension = 'PV' AND year = (SELECT max(year) FROM core.country_governance)`))[0] : undefined;
  return { groups, shares, measures, recent, gov, govYear: Number(cut?.y ?? 0), lowCount: Number(cut?.k ?? 0), scoredCount: Number(cut?.n ?? 0) };
}

// ---- IEA refining stages (Global Critical Minerals Outlook 2026, markets.iea_cm_supply) ----------------------------------------------
// USGS gives only mine production for cobalt, lithium, nickel, graphite and rare earths; IEA gives refining (and battery-grade graphite) by
// country. Each IEA stage is added to the same structures as a USGS stage (negative synthetic ids) so scoreStage works unchanged. Shares are of
// IEA's total; only the top six countries are named (HHI is a lower bound). Export measures are matched on ANY product of the mineral (IEA
// stages do not map to HS codes one to one).
const IEA_STAGE: Record<string, string> = { Refining: "iea_refining", "Battery grade": "iea_battery_grade" };
async function addIeaStages(d: Awaited<ReturnType<typeof stageData>>, rows: Row[], mineral: string | null) {
  const sup = await q(`SELECT s.mineral_key, s.stage, s.country, s.iso3, s.row_kind, s.value, m.label, m.restriction_commodities
     FROM markets.iea_cm_supply s JOIN markets.risk_minerals m ON m.mineral = s.mineral_key
     WHERE s.year = 2025 AND s.stage IN ('Refining', 'Battery grade') ${mineral ? `AND s.mineral_key = '${esc(mineral)}'` : ""}`, 500);
  const keys = [...new Set(sup.map((r) => `${r.mineral_key}|${r.stage}`))];
  let k = 0;
  for (const key of keys) {
    const [mk, st] = key.split("|");
    const part = sup.filter((r) => r.mineral_key === mk && r.stage === st);
    const tot = Number(part.find((r) => r.row_kind === "total")?.value ?? 0);
    if (!(tot > 0)) continue;
    const id = -1000 - k++;
    const ctry = part.filter((r) => r.row_kind === "country").map((r) => ({ group_id: id, country: String(r.country), iso3: String(r.iso3 ?? "").trim(), share: (100 * Number(r.value)) / tot }));
    const hhi = ctry.reduce((a, c) => a + c.share * c.share, 0);
    d.groups.push({ id, group_id: id, commodity: "IEA", stage: IEA_STAGE[st], data_year: 2025, is_estimate: true, hhi_named: hhi, top1_country: ctry[0]?.country, top1_share_pct: ctry[0]?.share });
    d.shares.push(...ctry);
    const rc = arr(part[0].restriction_commodities);
    const isos = ctry.map((c) => `'${esc(c.iso3)}'`).join(",");
    if (rc.length && isos) {
      const ms = await q(`SELECT e.country_iso3 AS iso3, string_agg(DISTINCT e.measure_type, '; ' ORDER BY e.measure_type) AS types,
           bool_or(e.measure_type IN (${CONTROL.map((c) => `'${esc(c)}'`).join(",")})) AS control, bool_or(e.measure_type IN (${HARD.map((c) => `'${esc(c)}'`).join(",")})) AS hard, bool_or(e.measure_type IN (${FISCAL.map((c) => `'${esc(c)}'`).join(",")})) AS fiscal
         FROM markets.export_restrictions e WHERE e.commodity IN (${rc.map((c) => `'${esc(c)}'`).join(",")}) AND e.country_iso3 IN (${isos})
           AND e.year = ${YEAR} AND coalesce(e.direction_of_change, '') <> 'elimination' AND NOT (e.measure_type = 'Export tax' AND e.value_text = '0') GROUP BY 1`, 200);
      d.measures.push(...ms.map((m) => ({ ...m, id })));
      const re = await q(`SELECT e.country_iso3 AS iso3, count(DISTINCT (e.measure_type, e.date_introduced)) AS k, max(e.date_introduced)::date::text AS last FROM markets.export_restrictions e
         WHERE e.commodity IN (${rc.map((c) => `'${esc(c)}'`).join(",")}) AND e.country_iso3 IN (${isos}) AND e.direction_of_change IN ('introduction', 'increase', 'reintroduction') AND e.date_introduced >= '2020-01-01' GROUP BY 1`, 200);
      d.recent.push(...re.map((m) => ({ ...m, id })));
      const have = new Set(d.gov.map((g) => String(g.iso3).trim()));
      const need = ctry.map((c) => c.iso3).filter((i) => i && !have.has(i));
      if (WGI_ENABLED && need.length) d.gov.push(...(await q(`SELECT iso3, max(score) FILTER (WHERE dimension = 'PV')::float8 AS pv, max(estimate) FILTER (WHERE dimension = 'PV')::float8 AS pv_est, avg(score)::float8 AS avg6
         FROM core.country_governance WHERE year = ${d.govYear} AND iso3 IN (${need.map((i) => `'${esc(i)}'`).join(",")}) GROUP BY 1`)));
    }
    rows.push({ id, mineral: mk, label: String(part[0].label), usgs_commodity: "IEA", usgs_stage: IEA_STAGE[st], hs6: [], restriction_commodities: rc, trade_form: "refined",
      flag: "IEA projection base year 2025 (Global Critical Minerals Outlook 2026); top six countries named, so HHI is a lower bound; export measures matched on any product of the mineral." });
  }
}

/** IEA base-case outlook for one mineral: top producer, top-three share and HHI (top six) by stage and year, 2025-2040. */
async function ieaOutlook(mineral: string) {
  const sup = await q(`SELECT stage, year, country, row_kind, value FROM markets.iea_cm_supply WHERE mineral_key = '${esc(mineral)}' ORDER BY stage, year, value DESC`, 500);
  const out: { stage: string; year: number; top: string; top_share_pct: number | null; top3_share_pct: number | null; hhi_top6: number; total_kt: number }[] = [];
  for (const st of [...new Set(sup.map((r) => String(r.stage)))]) {
    for (const y of [...new Set(sup.filter((r) => r.stage === st).map((r) => Number(r.year)))]) {
      const part = sup.filter((r) => r.stage === st && Number(r.year) === y);
      const tot = Number(part.find((r) => r.row_kind === "total")?.value ?? 0);
      const ctry = part.filter((r) => r.row_kind === "country");
      if (!(tot > 0) || !ctry.length) continue;
      const sh = ctry.map((r) => (100 * Number(r.value)) / tot);
      out.push({ stage: st, year: y, top: String(ctry[0].country), top_share_pct: r1(sh[0]), top3_share_pct: r1(sh.slice(0, 3).reduce((a, b) => a + b, 0)), hhi_top6: Math.round(sh.reduce((a, b) => a + b * b, 0)), total_kt: Math.round(tot) });
    }
  }
  return out;
}

function scoreStage(id: number, d: Awaited<ReturnType<typeof stageData>>) {
  const g = d.groups.find((x) => x.id === id);
  if (!g) return null;
  const prod = d.shares.filter((s) => s.group_id === g.group_id).map((s) => {
    const m = d.measures.find((x) => x.id === id && x.iso3 === s.iso3);
    const rc = d.recent.find((x) => x.id === id && x.iso3 === s.iso3);
    return { country: DISPLAY[String(s.iso3)] ?? String(s.country), iso3: String(s.iso3), share: Number(s.share), control: !!m?.control, hard: !!m?.hard, fiscal: !!m?.fiscal, types: (m?.types as string) ?? null, new_since_2020: Number(rc?.k ?? 0), last_new: (rc?.last as string) ?? null,
      stability: (() => { const gv = d.gov.find((x) => String(x.iso3).trim() === String(s.iso3)); return gv && gv.pv !== null && gv.pv !== undefined ? Math.round(Number(gv.pv)) : null; })(),
      stability_est: (() => { const gv = d.gov.find((x) => String(x.iso3).trim() === String(s.iso3)); return gv && gv.pv_est !== null && gv.pv_est !== undefined ? Number(gv.pv_est) : null; })(),
      governance_avg: (() => { const gv = d.gov.find((x) => String(x.iso3).trim() === String(s.iso3)); return gv && gv.avg6 !== null && gv.avg6 !== undefined ? Math.round(Number(gv.avg6)) : null; })() };
  }).sort((a, b) => b.share - a.share);
  const sum = (f: (p: (typeof prod)[number]) => boolean) => prod.filter(f).reduce((a, p) => a + p.share, 0);
  const controlled = sum((p) => p.control);
  const anyMeasure = sum((p) => p.control || p.fiscal);
  const hardShare = sum((p) => p.hard);
  const rwHHI = prod.filter((p) => p.control).reduce((a, p) => a + p.share * p.share, 0);
  const swHHI = prod.reduce((a, p) => a + p.share * p.share * (p.stability === null ? 0.5 : (100 - p.stability) / 100), 0);
  const lowStab = sum((p) => p.stability_est !== null && p.stability_est < -1);
  const noScore = sum((p) => p.stability === null);
  const withScore = prod.filter((p) => p.stability !== null);
  const wTot = withScore.reduce((a, p) => a + p.share, 0);
  const newMeasures = prod.reduce((a, p) => a + p.new_since_2020, 0);
  return {
    group: g, producers: prod,
    hhi: Math.round(Number(g.hhi_named)), top: prod[0] ? { country: prod[0].country, share_pct: r1(prod[0].share) } : null,
    controlled_share_pct: r1(controlled), any_measure_share_pct: r1(anyMeasure), restriction_weighted_hhi: Math.round(rwHHI),
    bans_or_quotas_share_pct: r1(hardShare),
    controlled_producers: prod.filter((p) => p.control).map((p) => `${p.country} ${r1(p.share)}%${p.hard ? " (ban or quota)" : " (licensing only)"}`),
    new_measures_2020_2024: newMeasures,
    stability_weighted_hhi: Math.round(swHHI), low_stability_share_pct: r1(lowStab), share_without_stability_score_pct: r1(noScore),
    supply_weighted_stability: wTot > 0 ? Math.round(withScore.reduce((a, p) => a + p.share * (p.stability as number), 0) / wTot) : null,
  };
}

async function loadRows(mineral?: string): Promise<Row[]> {
  return (await q(`SELECT s.id, s.mineral, m.label, s.usgs_commodity, s.usgs_stage, s.hs6, m.restriction_commodities, s.trade_form, s.flag
                   FROM markets.risk_mineral_stages s JOIN markets.risk_minerals m USING (mineral) WHERE s.usgs_stage IS NOT NULL ${mineral ? `AND s.mineral = '${esc(mineral)}'` : ""} ORDER BY s.id`))
    .map((r) => ({ ...r, hs6: arr(r.hs6), restriction_commodities: arr(r.restriction_commodities) })) as unknown as Row[];
}

export async function supplyRisk(input: Record<string, unknown>): Promise<Out> {
  const mineralIn = String(input.commodity ?? input.mineral ?? "").trim().toLowerCase();
  const importerIn = String(input.importer ?? "").trim();
  const rankBy = ["restriction_weighted_hhi", "controlled_share", "hhi", ...(WGI_ENABLED ? ["stability_weighted_hhi", "low_stability_share"] : [])].includes(String(input.rank_by)) ? String(input.rank_by) : "restriction_weighted_hhi";
  const topN = Math.max(5, Math.min(40, Number(input.top_n) || 15));
  const evidence: Evidence[] = [{ kind: "data", label: CREDITS.usgs, detail: "production shares by stage" }, { kind: "data", label: CREDITS.oecd, detail: `measures in force in ${YEAR}` }, ...(WGI_ENABLED ? [{ kind: "data" as const, label: CREDITS.wgi, detail: "Political Stability scores (perception-based; not definitive criteria for investment decisions)" }] : [])];

  // ---- league table across minerals ---------------------------------------------------------------------------------------------------
  if (!mineralIn) {
    const rows = await loadRows();
    const d = await stageData(rows.map((r) => r.id));
    await addIeaStages(d, rows, null);
    evidence.push({ kind: "data", label: CREDITS.iea, detail: "refining and battery-grade graphite shares by country, 2025 (projection base year)" });
    const scored = rows.map((r) => ({ r, s: scoreStage(r.id, d) })).filter((x) => x.s) as { r: Row; s: NonNullable<ReturnType<typeof scoreStage>> }[];
    const key = (x: (typeof scored)[number]) => (rankBy === "hhi" ? x.s.hhi : rankBy === "controlled_share" ? x.s.controlled_share_pct ?? 0 : rankBy === "stability_weighted_hhi" ? x.s.stability_weighted_hhi : rankBy === "low_stability_share" ? x.s.low_stability_share_pct ?? 0 : x.s.restriction_weighted_hhi);
    scored.sort((a, b) => key(b) - key(a) || b.s.hhi - a.s.hhi);
    const top = scored.slice(0, topN);
    const both = scored.filter((x) => x.s.hhi >= 2500 && (x.s.controlled_share_pct ?? 0) >= 50);
    const licOnly = top.slice(0, 8).filter((x) => x.s.controlled_producers.some((c) => c.includes("licensing only")) && (x.s.bans_or_quotas_share_pct ?? 0) < 1);
    const statements = [
      `Ranked by ${rankBy === "hhi" ? "concentration (HHI)" : rankBy === "controlled_share" ? "share of world supply from producers with export controls in force" : rankBy === "stability_weighted_hhi" ? "stability-weighted HHI (concentration weighted by producers' political instability, World Bank WGI)" : rankBy === "low_stability_share" ? "share of world supply from producers with low political stability (World Bank WGI estimate below -1)" : "restriction-weighted HHI (concentration among producers with export controls in force)"}, the top five mineral stages are: ${top.slice(0, 5).map((x) => `${x.r.label} ${STAGE_LABEL[x.r.usgs_stage] ?? x.r.usgs_stage} (restriction-weighted HHI ${x.s.restriction_weighted_hhi}; ${x.s.controlled_share_pct}% of supply under export controls; top producer ${x.s.top?.country} ${x.s.top?.share_pct}%)`).join("; ")}.`,
      `${both.length} of ${scored.length} mineral stages are both highly concentrated (HHI 2,500 or more) and have at least half of world supply from producers with export controls in force in ${YEAR}: ${both.map((x) => `${x.r.label} ${STAGE_LABEL[x.r.usgs_stage] ?? x.r.usgs_stage}`).join(", ")}.`,
      ...(licOnly.length ? [`In ${licOnly.map((x) => x.r.label).join(", ")} the export controls counted are licensing only (no ban or quota in force in ${YEAR}); licensing ranges from routine permits to licences that work as bans, so check the documents before treating these as restrictions.`] : []),
      ...(WGI_ENABLED ? [`Political stability (World Bank WGI ${d.govYear}; low = Political Stability estimate below -1, about one standard deviation below the world average: ${d.lowCount} of ${d.scoredCount} countries): the stages with the largest share of supply from low-stability producers are ${[...scored].sort((a, b) => (b.s.low_stability_share_pct ?? 0) - (a.s.low_stability_share_pct ?? 0)).slice(0, 5).map((x) => `${x.r.label} ${STAGE_LABEL[x.r.usgs_stage] ?? x.r.usgs_stage} ${x.s.low_stability_share_pct}%`).join(", ")}.`] : []),
      `Least exposed by this measure: ${scored.slice(-4).map((x) => `${x.r.label} ${STAGE_LABEL[x.r.usgs_stage] ?? x.r.usgs_stage} (${x.s.controlled_share_pct ?? 0}% under controls, HHI ${x.s.hhi})`).join("; ")}.`,
    ];
    const dataset: Dataset = {
      id: "risk-league-" + Date.now().toString(36),
      title: `Critical-mineral supply risk by stage: concentration and export controls in force (${YEAR})`,
      columns: ["Mineral", "Stage", "Year", "Top producer", "Top share (%)", "HHI", "Supply under export controls (%)", "Of which bans or quotas (%)", "Under any measure incl. export taxes (%)", "Restriction-weighted HHI", "New measures 2020-2024 (producers)", ...(WGI_ENABLED ? ["Stability-weighted HHI (WGI)", "Supply from low-stability producers (%)"] : [])],
      rows: scored.map((x) => [x.r.label, STAGE_LABEL[x.r.usgs_stage] ?? x.r.usgs_stage, Number(x.s.group.data_year), x.s.top?.country ?? null, x.s.top?.share_pct ?? null, x.s.hhi, x.s.controlled_share_pct, x.s.bans_or_quotas_share_pct, x.s.any_measure_share_pct, x.s.restriction_weighted_hhi, x.s.new_measures_2020_2024, ...(WGI_ENABLED ? [x.s.stability_weighted_hhi, x.s.low_stability_share_pct] : [])]),
      bars: { unit: "restriction-weighted HHI (0-10,000)", legend: ["Restriction-weighted HHI", "HHI"], items: top.slice(0, 12).map((x) => ({ label: `${x.r.label} (${STAGE_LABEL[x.r.usgs_stage] ?? x.r.usgs_stage})`, value: x.s.restriction_weighted_hhi, compare: x.s.hhi })) },
    };
    return {
      content: JSON.stringify({
        what: "Geopolitical supply-risk league table of critical-mineral stages: concentration of production and the share coming from producers with export controls in force. Recorded behaviour, not a forecast.",
        ranked_by: rankBy, statements,
        rows: top.map((x) => ({ mineral_key: x.r.mineral, mineral: x.r.label, stage: STAGE_LABEL[x.r.usgs_stage] ?? x.r.usgs_stage, year: x.s.group.data_year, top_producer: x.s.top, hhi: x.s.hhi, supply_under_export_controls_pct: x.s.controlled_share_pct, of_which_bans_or_quotas_pct: x.s.bans_or_quotas_share_pct, under_any_measure_incl_taxes_pct: x.s.any_measure_share_pct, restriction_weighted_hhi: x.s.restriction_weighted_hhi, controlled_producers: x.s.controlled_producers.slice(0, 5), new_measures_2020_2024: x.s.new_measures_2020_2024, ...(WGI_ENABLED ? { stability_weighted_hhi: x.s.stability_weighted_hhi, low_stability_share_pct: x.s.low_stability_share_pct, supply_weighted_stability: x.s.supply_weighted_stability } : {}) })),
        stages_covered: scored.length,
        how_to_read: HOW,
        how_to_answer: "Quote the statements and the rows for every number; explain the two dimensions (concentration, export controls in force) and the restriction-weighted HHI in one or two plain sentences; then search the documents for measures since 2024 and cite them. Do not add minerals, producers or measures not listed, and do not turn this into a probability or a price forecast." + (WGI_ENABLED ? " Whenever you quote a political-stability figure, name the source as the World Bank Worldwide Governance Indicators (2026 update) and say in one phrase that the scores are perception-based and, as the World Bank advises, not definitive criteria for investment decisions." : " Political-stability scores are not available at present; do not supply them from memory."),
        credits: [CREDITS.usgs, CREDITS.oecd, ...(WGI_ENABLED ? [CREDITS.wgi] : []), CREDITS.iea],
      }),
      evidence,
      datasets: [dataset],
    };
  }

  // ---- one mineral ----------------------------------------------------------------------------------------------------------------------
  const key = ALIASES[mineralIn] ?? mineralIn.replace(/\s+/g, "_");
  const minerals = await q(`SELECT mineral, label FROM markets.risk_minerals`);
  const mm = minerals.find((m) => m.mineral === key) ?? minerals.find((m) => String(m.label).toLowerCase().startsWith(mineralIn));
  if (!mm) return { content: `No risk data for "${mineralIn}". Minerals covered: ${minerals.map((m) => m.label).join("; ")}.` };
  const rows = await loadRows(String(mm.mineral));
  if (!rows.length) return { content: `${mm.label} has no USGS production table by country, so no supply-risk score can be computed; the supply-disruption scenario tool still gives trade and restriction history.` };
  const d = await stageData(rows.map((r) => r.id));
  await addIeaStages(d, rows, String(mm.mineral));
  const outlook = await ieaOutlook(String(mm.mineral));
  if (outlook.length) evidence.push({ kind: "data", label: CREDITS.iea, detail: `${mm.label}: projected supply by country 2025-2040 (base case)` });
  const stages = rows.map((r) => ({ r, s: scoreStage(r.id, d) })).filter((x) => x.s) as { r: Row; s: NonNullable<ReturnType<typeof scoreStage>> }[];
  const statements: string[] = [];
  const datasets: Dataset[] = [];
  for (const { r, s } of stages) {
    const st = STAGE_LABEL[r.usgs_stage] ?? r.usgs_stage;
    statements.push(`${r.label}, ${st} (${s.group.data_year}${r.usgs_commodity === "IEA" ? ", IEA base year of its projections" : s.group.is_estimate ? ", USGS estimate" : ""}): top producer ${s.top?.country} ${s.top?.share_pct}%, HHI ${s.hhi}; ${s.controlled_share_pct}% of world supply comes from producers with export controls in force in ${YEAR}${s.controlled_producers.length ? ` (${s.controlled_producers.slice(0, 6).join(", ")})` : ""}, of which ${s.bans_or_quotas_share_pct}% under bans or quotas, and ${s.any_measure_share_pct}% counting export taxes too; restriction-weighted HHI ${s.restriction_weighted_hhi}; producers introduced or tightened ${s.new_measures_2020_2024} measures in 2020-2024.${WGI_ENABLED ? ` Political stability (World Bank WGI ${d.govYear}): supply-weighted average score ${s.supply_weighted_stability ?? "n/a"}/100, ${s.low_stability_share_pct}% of supply from low-stability producers (WGI estimate below -1), stability-weighted HHI ${s.stability_weighted_hhi}${(s.share_without_stability_score_pct ?? 0) > 0 ? ` (${s.share_without_stability_score_pct}% of supply from producers without a score, weighted at 0.5)` : ""}.` : ""}`);
    datasets.push({ id: `risk-${r.id}`, title: `${r.label}, ${st}: producers and export measures in force (${YEAR})`, columns: ["Producer", "Share (%)", "Export controls in force", "Ban or quota", "Export taxes etc. in force", "Measures in force", "New or tightened measures 2020-2024", "Latest new measure", ...(WGI_ENABLED ? ["Political stability score (WGI, 0-100)", "Average of six WGI scores"] : [])], rows: s.producers.slice(0, 20).map((p) => [p.country, r1(p.share), p.control ? "yes" : "no", p.hard ? "yes" : "no", p.fiscal ? "yes" : "no", p.types, p.new_since_2020, p.last_new, ...(WGI_ENABLED ? [p.stability, p.governance_avg] : [])]) });
  }

  // IEA outlook: projected concentration 2025 -> 2035 -> 2040 by stage (base case: announced projects weighted by likelihood)
  for (const st of [...new Set(outlook.map((o) => o.stage))]) {
    const o = outlook.filter((x) => x.stage === st).sort((a, b) => a.year - b.year);
    const a = o.find((x) => x.year === 2025), b = o.find((x) => x.year === 2035), c = o.find((x) => x.year === 2040);
    if (!a || !b) continue;
    const dir = b.hhi_top6 < a.hhi_top6 - 250 ? "less concentrated" : b.hhi_top6 > a.hhi_top6 + 250 ? "more concentrated" : "about as concentrated";
    statements.push(`IEA outlook (Global Critical Minerals Outlook 2026, base case - a projection from announced projects weighted by their likelihood, not recorded data), ${mm.label} ${st.toLowerCase()}: ${a.top} ${a.top_share_pct}% of ${a.total_kt.toLocaleString("en-US")} kt in 2025 (top three ${a.top3_share_pct}%, HHI of the six named countries ${a.hhi_top6}); in 2035 ${b.top} ${b.top_share_pct}% (top three ${b.top3_share_pct}%, HHI ${b.hhi_top6})${c ? `, in 2040 ${c.top} ${c.top_share_pct}%` : ""} - ${dir} by 2035.`);
  }

  // importer view: share of the importer's imports of each stage's codes coming from exporters with controls in force
  let importer: Q | null = null;
  if (importerIn) {
    const iso = IMPORTER_ALIASES[importerIn.toLowerCase()] ?? (/^[A-Za-z]{3}$/.test(importerIn) ? importerIn.toUpperCase() : ((await q(`SELECT core.iso3_of('${esc(importerIn)}') AS iso`))[0]?.iso as string | null));
    if (!iso) importer = { error: `Importer "${importerIn}" not recognised.` };
    else {
      const isos = iso === "EU27" ? EU27 : [iso];
      const nm = new Map((await q(`SELECT iso_code3, name FROM core.jurisdictions WHERE level = 'COUNTRY' AND iso_code3 IS NOT NULL`, 400)).map((x) => [String(x.iso_code3), String(x.name)]));
      const nameOf = (i: string) => DISPLAY[i] ?? nm.get(i) ?? (i === "null" || !i ? "Taiwan (reported as Other Asia)" : i);
      const out: Q[] = [];
      for (const { r } of stages) {
        if (!r.hs6.length || ["gallium", "germanium", "indium", "rhenium"].includes(r.mineral)) { out.push({ stage: STAGE_LABEL[r.usgs_stage] ?? r.usgs_stage, note: "no usable trade codes for this stage" }); continue; }
        const fl = await q(`SELECT te.iso3 AS exp, sum(t.value_kusd)/3.0 AS v FROM markets.trade_flows t JOIN markets.trade_countries ti ON ti.country_code = t.importer_code JOIN markets.trade_countries te ON te.country_code = t.exporter_code
           WHERE t.hs6 IN (${r.hs6.map((h) => `'${h}'`).join(",")}) AND t.year BETWEEN 2022 AND 2024 AND ti.iso3 IN (${isos.map((i) => `'${i}'`).join(",")}) ${iso === "EU27" ? `AND te.iso3 NOT IN (${EU27.map((i) => `'${i}'`).join(",")})` : ""} GROUP BY 1`, 400);
        const ctl = new Set((await q(`SELECT DISTINCT e.country_iso3 FROM markets.export_restrictions e WHERE e.commodity IN (${r.restriction_commodities.map((c) => `'${esc(c)}'`).join(",")}) AND e.hs6 IN (${r.hs6.map((h) => `'${h}'`).join(",")})
           AND e.year = ${YEAR} AND coalesce(e.direction_of_change, '') <> 'elimination' AND e.measure_type IN (${CONTROL.map((c) => `'${esc(c)}'`).join(",")})`)).map((x) => String(x.country_iso3)));
        const tot = fl.reduce((a, x) => a + Number(x.v ?? 0), 0);
        const lowSet = new Set(!WGI_ENABLED ? [] : (await q(`SELECT iso3 FROM core.country_governance WHERE dimension = 'PV' AND year = ${d.govYear} AND estimate < -1`, 400)).map((x) => String(x.iso3).trim()));
        const fromLow = fl.filter((x) => lowSet.has(String(x.exp))).reduce((a, x) => a + Number(x.v ?? 0), 0);
        const fromCtl = fl.filter((x) => ctl.has(String(x.exp))).reduce((a, x) => a + Number(x.v ?? 0), 0);
        const top = [...fl].sort((a, b) => Number(b.v) - Number(a.v)).slice(0, 5).map((x) => `${nameOf(String(x.exp))} ${r1((100 * Number(x.v)) / tot)}%${ctl.has(String(x.exp)) ? " (controls in force)" : ""}`);
        out.push({ stage: STAGE_LABEL[r.usgs_stage] ?? r.usgs_stage, codes: r.hs6, imports_per_year_usd_million: r1(tot / 1000), share_from_exporters_with_export_controls_pct: tot > 0 ? r1((100 * fromCtl) / tot) : null, ...(WGI_ENABLED ? { share_from_low_stability_exporters_pct: tot > 0 ? r1((100 * fromLow) / tot) : null } : {}), top_suppliers: top });
        if (tot > 0) statements.push(`${iso === "EU27" ? "EU-27 (imports from outside the EU)" : nameOf(iso)}, ${STAGE_LABEL[r.usgs_stage] ?? r.usgs_stage} products (HS ${r.hs6.join(", ")}): US$${r1(tot / 1000)} million a year in 2022-2024, ${r1((100 * fromCtl) / tot)}% from exporters with export controls in force in ${YEAR}${WGI_ENABLED ? ` and ${r1((100 * fromLow) / tot)}% from low-political-stability exporters (World Bank WGI)` : ""}; main suppliers ${top.join(", ")}.`);
      }
      if (iso === "EU27") {
        const names = RMIS[String(mm.mineral)] ?? [String(mm.label).split(" ")[0]];
        const ri = await q(`SELECT indicator, material, value_numeric FROM markets.rmis_indicators WHERE indicator IN ('ir1', 'ir2', 'eolrir') AND material IN (${names.map((n) => `'${esc(n)}'`).join(",")}) AND value_numeric IS NOT NULL`);
        const get = (k: string) => ri.find((x) => x.indicator === k)?.value_numeric ?? null;
        if (ri.length) {
          evidence.push({ kind: "data", label: CREDITS.rmis, detail: names.join(", ") });
          statements.push(`EU indicators (2023 CRM assessment, 2016-2020 data): import reliance ${get("ir1") !== null ? `${get("ir1")}% for primary material` : "n/a for primary material"}${get("ir2") !== null ? `, ${get("ir2")}% for processed/refined` : ""}; end-of-life recycling input rate ${get("eolrir") !== null ? `${get("eolrir")}%` : "n/a"}.`);
        }
      }
      importer = { importer: iso === "EU27" ? "EU-27" : nameOf(iso), by_stage: out };
      evidence.push({ kind: "data", label: CREDITS.baci, detail: "2022-2024 imports by supplier" });
    }
  }
  const flags = [...new Set(stages.map((x) => x.r.flag).filter(Boolean))];
  return {
    content: JSON.stringify({
      mineral_key: mm.mineral, mineral: mm.label,
      what: `Geopolitical supply risk for ${mm.label} by stage: concentration and export controls in force (${YEAR}). Recorded behaviour, not a forecast.`,
      statements,
      stages: stages.map(({ r, s }) => ({ stage: STAGE_LABEL[r.usgs_stage] ?? r.usgs_stage, year: s.group.data_year, hhi: s.hhi, top_producer: s.top, supply_under_export_controls_pct: s.controlled_share_pct, of_which_bans_or_quotas_pct: s.bans_or_quotas_share_pct, under_any_measure_incl_taxes_pct: s.any_measure_share_pct, restriction_weighted_hhi: s.restriction_weighted_hhi, producers: s.producers.slice(0, 10).map((p) => ({ country: p.country, share_pct: r1(p.share), export_controls: p.control, ban_or_quota: p.hard, export_taxes: p.fiscal, measures: p.types, new_measures_2020_2024: p.new_since_2020, ...(WGI_ENABLED ? { political_stability_score: p.stability, governance_average: p.governance_avg } : {}) })), ...(WGI_ENABLED ? { stability_weighted_hhi: s.stability_weighted_hhi, low_stability_share_pct: s.low_stability_share_pct, supply_weighted_stability: s.supply_weighted_stability } : {}) })),
      importer_view: importer,
      iea_outlook: outlook.length ? { note: "IEA base-case projections (Global Critical Minerals Outlook 2026): operating and announced projects weighted by probability of coming online; top six countries named.", rows: outlook } : null,
      notes: flags,
      how_to_read: HOW,
      how_to_answer: "Quote the statements for every number; explain concentration, the share under export controls and the restriction-weighted HHI in plain words; give the importer view if asked; then search the documents for measures since 2024 and cite them. Never give a probability or a price forecast, and do not add producers or measures not listed. For what a cut would do, offer the supply-disruption scenario." + (WGI_ENABLED ? " Whenever you quote a political-stability figure, name the source as the World Bank Worldwide Governance Indicators (2026 update) and say in one phrase that the scores are perception-based and, as the World Bank advises, not definitive criteria for investment decisions." : " Political-stability scores are not available at present; do not supply them from memory."),
      credits: Object.values(CREDITS).filter((c) => WGI_ENABLED || c !== CREDITS.wgi),
      caveat_wgi: !WGI_ENABLED ? undefined : "World Bank WGI scores are perception-based composites with confidence bands; the World Bank advises they should not serve as definitive criteria for investment or other critical financial decisions.",
    }),
    evidence,
    datasets,
  };
}
