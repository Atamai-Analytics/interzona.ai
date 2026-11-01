import { getPool } from "@/lib/db";
import { addDerived, financialRows, priceSensitivity, resolveCompanies } from "@/lib/finance-tools";
import type { Dataset } from "@/lib/types";

// A one-page company profile built only from stored data (no generated text), so every figure can be traced to the statements,
// operating data, ownership records and documents behind it.

export type SnapshotRow = { label: string; unit: string; values: (number | null)[]; kind: "usd" | "pct" | "x" };
export type Snapshot = {
  company: { id: number; name: string; ticker: string | null; exchange: string | null; type: string | null; stage: string | null; hq: string | null; peers: string[] };
  reportedCurrency: string;
  latestYear: number;
  latestPeriodEnd: string;
  headline: { label: string; value: string; sub?: string }[];
  bullets: string[];
  history: { years: number[]; rows: SnapshotRow[] };
  charts: { title: string; chart: NonNullable<Dataset["chart"]> }[];
  priceLink: null | { commodity: string; priceSeries: string; priceUnit: string; years: string; strength: string; rSquared: number | null; elasticity: number | null; meaning: string; warning: string | null; note: string };
  operating: { commodity: string; asset: string | null; metric: string; basis: string | null; unit: string; year: number; value: number; source: string }[];
  assetsMore: number;
  assets: { project: string; status: string | null; commodity: string | null; country: string | null; owner: string; share: number | null; asOf: number | null }[];
  documents: string[];
  notes: string[];
  generated: string;
};

// Which commodity price (if any) a company's results can be sensibly tested against, and how.
const PRICE_LINK: [RegExp, { commodity: string; source: "market" | "realised"; label: string }][] = [
  [/cameco|kazatomprom|energy fuels|paladin|boss energy|deep yellow|lotus/i, { commodity: "uranium", source: "market", label: "uranium spot price" }],
  [/impala|sibanye/i, { commodity: "platinum", source: "market", label: "platinum price" }],
  [/glencore/i, { commodity: "copper", source: "market", label: "copper price" }],
  [/rio tinto/i, { commodity: "iron ore", source: "market", label: "iron ore price" }],
  [/south32/i, { commodity: "aluminium", source: "market", label: "aluminium price" }],
  [/lynas/i, { commodity: "rare earth", source: "realised", label: "Lynas realised rare earth price" }],
  [/iluka/i, { commodity: "zircon (all products)", source: "realised", label: "Iluka realised zircon price" }],
];

const fmtUsd = (m: number | null) => {
  if (m === null) return "n/a";
  const sign = m < 0 ? "-" : "";
  const a = Math.abs(m);
  return a >= 1000 ? `${sign}US$${(a / 1000).toLocaleString("en-US", { maximumFractionDigits: 2 })} bn` : `${sign}US$${a.toLocaleString("en-US", { maximumFractionDigits: a >= 100 ? 0 : 1 })} m`;
};
const pct = (v: number | null, dp = 1) => (v === null ? "n/a" : `${(v * 100).toFixed(dp)}%`);

export async function listSnapshotCompanies(): Promise<{ name: string; ticker: string | null; years: number }[]> {
  const r = await getPool().query(
    `SELECT COALESCE(c.short_name, c.name) AS name, c.ticker, count(*)::int AS years FROM core.companies c
     JOIN financials.income_statement i ON i.company_id = c.company_id AND i.period_type = 'FY' AND i.is_active
     WHERE c.is_active GROUP BY 1, 2 HAVING count(*) >= 3 ORDER BY 1`
  );
  return r.rows;
}

export async function companyIdByName(query: string): Promise<number | null> {
  const { ids } = await resolveCompanies([query]);
  return ids[0] ?? null;
}

