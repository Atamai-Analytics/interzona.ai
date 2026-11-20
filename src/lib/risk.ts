import { runReadOnlyQuery } from "@/lib/db";
import type { Dataset, Evidence } from "@/lib/types";

// Geopolitical supply risk by mineral and stage, from observed behaviour rather than governance perceptions: how concentrated production is
// (USGS MCS 2026) and how much of it comes from producers with export controls in force (OECD export-restriction inventory, 2024), plus,
// for an importer, how much of its imports come from controlled suppliers (CEPII BACI 2022-2024). Single ranking number: the
// restriction-weighted HHI = the HHI counted over producers with export controls in force only (0-10,000). Every number and sentence is
// computed HERE. No World Bank governance indicators are used (licence terms unclear for commercial use, 20 Nov 2026).

type Out = { content: string; evidence?: Evidence[]; datasets?: Dataset[] };
type Q = Record<string, unknown>;
const esc = (s: string) => s.replace(/'/g, "''");
const r1 = (x: number | null | undefined) => (x === null || x === undefined || !isFinite(x) ? null : Math.round(x * 10) / 10);
const q = async (sql: string, max = 2000) => (await runReadOnlyQuery(sql, max)).rows as unknown as Q[];

const YEAR = 2024; // last year of the OECD inventory
const CONTROL = ["Export prohibition", "Export quota", "Licensing requirement", "Qualified exporters list", "Domestic market obligation", "Captive mining"];
const HARD = ["Export prohibition", "Export quota", "Domestic market obligation", "Captive mining"];
const FISCAL = ["Export tax", "Export surtax", "Fiscal tax on exports", "VAT tax rebate reduction / withdrawal", "Minimum export price / price reference for exports"];
const STAGE_LABEL: Record<string, string> = { mine_production: "mine production", refinery_production: "refinery production", smelter_production: "smelter production", primary_production: "primary production", sponge_production: "sponge production", production: "production" };
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
};

const HOW =
  "Licensing ranges from routine export permits (for example South Africa's precious-metal export approvals, Brazil's authorisation for niobium-tantalum ores) to licences that work as bans; the data do not say which, so each producer is marked 'ban or quota' or 'licensing only' and the share under bans or quotas is given separately. " +
  "Export controls = an export ban, quota, licensing requirement (including non-automatic licensing, which can work as a ban: Indonesia's nickel-ore ban has been recorded as licensing since November 2021, and China's 2023 gallium, germanium and graphite controls are licensing), " +
  "qualified-exporter list, domestic market obligation or captive-mining rule in force in 2024 on that stage's products in the OECD inventory; fiscal measures (export taxes, rebate cuts, minimum prices) are counted separately. " +
  "Restriction-weighted HHI = the Herfindahl-Hirschman index counted over producers with export controls in force only (0-10,000): high when supply is concentrated in countries that already control exports. " +
  "It measures recorded behaviour, not intentions or political stability, and no governance index is used. The OECD inventory ends in 2024: measures since then (for example China's 2025 rare-earth and magnet controls, the DRC's 2025 cobalt ban and quotas) are not counted - search the documents for them. " +
  "USGS shares are estimates and count named countries only; production location is not ownership.";

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
  return { groups, shares, measures, recent };
}

