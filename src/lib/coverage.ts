import { getPool } from "@/lib/db";

// What the database holds, for the intro panel. Read live (so the panel never goes stale as data is added) and kept in memory for six hours.
// The count of analyses (about 21 million rows) is too slow to run here, so the panel states it as a round figure.

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
