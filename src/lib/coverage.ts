import { getPool } from "@/lib/db";

// What the database holds, for the intro panel. Read live (so the panel never goes stale as data is added) and kept in memory for six hours.
// Analyses (about 80 million rows) and other big tables are counted from the planner's row estimates (pg_class.reltuples), which are
// instant and accurate to within a few per cent after ANALYZE; the panel rounds them.

export type Coverage = {
  occurrences: number;
  occurrenceCountries: number;
  samples: number;
  documents: number;
  projects: number;
  projectsPlaced: number;
  companies: number;
  companiesMultiYear: number;
  firstFiscalYear: number | null;
  lastFiscalYear: number | null;
  priceSeries: number;
  monthlySeries: number;
  latestMonthly: string | null;
  analyses: number;
  sampleSurveys: number;
  drillHoles: number;
  facilitySites: number;
  facilityCountries: number;
  tradeFlows: number;
  exportRestrictionCountries: number;
  eitiCountries: number;
  rmisMaterials: number;
  asOf: string;
};

const TTL_MS = 6 * 3600_000;
let cache: { at: number; value: Coverage } | null = null;

const num = (v: unknown) => Number(v ?? 0);

export async function getCoverage(): Promise<Coverage> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const client = await getPool().connect();
  try {
    await client.query("SET statement_timeout = 8000");
    const one = async (sql: string) => (await client.query(sql)).rows[0] as Record<string, unknown>;
    const a = await one(`select
        (select count(*) from core.occurrences where is_active) occurrences,
        (select count(distinct country_name) from core.occurrences where is_active and country_name is not null) countries,
        (select count(*) from geochem.samples) samples,
        (select count(*) from docs.documents) documents,
        (select count(*) from core.projects) projects,
        (select count(*) from core.projects p left join core.occurrences o on o.occurrence_id = p.occurrence_id and o.is_active
           where (o.occurrence_id is not null and o.position_accuracy is distinct from 'UNRELIABLE') or p.geom is not null) projects_placed`);
    const b = await one(`select
        (select count(distinct company_id) from financials.income_statement where period_type = 'FY') companies,
        (select count(*) from (select company_id from financials.income_statement where period_type = 'FY' group by company_id having count(*) >= 3) x) multi,
        (select min(extract(year from period_end_date))::int from financials.income_statement where period_type = 'FY') first_fy,
        (select max(extract(year from period_end_date))::int from financials.income_statement where period_type = 'FY') last_fy`);
    const c = await one(`select count(*) series, count(*) filter (where frequency = 'monthly') monthly,
        max(last_period) filter (where frequency = 'monthly') latest_monthly from markets.price_series where is_active`);
    // big tables: planner estimates; the rest are small enough to count
    const est = (rel: string) => `(select greatest(reltuples, 0)::bigint from pg_class where oid = to_regclass('${rel}'))`;
    const d = await one(`select
        (select coalesce(sum(greatest(c.reltuples, 0)), 0)::bigint from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'geochem' and c.relkind = 'r' and c.relname like 'analytical\\_results\\_%') analyses,
        (select count(distinct source_system) from geochem.samples where source_system not in ('SWEDEN_SGU_BEDROCK_AGE', 'GLOBAL_ZIRCON_WU')) surveys,
        ${est("drilling.drillholes")} drill_holes,
        ${est("markets.trade_flows")} trade_flows,
        (select count(distinct occurrence_id) from core.facility_capacity_published) facility_sites,
        (select count(distinct o.country_name) from core.facility_capacity_published f join core.occurrences o on o.occurrence_id = f.occurrence_id and o.is_active) facility_countries,
        (select count(distinct country_iso3) from markets.export_restrictions) export_countries,
        (select count(distinct country_name) from markets.eiti_payments) eiti_countries,
        (select count(distinct material) from markets.rmis_indicators) rmis_materials`);
    const value: Coverage = {
      occurrences: num(a.occurrences),
      occurrenceCountries: num(a.countries),
      samples: num(a.samples),
      documents: num(a.documents),
      projects: num(a.projects),
      projectsPlaced: num(a.projects_placed),
      companies: num(b.companies),
      companiesMultiYear: num(b.multi),
      firstFiscalYear: b.first_fy === null ? null : num(b.first_fy),
      lastFiscalYear: b.last_fy === null ? null : num(b.last_fy),
      priceSeries: num(c.series),
      monthlySeries: num(c.monthly),
      latestMonthly: c.latest_monthly ? new Date(c.latest_monthly as string).toISOString().slice(0, 7) : null,
      analyses: num(d.analyses),
      sampleSurveys: num(d.surveys),
      drillHoles: num(d.drill_holes),
      facilitySites: num(d.facility_sites),
      facilityCountries: num(d.facility_countries),
      tradeFlows: num(d.trade_flows),
      exportRestrictionCountries: num(d.export_countries),
      eitiCountries: num(d.eiti_countries),
      rmisMaterials: num(d.rmis_materials),
      asOf: new Date().toISOString(),
    };
    cache = { at: Date.now(), value };
    return value;
  } finally {
    try {
      await client.query("RESET statement_timeout");
    } catch {
      /* the connection is released either way */
    }
    client.release();
  }
}