function scoreStage(id: number, d: Awaited<ReturnType<typeof stageData>>) {
  const g = d.groups.find((x) => x.id === id);
  if (!g) return null;
  const prod = d.shares.filter((s) => s.group_id === g.group_id).map((s) => {
    const m = d.measures.find((x) => x.id === id && x.iso3 === s.iso3);
    const rc = d.recent.find((x) => x.id === id && x.iso3 === s.iso3);
    return { country: DISPLAY[String(s.iso3)] ?? String(s.country), iso3: String(s.iso3), share: Number(s.share), control: !!m?.control, hard: !!m?.hard, fiscal: !!m?.fiscal, types: (m?.types as string) ?? null, new_since_2020: Number(rc?.k ?? 0), last_new: (rc?.last as string) ?? null };
  }).sort((a, b) => b.share - a.share);
  const sum = (f: (p: (typeof prod)[number]) => boolean) => prod.filter(f).reduce((a, p) => a + p.share, 0);
  const controlled = sum((p) => p.control);
  const anyMeasure = sum((p) => p.control || p.fiscal);
  const hardShare = sum((p) => p.hard);
  const rwHHI = prod.filter((p) => p.control).reduce((a, p) => a + p.share * p.share, 0);
  const newMeasures = prod.reduce((a, p) => a + p.new_since_2020, 0);
  return {
    group: g, producers: prod,
    hhi: Math.round(Number(g.hhi_named)), top: prod[0] ? { country: prod[0].country, share_pct: r1(prod[0].share) } : null,
    controlled_share_pct: r1(controlled), any_measure_share_pct: r1(anyMeasure), restriction_weighted_hhi: Math.round(rwHHI),
    bans_or_quotas_share_pct: r1(hardShare),
    controlled_producers: prod.filter((p) => p.control).map((p) => `${p.country} ${r1(p.share)}%${p.hard ? " (ban or quota)" : " (licensing only)"}`),
    new_measures_2020_2024: newMeasures,
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
  const rankBy = ["restriction_weighted_hhi", "controlled_share", "hhi"].includes(String(input.rank_by)) ? String(input.rank_by) : "restriction_weighted_hhi";
  const topN = Math.max(5, Math.min(40, Number(input.top_n) || 15));
  const evidence: Evidence[] = [{ kind: "data", label: CREDITS.usgs, detail: "production shares by stage" }, { kind: "data", label: CREDITS.oecd, detail: `measures in force in ${YEAR}` }];

  // ---- league table across minerals ---------------------------------------------------------------------------------------------------
  if (!mineralIn) {
    const rows = await loadRows();
    const d = await stageData(rows.map((r) => r.id));
    const scored = rows.map((r) => ({ r, s: scoreStage(r.id, d) })).filter((x) => x.s) as { r: Row; s: NonNullable<ReturnType<typeof scoreStage>> }[];
    const key = (x: (typeof scored)[number]) => (rankBy === "hhi" ? x.s.hhi : rankBy === "controlled_share" ? x.s.controlled_share_pct ?? 0 : x.s.restriction_weighted_hhi);
    scored.sort((a, b) => key(b) - key(a) || b.s.hhi - a.s.hhi);
    const top = scored.slice(0, topN);
    const both = scored.filter((x) => x.s.hhi >= 2500 && (x.s.controlled_share_pct ?? 0) >= 50);
    const licOnly = top.slice(0, 8).filter((x) => x.s.controlled_producers.some((c) => c.includes("licensing only")) && (x.s.bans_or_quotas_share_pct ?? 0) < 1);
    const statements = [
      `Ranked by ${rankBy === "hhi" ? "concentration (HHI)" : rankBy === "controlled_share" ? "share of world supply from producers with export controls in force" : "restriction-weighted HHI (concentration among producers with export controls in force)"}, the top five mineral stages are: ${top.slice(0, 5).map((x) => `${x.r.label} ${STAGE_LABEL[x.r.usgs_stage] ?? x.r.usgs_stage} (restriction-weighted HHI ${x.s.restriction_weighted_hhi}; ${x.s.controlled_share_pct}% of supply under export controls; top producer ${x.s.top?.country} ${x.s.top?.share_pct}%)`).join("; ")}.`,
      `${both.length} of ${scored.length} mineral stages are both highly concentrated (HHI 2,500 or more) and have at least half of world supply from producers with export controls in force in ${YEAR}: ${both.map((x) => `${x.r.label} ${STAGE_LABEL[x.r.usgs_stage] ?? x.r.usgs_stage}`).join(", ")}.`,
      ...(licOnly.length ? [`In ${licOnly.map((x) => x.r.label).join(", ")} the export controls counted are licensing only (no ban or quota in force in ${YEAR}); licensing ranges from routine permits to licences that work as bans, so check the documents before treating these as restrictions.`] : []),
      `Least exposed by this measure: ${scored.slice(-4).map((x) => `${x.r.label} ${STAGE_LABEL[x.r.usgs_stage] ?? x.r.usgs_stage} (${x.s.controlled_share_pct ?? 0}% under controls, HHI ${x.s.hhi})`).join("; ")}.`,
    ];
    const dataset: Dataset = {
      id: "risk-league-" + Date.now().toString(36),
      title: `Critical-mineral supply risk by stage: concentration and export controls in force (${YEAR})`,
      columns: ["Mineral", "Stage", "Year", "Top producer", "Top share (%)", "HHI", "Supply under export controls (%)", "Of which bans or quotas (%)", "Under any measure incl. export taxes (%)", "Restriction-weighted HHI", "New measures 2020-2024 (producers)"],
      rows: scored.map((x) => [x.r.label, STAGE_LABEL[x.r.usgs_stage] ?? x.r.usgs_stage, Number(x.s.group.data_year), x.s.top?.country ?? null, x.s.top?.share_pct ?? null, x.s.hhi, x.s.controlled_share_pct, x.s.bans_or_quotas_share_pct, x.s.any_measure_share_pct, x.s.restriction_weighted_hhi, x.s.new_measures_2020_2024]),
      bars: { unit: "restriction-weighted HHI (0-10,000)", legend: ["Restriction-weighted HHI", "HHI"], items: top.slice(0, 12).map((x) => ({ label: `${x.r.label} (${STAGE_LABEL[x.r.usgs_stage] ?? x.r.usgs_stage})`, value: x.s.restriction_weighted_hhi, compare: x.s.hhi })) },
    };
    return {
      content: JSON.stringify({
        what: "Geopolitical supply-risk league table of critical-mineral stages: concentration of production and the share coming from producers with export controls in force. Recorded behaviour, not a forecast.",
        ranked_by: rankBy, statements,
        rows: top.map((x) => ({ mineral: x.r.label, stage: STAGE_LABEL[x.r.usgs_stage] ?? x.r.usgs_stage, year: x.s.group.data_year, top_producer: x.s.top, hhi: x.s.hhi, supply_under_export_controls_pct: x.s.controlled_share_pct, of_which_bans_or_quotas_pct: x.s.bans_or_quotas_share_pct, under_any_measure_incl_taxes_pct: x.s.any_measure_share_pct, restriction_weighted_hhi: x.s.restriction_weighted_hhi, controlled_producers: x.s.controlled_producers.slice(0, 5), new_measures_2020_2024: x.s.new_measures_2020_2024 })),
        stages_covered: scored.length,
        how_to_read: HOW,
        how_to_answer: "Quote the statements and the rows for every number; explain the two dimensions (concentration, export controls in force) and the restriction-weighted HHI in one or two plain sentences; then search the documents for measures since 2024 and cite them. Do not add minerals, producers or measures not listed, and do not turn this into a probability or a price forecast.",
        credits: Object.values(CREDITS).slice(0, 2),
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
  const stages = rows.map((r) => ({ r, s: scoreStage(r.id, d) })).filter((x) => x.s) as { r: Row; s: NonNullable<ReturnType<typeof scoreStage>> }[];
  const statements: string[] = [];
  const datasets: Dataset[] = [];
  for (const { r, s } of stages) {
    const st = STAGE_LABEL[r.usgs_stage] ?? r.usgs_stage;
    statements.push(`${r.label}, ${st} (${s.group.data_year}${s.group.is_estimate ? ", USGS estimate" : ""}): top producer ${s.top?.country} ${s.top?.share_pct}%, HHI ${s.hhi}; ${s.controlled_share_pct}% of world supply comes from producers with export controls in force in ${YEAR}${s.controlled_producers.length ? ` (${s.controlled_producers.slice(0, 6).join(", ")})` : ""}, of which ${s.bans_or_quotas_share_pct}% under bans or quotas, and ${s.any_measure_share_pct}% counting export taxes too; restriction-weighted HHI ${s.restriction_weighted_hhi}; producers introduced or tightened ${s.new_measures_2020_2024} measures in 2020-2024.`);
    datasets.push({ id: `risk-${r.id}`, title: `${r.label}, ${st}: producers and export measures in force (${YEAR})`, columns: ["Producer", "Share (%)", "Export controls in force", "Ban or quota", "Export taxes etc. in force", "Measures in force", "New or tightened measures 2020-2024", "Latest new measure"], rows: s.producers.slice(0, 20).map((p) => [p.country, r1(p.share), p.control ? "yes" : "no", p.hard ? "yes" : "no", p.fiscal ? "yes" : "no", p.types, p.new_since_2020, p.last_new]) });
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
        const fromCtl = fl.filter((x) => ctl.has(String(x.exp))).reduce((a, x) => a + Number(x.v ?? 0), 0);
        const top = [...fl].sort((a, b) => Number(b.v) - Number(a.v)).slice(0, 5).map((x) => `${nameOf(String(x.exp))} ${r1((100 * Number(x.v)) / tot)}%${ctl.has(String(x.exp)) ? " (controls in force)" : ""}`);
        out.push({ stage: STAGE_LABEL[r.usgs_stage] ?? r.usgs_stage, codes: r.hs6, imports_per_year_usd_million: r1(tot / 1000), share_from_exporters_with_export_controls_pct: tot > 0 ? r1((100 * fromCtl) / tot) : null, top_suppliers: top });
        if (tot > 0) statements.push(`${iso === "EU27" ? "EU-27 (imports from outside the EU)" : nameOf(iso)}, ${STAGE_LABEL[r.usgs_stage] ?? r.usgs_stage} products (HS ${r.hs6.join(", ")}): US$${r1(tot / 1000)} million a year in 2022-2024, ${r1((100 * fromCtl) / tot)}% from exporters with export controls in force in ${YEAR}; main suppliers ${top.join(", ")}.`);
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
      what: `Geopolitical supply risk for ${mm.label} by stage: concentration and export controls in force (${YEAR}). Recorded behaviour, not a forecast.`,
      statements,
      stages: stages.map(({ r, s }) => ({ stage: STAGE_LABEL[r.usgs_stage] ?? r.usgs_stage, year: s.group.data_year, hhi: s.hhi, top_producer: s.top, supply_under_export_controls_pct: s.controlled_share_pct, of_which_bans_or_quotas_pct: s.bans_or_quotas_share_pct, under_any_measure_incl_taxes_pct: s.any_measure_share_pct, restriction_weighted_hhi: s.restriction_weighted_hhi, producers: s.producers.slice(0, 10).map((p) => ({ country: p.country, share_pct: r1(p.share), export_controls: p.control, ban_or_quota: p.hard, export_taxes: p.fiscal, measures: p.types, new_measures_2020_2024: p.new_since_2020 })) })),
      importer_view: importer,
      notes: flags,
      how_to_read: HOW,
      how_to_answer: "Quote the statements for every number; explain concentration, the share under export controls and the restriction-weighted HHI in plain words; give the importer view if asked; then search the documents for measures since 2024 and cite them. Never give a probability or a price forecast, and do not add producers or measures not listed. For what a cut would do, offer the supply-disruption scenario.",
      credits: Object.values(CREDITS),
    }),
    evidence,
    datasets,
  };
}