export async function buildSnapshotById(companyId: number): Promise<Snapshot | null> {
  const pool = getPool();
  const all = await financialRows([companyId]);
  if (all.length === 0) return null;
  for (const r of all) addDerived(r);
  // Same rule as the financials tool: never mix a company-defined EBITDA with a derived one inside one series.
  if (all.some((r) => typeof r.ebitda_reported === "number")) for (const r of all) if (typeof r.ebitda_reported !== "number") { r.ebitda = null; r.ebitda_basis = null; r.net_debt_to_ebitda = null; }

  const meta = (
    await pool.query(
      `SELECT c.company_id, COALESCE(c.short_name, c.name) AS name, c.ticker, c.exchange, c.company_type, c.stage, j.name AS hq,
              (SELECT array_agg(p.name ORDER BY p.name) FROM core.peer_group_members m JOIN core.peer_groups p ON p.peer_group_id = m.peer_group_id WHERE m.company_id = c.company_id AND p.is_active) AS peers
       FROM core.companies c LEFT JOIN core.jurisdictions j ON j.jurisdiction_id = c.hq_jurisdiction_id WHERE c.company_id = $1`,
      [companyId]
    )
  ).rows[0];
  if (!meta) return null;

  const rows = all.slice(-10);
  const cur = String(rows[rows.length - 1].currency);
  const usd = (v: unknown, rate: unknown) => (typeof v === "number" && typeof rate === "number" && rate > 0 ? v / rate / 1e6 : null);
  const flow = (r: Record<string, unknown>, k: string) => usd(r[k], r.fx_avg);
  const stock = (r: Record<string, unknown>, k: string) => usd(r[k], r.fx_eop);
  const year = (r: Record<string, unknown>) => Number(String(r.period_end).slice(0, 4));
  const years = rows.map(year);
  const round = (v: number | null, dp = 1) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 10 ** dp) / 10 ** dp);

  const revenue = rows.map((r) => flow(r, "revenue"));
  const ebitda = rows.map((r) => flow(r, "ebitda"));
  const netInc = rows.map((r) => flow(r, "net_income"));
  const fcf = rows.map((r) => flow(r, "free_cash_flow"));
  const debt = rows.map((r) => stock(r, "total_debt"));
  const cash = rows.map((r) => stock(r, "cash_and_equivalents"));
  const equity = rows.map((r) => stock(r, "total_equity"));
  const netDebt = rows.map((_, i) => (debt[i] !== null && cash[i] !== null ? debt[i]! - cash[i]! : null));
  const opMargin = rows.map((r) => (typeof r.operating_income === "number" && typeof r.revenue === "number" && r.revenue !== 0 ? (r.operating_income as number) / (r.revenue as number) : null));
  const ebitdaMargin = rows.map((_, i) => (ebitda[i] !== null && revenue[i] ? ebitda[i]! / revenue[i]! : null));
  const nd2e = rows.map((r) => (typeof r.net_debt_to_ebitda === "number" ? (r.net_debt_to_ebitda as number) : null));

  const history: SnapshotRow[] = [
    { label: "Revenue", unit: "US$ m", values: revenue.map((v) => round(v, v !== null && Math.abs(v) < 100 ? 1 : 0)), kind: "usd" },
    { label: "EBITDA", unit: "US$ m", values: ebitda.map((v) => round(v, v !== null && Math.abs(v) < 100 ? 1 : 0)), kind: "usd" },
    { label: "EBITDA margin", unit: "%", values: ebitdaMargin.map((v) => round(v, 3)), kind: "pct" },
    { label: "Operating margin", unit: "%", values: opMargin.map((v) => round(v, 3)), kind: "pct" },
    { label: "Net income", unit: "US$ m", values: netInc.map((v) => round(v, v !== null && Math.abs(v) < 100 ? 1 : 0)), kind: "usd" },
    { label: "Free cash flow", unit: "US$ m", values: fcf.map((v) => round(v, v !== null && Math.abs(v) < 100 ? 1 : 0)), kind: "usd" },
    { label: "Total debt", unit: "US$ m", values: debt.map((v) => round(v, v !== null && Math.abs(v) < 100 ? 1 : 0)), kind: "usd" },
    { label: "Net debt", unit: "US$ m", values: netDebt.map((v) => round(v, v !== null && Math.abs(v) < 100 ? 1 : 0)), kind: "usd" },
    { label: "Net debt / EBITDA", unit: "x", values: nd2e.map((v) => round(v, 2)), kind: "x" },
    { label: "Equity", unit: "US$ m", values: equity.map((v) => round(v, v !== null && Math.abs(v) < 100 ? 1 : 0)), kind: "usd" },
  ].filter((r) => r.values.some((v) => v !== null)) as SnapshotRow[];

  const n = rows.length - 1;
  const last = rows[n];
  const growth = n > 0 && revenue[n] !== null && revenue[n - 1] ? revenue[n]! / revenue[n - 1]! - 1 : null;
  const headline: Snapshot["headline"] = [
    { label: `Revenue ${years[n]}`, value: fmtUsd(revenue[n]), sub: growth !== null ? `${growth >= 0 ? "+" : ""}${pct(growth)} on ${years[n - 1]}` : undefined },
    ...(ebitda[n] !== null ? [{ label: "EBITDA", value: fmtUsd(ebitda[n]), sub: ebitdaMargin[n] !== null ? `${pct(ebitdaMargin[n])} margin` : undefined }] : []),
    { label: "Net income", value: fmtUsd(netInc[n]) },
    { label: "Free cash flow", value: fmtUsd(fcf[n]) },
    ...(netDebt[n] !== null
      ? [netDebt[n]! < 0
          ? { label: "Net cash", value: fmtUsd(-netDebt[n]!), sub: "cash above debt at year end" }
          : { label: "Net debt", value: fmtUsd(netDebt[n]), sub: nd2e[n] !== null ? `${nd2e[n]!.toFixed(1)}x EBITDA` : undefined }]
      : []),
  ].filter((h) => h.value !== "n/a");

  // Plain statements computed from the same numbers; nothing is inferred beyond arithmetic.
  const bullets: string[] = [];
  if (revenue[n] !== null) bullets.push(`Revenue was ${fmtUsd(revenue[n])} in fiscal ${years[n]}${growth !== null ? `, ${growth >= 0 ? "up" : "down"} ${pct(Math.abs(growth))} on fiscal ${years[n - 1]}` : ""}.`);
  const revSeries = revenue.map((v, i) => ({ v, y: years[i] })).filter((x): x is { v: number; y: number } => x.v !== null);
  if (revSeries.length >= 4) {
    const hi = revSeries.reduce((a, b) => (b.v > a.v ? b : a)), lo = revSeries.reduce((a, b) => (b.v < a.v ? b : a));
    bullets.push(`Over ${revSeries[0].y}-${revSeries[revSeries.length - 1].y} revenue ranged from ${fmtUsd(lo.v)} (${lo.y}) to ${fmtUsd(hi.v)} (${hi.y}).`);
  }
  if (opMargin[n] !== null) bullets.push(`The operating margin was ${pct(opMargin[n])}${n > 0 && opMargin[n - 1] !== null ? ` against ${pct(opMargin[n - 1])} the year before` : ""}.`);
  if (netInc[n] !== null) bullets.push(`Net income was ${fmtUsd(netInc[n])}${n > 0 && netInc[n - 1] !== null ? ` (${fmtUsd(netInc[n - 1])} the year before)` : ""}.`);
  if (netDebt[n] !== null) bullets.push(netDebt[n]! < 0 ? `The company held net cash of ${fmtUsd(-netDebt[n]!)} at year end.` : `Net debt was ${fmtUsd(netDebt[n])} at year end${nd2e[n] !== null ? `, ${nd2e[n]!.toFixed(1)} times EBITDA` : ""}.`);

  const charts: Snapshot["charts"] = [];
  const pts = (vals: (number | null)[]) => rows.map((r, i) => [String(r.period_end), vals[i]] as [string, number | null]).filter((p): p is [string, number] => p[1] !== null);
  const rs = pts(revenue);
  if (rs.length >= 2) {
    const series = [{ name: "Revenue", points: rs }];
    if (pts(ebitda).length >= 2) series.push({ name: "EBITDA", points: pts(ebitda) });
    else if (pts(netInc).length >= 2) series.push({ name: "Net income", points: pts(netInc) });
    charts.push({ title: "Revenue and earnings", chart: { unit: "US$ millions", series } });
  }

  // Price link: only for companies where one price is a sensible driver; reuses the sensitivity tool so the numbers agree with the chat.
  let priceLink: Snapshot["priceLink"] = null;
  const link = PRICE_LINK.find(([re]) => re.test(meta.name))?.[1];
  if (link) {
    try {
      const out = await priceSensitivity({ companies: [meta.name], commodity: link.commodity, price_source: link.source, metric: "revenue" });
      const parsed = JSON.parse(out.content);
      const res = parsed.results?.[0];
      if (res?.status === "ok") {
        priceLink = {
          commodity: link.label,
          priceSeries: res.price_series,
          priceUnit: res.price_unit,
          years: `${res.years} (${res.n_years} fiscal years)`,
          strength: res.fit.strength,
          rSquared: res.fit.r_squared,
          elasticity: res.fit.elasticity_at_mean,
          meaning: res.fit.meaning,
          warning: res.mixed_revenue_warning ?? null,
          note: res.price_alignment,
        };
        const ds = out.datasets?.[0];
        if (ds?.chart) charts.push({ title: `Revenue against ${link.label}`, chart: ds.chart });
      }
    } catch {
      // A failed price link must not stop the snapshot.
    }
  }

  const opRows = (
    await pool.query(
      `SELECT DISTINCT ON (m.commodity, m.asset_name, m.metric, m.basis, m.unit) m.commodity, m.asset_name, m.metric, m.basis, m.unit, extract(year from m.period_end_date)::int AS y, m.value::float8 AS value,
              COALESCE(d.title, 'company report') || COALESCE(', page ' || m.page_number, '') AS source
       FROM financials.operating_metrics m LEFT JOIN docs.documents d ON d.document_id = m.source_document_id
       WHERE m.company_id = $1 AND m.is_active AND m.metric IN ('production','sales_volume','average_realised_price','unit_cost_cash','unit_cost_total')
       ORDER BY m.commodity, m.asset_name, m.metric, m.basis, m.unit, m.period_end_date DESC`,
      [companyId]
    )
  ).rows;
  const wantedYear = Math.max(0, ...opRows.map((o) => o.y as number));
  const metricOrder = ["production", "sales_volume", "average_realised_price", "unit_cost_cash", "unit_cost_total"];
  const operating = opRows
    .filter((o) => (o.y as number) >= wantedYear - 1)
    .sort((a, b) => metricOrder.indexOf(a.metric) - metricOrder.indexOf(b.metric) || String(a.commodity).localeCompare(String(b.commodity)))
    .slice(0, 12)
    .map((o) => ({ commodity: o.commodity, asset: o.asset_name, metric: String(o.metric).replace(/_/g, " "), basis: o.basis, unit: o.unit, year: o.y, value: o.value, source: o.source }));

  const assetsAll = (
    await pool.query(
      `SELECT p.name AS project, p.status, cm.commodity_name AS commodity, j.name AS country, o.owner_name, o.share_pct::float8 AS share, o.as_of_year
       FROM core.project_ownership o JOIN core.projects p ON p.project_id = o.project_id
       LEFT JOIN core.commodities cm ON cm.commodity_id = p.primary_commodity_id LEFT JOIN core.jurisdictions j ON j.jurisdiction_id = p.jurisdiction_id
       WHERE o.company_id = $1 AND o.is_active AND p.is_active ORDER BY o.share_pct DESC NULLS LAST, p.name LIMIT 80`,
      [companyId]
    )
  ).rows.map((a) => ({ project: a.project, status: a.status, commodity: a.commodity, country: a.country, owner: a.owner_name, share: a.share, asOf: a.as_of_year }));
  const assetsMore = Math.max(0, assetsAll.length - 12);
  const assets = assetsAll.slice(0, 12);

  const documents = (
    await pool.query(`SELECT title FROM docs.documents WHERE company_id = $1 AND is_active ORDER BY publication_date DESC NULLS LAST, title LIMIT 14`, [companyId])
  ).rows.map((d) => String(d.title));

  const notes = [
    `Figures are in US dollars converted from ${cur === "USD" ? "reported US dollars (no conversion)" : `${cur}: income statement and cash flow at the average of the twelve monthly average rates in the fiscal year, balance sheet at the month-end rate for the year-end month (Bank for International Settlements rates, not the rates the company used)`}. Converted figures are approximate.`,
    `Fiscal year ${years[n]} ended ${String(last.period_end)}. A fiscal-year label means the calendar year in which the fiscal year ends.`,
    ebitda[n] !== null ? `EBITDA basis: ${String(last.ebitda_basis ?? "see company report")}.` : "EBITDA is not available for this company in the data.",
    "A blank means the item is not loaded or the company does not report it; it does not mean zero.",
  ];

  return {
    company: { id: companyId, name: meta.name, ticker: meta.ticker, exchange: meta.exchange, type: meta.company_type, stage: meta.stage, hq: meta.hq, peers: meta.peers ?? [] },
    reportedCurrency: cur,
    latestYear: years[n],
    latestPeriodEnd: String(last.period_end),
    headline,
    bullets,
    history: { years, rows: history },
    charts,
    priceLink,
    operating,
    assets,
    assetsMore,
    documents,
    notes,
    generated: new Date().toISOString().slice(0, 10),
  };
}

export async function buildSnapshot(query: string): Promise<Snapshot | null> {
  const id = await companyIdByName(query);
  return id ? buildSnapshotById(id) : null;
}
