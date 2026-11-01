import { getPool } from "@/lib/db";

// ---- Shared shapes ---------------------------------------------------------------------------------------------------
export type Evidence =
  | { kind: "document"; title: string; page?: number }
  | { kind: "web"; title: string; url: string }
  | { kind: "data"; label: string; detail?: string };

export type Dataset = {
  id: string;
  title: string;
  columns: string[];
  rows: (string | number | null)[][];
  // Optional line chart: one series per entry, points are [YYYY-MM-DD, value].
  chart?: { unit: string; series: { name: string; points: [string, number][] }[] };
};

export type ToolOutput = { content: string; evidence?: Evidence[]; datasets?: Dataset[]; maps?: import("./types").MapData[] };

// Decimals for an amount in millions: small companies' figures (tens of thousands to a few millions) lose information at one decimal.
const millionsDp = (m: number) => (Math.abs(m) >= 100 ? 1 : Math.abs(m) >= 1 ? 2 : 3);
const round = (v: number | null, dp = 1) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10 ** dp) / 10 ** dp);

// ---- Company financials in US dollars --------------------------------------------------------------------------------
// Flow items (income statement, cash flow) are converted at the average of the twelve monthly average rates ending in the
// fiscal year-end month; balance-sheet items at the month-end rate for the fiscal year-end month. Rates are local currency per US dollar.
const FLOW = ["revenue", "gross_profit", "operating_income", "net_income", "operating_cash_flow", "capital_expenditures", "free_cash_flow", "depreciation_amortisation", "ebitda", "ebitda_reported", "finance_costs", "income_tax_expense", "profit_before_tax"] as const;
const STOCK = ["total_assets", "total_current_assets", "cash_and_equivalents", "total_liabilities", "total_current_liabilities", "total_debt", "total_equity"] as const;
const RATIO = ["gross_margin", "operating_margin", "net_margin", "return_on_equity", "return_on_assets", "debt_to_equity", "current_ratio", "interest_cover", "effective_tax_rate", "net_debt_to_ebitda"] as const;
const SHARES = ["weighted_avg_shares_basic"] as const;
const DEFAULT_METRICS = ["revenue", "operating_income", "net_income", "free_cash_flow", "total_debt", "total_equity"];
export const FINANCIAL_METRICS: string[] = [...FLOW, ...STOCK, ...RATIO, ...SHARES];

type Row = Record<string, unknown>;

export async function peerGroupMembers(group: string): Promise<{ names: string[]; matched: string | null; available: string[] }> {
  const pool = getPool();
  const all = (await pool.query(`SELECT peer_group_id, name FROM core.peer_groups WHERE is_active ORDER BY name`)).rows as { peer_group_id: number; name: string }[];
  const g = group.trim().toLowerCase();
  const hit = all.find((x) => x.name.toLowerCase() === g) ?? all.find((x) => x.name.toLowerCase().includes(g) || g.includes(x.name.toLowerCase()));
  if (!hit) return { names: [], matched: null, available: all.map((x) => x.name) };
  const m = await pool.query(
    `SELECT COALESCE(c.short_name, c.name) AS n FROM core.peer_group_members pm JOIN core.companies c ON c.company_id = pm.company_id WHERE pm.peer_group_id = $1 ORDER BY 1`,
    [hit.peer_group_id]
  );
  return { names: m.rows.map((r) => String(r.n)), matched: hit.name, available: all.map((x) => x.name) };
}

export async function resolveCompanies(names: string[]): Promise<{ ids: number[]; unresolved: string[] }> {
  const pool = getPool();
  const ids: number[] = [];
  const unresolved: string[] = [];
  for (const raw of names) {
    const n = raw.trim();
    if (!n) continue;
    const r = await pool.query(
      `SELECT company_id FROM core.companies c
       WHERE EXISTS (SELECT 1 FROM financials.income_statement i WHERE i.company_id = c.company_id AND i.period_type = 'FY' AND i.is_active)
         AND (upper(c.ticker) = upper($1) OR c.short_name ILIKE $2 OR c.name ILIKE $2)
       ORDER BY (upper(c.ticker) = upper($1)) DESC, (lower(c.short_name) = lower($1)) DESC, c.company_id LIMIT 1`,
      [n, `%${n}%`]
    );
    if (r.rows[0]) ids.push(r.rows[0].company_id as number);
    else unresolved.push(n);
  }
  return { ids: [...new Set(ids)], unresolved };
}

export async function financialRows(ids: number[]): Promise<Row[]> {
  if (ids.length === 0) return [];
  const idList = ids.map((i) => Math.floor(Number(i))).join(",");
  const sql = `
    WITH base AS (
      SELECT c.company_id, COALESCE(c.short_name, c.name) AS company, i.period_end_date AS pe, i.currency,
             i.revenue::float8 revenue, i.gross_profit::float8 gross_profit, i.operating_income::float8 operating_income, i.net_income::float8 net_income,
             b.total_assets::float8 total_assets, b.total_current_assets::float8 total_current_assets, b.cash_and_equivalents::float8 cash_and_equivalents,
             b.total_liabilities::float8 total_liabilities, b.total_current_liabilities::float8 total_current_liabilities,
             b.total_debt::float8 total_debt, b.total_equity::float8 total_equity,
             cf.operating_cash_flow::float8 operating_cash_flow, cf.capital_expenditures::float8 capital_expenditures, cf.free_cash_flow::float8 free_cash_flow,
             r.gross_margin::float8 gross_margin, r.operating_margin::float8 operating_margin, r.net_margin::float8 net_margin,
             r.return_on_equity::float8 return_on_equity, r.return_on_assets::float8 return_on_assets, r.debt_to_equity::float8 debt_to_equity, r.current_ratio::float8 current_ratio,
             (SELECT si.value::float8 FROM financials.statement_items si WHERE si.company_id = i.company_id AND si.period_end_date = i.period_end_date AND si.period_type = i.period_type AND si.item = 'depreciation_amortisation' AND si.is_active) AS depreciation_amortisation,
             (SELECT si.value::float8 FROM financials.statement_items si WHERE si.company_id = i.company_id AND si.period_end_date = i.period_end_date AND si.period_type = i.period_type AND si.item = 'finance_costs' AND si.is_active) AS finance_costs,
             (SELECT si.value::float8 FROM financials.statement_items si WHERE si.company_id = i.company_id AND si.period_end_date = i.period_end_date AND si.period_type = i.period_type AND si.item = 'finance_income' AND si.is_active) AS finance_income,
             (SELECT si.value::float8 FROM financials.statement_items si WHERE si.company_id = i.company_id AND si.period_end_date = i.period_end_date AND si.period_type = i.period_type AND si.item = 'income_tax_expense' AND si.is_active) AS income_tax_expense,
             (SELECT si.value::float8 FROM financials.statement_items si WHERE si.company_id = i.company_id AND si.period_end_date = i.period_end_date AND si.period_type = i.period_type AND si.item = 'profit_before_tax' AND si.is_active) AS profit_before_tax,
             (SELECT si.check_note FROM financials.statement_items si WHERE si.company_id = i.company_id AND si.period_end_date = i.period_end_date AND si.period_type = i.period_type AND si.item = 'profit_before_tax' AND si.is_active) AS pbt_note,
             (SELECT si.value::float8 FROM financials.statement_items si WHERE si.company_id = i.company_id AND si.period_end_date = i.period_end_date AND si.period_type = i.period_type AND si.item = 'weighted_avg_shares_basic' AND si.is_active) AS weighted_avg_shares_basic,
             (SELECT si.value::float8 FROM financials.statement_items si WHERE si.company_id = i.company_id AND si.period_end_date = i.period_end_date AND si.period_type = i.period_type AND si.item = 'ebitda_reported' AND si.is_active) AS ebitda_reported,
             (SELECT si.basis FROM financials.statement_items si WHERE si.company_id = i.company_id AND si.period_end_date = i.period_end_date AND si.period_type = i.period_type AND si.item = 'ebitda_reported' AND si.is_active) AS ebitda_reported_basis,
             i.line_items->>'note' AS note, i.source_document_id AS source_document_id, i.line_items->>'source' AS source
      FROM financials.income_statement i
      JOIN core.companies c ON c.company_id = i.company_id
      LEFT JOIN financials.balance_sheet b ON b.company_id = i.company_id AND b.period_end_date = i.period_end_date AND b.period_type = i.period_type AND b.is_active
      LEFT JOIN financials.cash_flow cf ON cf.company_id = i.company_id AND cf.period_end_date = i.period_end_date AND cf.period_type = i.period_type AND cf.is_active
      LEFT JOIN financials.financial_ratios r ON r.company_id = i.company_id AND r.period_end_date = i.period_end_date AND r.period_type = i.period_type AND r.is_active
      WHERE i.is_active AND i.period_type = 'FY' AND i.company_id IN (${idList})
    )
    SELECT base.*, pe::text AS period_end,
      CASE WHEN currency = 'USD' THEN 1::float8 ELSE (
        SELECT CASE WHEN count(DISTINCT f.period_start) = 12 THEN avg(f.rate_per_usd)::float8 END FROM markets.fx_rates f
        WHERE f.currency = base.currency AND f.frequency = 'monthly' AND f.collection = 'average'
          AND f.period_start > (date_trunc('month', pe) - interval '12 months')::date AND f.period_start <= date_trunc('month', pe)::date) END AS fx_avg,
      CASE WHEN currency = 'USD' THEN 1::float8 ELSE (
        SELECT max(f.rate_per_usd)::float8 FROM markets.fx_rates f
        WHERE f.currency = base.currency AND f.frequency = 'monthly' AND f.collection = 'end_of_period' AND f.period_start = date_trunc('month', pe)::date) END AS fx_eop
    FROM base ORDER BY company, pe`;
  const r = await getPool().query(sql);
  return r.rows;
}

// Derived measures. EBITDA is operating profit plus depreciation and amortisation (not a company's own "adjusted EBITDA"); available only where both are stored.
export function addDerived(r: Row) {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const oi = n(r.operating_income), da = n(r.depreciation_amortisation), fc = n(r.finance_costs), fi = n(r.finance_income), tax = n(r.income_tax_expense), pbt = n(r.profit_before_tax);
  const debt = n(r.total_debt), cash = n(r.cash_and_equivalents);
  // A company-defined EBITDA (for example Underlying or Adjusted EBITDA) is used where one is stored; otherwise operating profit plus depreciation and amortisation.
  const rep = n(r.ebitda_reported);
  if (rep !== null) {
    r.ebitda = rep;
    r.ebitda_basis = `company-defined, as reported: ${typeof r.ebitda_reported_basis === "string" ? r.ebitda_reported_basis : "see the company report"}`;
  } else if (pbt !== null && fc !== null && fi !== null && da !== null) {
    // Interest income and expense are stored (Glencore, China Northern Rare Earth): build the proxy from pre-tax profit, net interest and depreciation.
    // This is used even where an operating profit is stored, because some statements strike operating profit after finance costs. It still contains
    // impairments, associate income, investment gains and other one-offs, so it is flagged and is not the company's own Adjusted EBITDA.
    r.ebitda = pbt + fc - fi + da;
    r.ebitda_basis = "proxy: profit before tax + net interest expense + depreciation and amortisation (still includes impairments, share of associates, investment gains, grants and other one-off items; not the company's own Adjusted EBITDA)";
  } else if (oi !== null && da !== null) {
    r.ebitda = oi + da;
    r.ebitda_basis = "operating profit + depreciation and amortisation";
  } else {
    r.ebitda = null;
    r.ebitda_basis = null;
  }
  // Earnings before interest: pre-tax profit plus net interest where both interest lines are stored, otherwise operating profit.
  const ebit = pbt !== null && fc !== null && fi !== null ? pbt + fc - fi : oi;
  r.interest_cover = ebit !== null && fc !== null && fc > 0 ? ebit / fc : null;
  r.interest_cover_basis = r.interest_cover === null ? null : pbt !== null && fi !== null ? "(profit before tax + net interest expense) / interest expense" : "operating profit / interest expense";
  r.effective_tax_rate = tax !== null && pbt !== null && pbt > 0 ? tax / pbt : null;
  // Where the stored pre-tax profit excludes a large item (Albemarle excludes equity income), the ratio is not a real effective tax rate: withhold it and say why.
  if (typeof r.pbt_note === "string" && r.pbt_note.includes("not a meaningful effective tax rate")) {
    r.effective_tax_rate = null;
    r.effective_tax_rate_note = "not computed: the stored pre-tax profit excludes the company's equity income, so tax divided by it would overstate the rate (tax and pre-tax profit are shown separately)";
  }
  const e = n(r.ebitda);
  r.net_debt_to_ebitda = e !== null && e > 0 && debt !== null && cash !== null ? (debt - cash) / e : null;
}

export async function companyFinancials(input: Record<string, unknown>): Promise<ToolOutput> {
  let names = Array.isArray(input.companies) ? (input.companies as unknown[]).map(String) : [];
  if (names.length === 0 && typeof input.peer_group === "string" && input.peer_group.trim()) {
    const g = await peerGroupMembers(input.peer_group);
    if (!g.matched) return { content: JSON.stringify({ found: false, note: "No peer group with that name.", available_peer_groups: g.available }) };
    names = g.names;
  }
  if (names.length === 0) throw new Error("Name at least one company or a peer group.");
  const currencyMode = input.currency === "reported" ? "reported" : "USD";
  const lastN = Math.min(Math.max(Math.floor(Number(input.last_n) || 5), 1), 12);
  const years = Array.isArray(input.fiscal_years) ? (input.fiscal_years as unknown[]).map(Number).filter(Number.isFinite) : [];
  let metrics = Array.isArray(input.metrics) ? (input.metrics as unknown[]).map(String) : DEFAULT_METRICS;
  if (metrics.includes("all")) metrics = FINANCIAL_METRICS;
  metrics = metrics.filter((m) => FINANCIAL_METRICS.includes(m));
  if (metrics.length === 0) metrics = DEFAULT_METRICS;

  const { ids, unresolved } = await resolveCompanies(names);
  const all = await financialRows(ids);
  const byCompany = new Map<string, Row[]>();
  for (const r of all) {
    addDerived(r);
    const k = String(r.company);
    byCompany.set(k, [...(byCompany.get(k) ?? []), r]);
  }

  // A company that has a company-defined EBITDA stored gets no derived EBITDA in the other years: mixing the two bases (and discontinued-operation
  // restatements) in one series would be misleading.
  for (const rows of byCompany.values()) {
    if (rows.some((r) => typeof r.ebitda_reported === "number")) {
      for (const r of rows) {
        if (typeof r.ebitda_reported !== "number") {
          r.ebitda = null;
          r.ebitda_basis = null;
          r.net_debt_to_ebitda = null;
        }
      }
    }
  }

  const outRows: Record<string, unknown>[] = [];
  const csvRows: (string | number | null)[][] = [];
  const fxProblems: string[] = [];
  const sources = new Set<string>();
  const docIds = new Set<number>();
  const unit = currencyMode === "USD" ? "US$ millions" : "millions of reported currency";
  const csvCols = ["Company", "Fiscal year end", "Reported currency", ...metrics.map((m) => (RATIO as readonly string[]).includes(m) ? m : `${m} (${currencyMode === "USD" ? "US$ m" : "reported m"})`), "Avg FX rate (local per US$)", "Year-end FX rate (local per US$)"];

  for (const [company, rows] of byCompany) {
    let sel = rows;
    if (years.length) sel = rows.filter((r) => years.includes(Number(String(r.period_end).slice(0, 4))));
    else sel = rows.slice(-lastN);
    for (const r of sel) {
      const cur = String(r.currency);
      const convert = currencyMode === "USD" && cur !== "USD";
      const o: Record<string, unknown> = { company, fiscal_year: Number(String(r.period_end).slice(0, 4)), period_end: r.period_end, reported_currency: cur };
      const csv: (string | number | null)[] = [company, String(r.period_end), cur];
      for (const m of metrics) {
        const raw = r[m] as number | null;
        let v: number | null;
        if ((RATIO as readonly string[]).includes(m)) v = round(raw, 4);
        else if ((SHARES as readonly string[]).includes(m)) v = raw === null || raw === undefined ? null : round(raw / 1e6, 1);
        else if (raw === null || raw === undefined) v = null;
        else if (!convert) v = round(raw / 1e6, millionsDp(raw / 1e6));
        else {
          const rate = (FLOW as readonly string[]).includes(m) ? (r.fx_avg as number | null) : (r.fx_eop as number | null);
          if (!rate) {
            v = null;
            fxProblems.push(`${company} ${o.fiscal_year} ${m}`);
          } else {
            // A conversion at average rates is not exact to the last digit, so do not present false precision.
            const m = raw / rate / 1e6;
            v = round(m, Math.abs(m) >= 100 ? 0 : millionsDp(m));
          }
        }
        o[m] = v;
        csv.push(v);
      }
      if (convert) {
        o.fx_avg_rate = round(r.fx_avg as number | null, 4);
        o.fx_year_end_rate = round(r.fx_eop as number | null, 4);
      }
      csv.push(convert ? round(r.fx_avg as number | null, 4) : null, convert ? round(r.fx_eop as number | null, 4) : null);
      if (r.note) o.note = String(r.note).slice(0, 300);
      if (metrics.includes("ebitda") || metrics.includes("net_debt_to_ebitda")) o.ebitda_basis = r.ebitda_basis ?? "not available";
      if (metrics.includes("interest_cover") && r.interest_cover_basis) o.interest_cover_basis = r.interest_cover_basis;
      if (metrics.includes("effective_tax_rate") && r.effective_tax_rate_note) o.effective_tax_rate_note = r.effective_tax_rate_note;
      outRows.push(o);
      csvRows.push(csv);
      if (typeof r.source === "string" && r.source.trim()) sources.add(r.source.trim().replace(/\s*\((?:source_)?documents?\s*(?:id\s*)?#?\d+\)/gi, ""));
      if (typeof r.source_document_id === "number") docIds.add(r.source_document_id);
    }
  }

  const evidence: Evidence[] = [{ kind: "data", label: "Company financial statements (filings and annual reports)", detail: `${outRows.length} company-years` }];
  if (currencyMode === "USD" && outRows.some((r) => r.reported_currency !== "USD")) evidence.push({ kind: "data", label: "Exchange rates (Bank for International Settlements)", detail: "monthly averages and month-end rates" });
  for (const s of [...sources].slice(0, 12)) evidence.push({ kind: "document", title: s });
  if (docIds.size > 0 && docIds.size <= 40) {
    const d = await getPool().query(`SELECT title FROM docs.documents WHERE document_id IN (${[...docIds].join(",")})`);
    for (const x of d.rows) evidence.push({ kind: "document", title: String(x.title) });
  }

  const caveats = [
    "Statement items are per fiscal year as reported. Some companies have a June year end, so the same fiscal-year label ends six months earlier or later than a calendar-year company.",
    "Where a company's interest income is stored (Glencore, China Northern Rare Earth), EBITDA and interest cover are built from pre-tax profit plus net interest rather than from operating profit; check the ebitda_basis field and say it is an approximation that still includes one-off items.",
    "A company-defined EBITDA (adjusted or underlying) will not equal operating profit plus depreciation because the company adds back other items; that difference is expected, not an error, so quote the stored figure as the company's own measure.",
    "EBITDA: where a company-defined EBITDA is stored (South32 Underlying EBITDA, Kazatomprom Adjusted EBITDA) it is used and ebitda_basis says so; otherwise EBITDA is operating profit plus depreciation and amortisation from the reports. Company-defined EBITDAs exclude one-off items and are not comparable with the derived figure or with each other, so say which basis each figure uses. Companies with neither (for example Glencore, which reports no operating profit line, and the South African producers) have no EBITDA in the data. Depreciation, finance costs, tax and share counts are partly loaded: a missing value means not loaded, not zero. Interest cover is operating profit divided by finance costs; effective tax rate is tax divided by profit before tax (blank when the profit is negative). weighted_avg_shares_basic is in millions of shares.",
    "Read each row's note before comparing years: reporting-basis changes, derived gross profit, missing operating profit, and impairments are described there. Missing values mean the company does not report that item.",
  ];
  if (currencyMode === "USD") caveats.push("US dollar values for non-US-dollar reporters are a conversion made here: income statement and cash flow at the average of the twelve monthly average rates in the fiscal year, balance sheet at the month-end rate for the year-end month (Bank for International Settlements rates, not the rates the company used). Say so when presenting them, and state the rates used (fx_avg_rate for the income statement and cash flow, fx_year_end_rate for the balance sheet) in a short line under the table, giving converted figures as approximate.");

  // Pre-computed ordering per fiscal year and metric, so comparisons in the answer are read from here rather than judged by eye.
  const rankingByYear: Record<string, Record<string, string>> = {};
  if (byCompany.size >= 2) {
    const fmtV = (m: string, v: number) => ((RATIO as readonly string[]).includes(m) ? `${(v * 100).toFixed(1)}%` : v.toLocaleString("en-US", { maximumFractionDigits: 1 }));
    const years = [...new Set(outRows.map((r) => String(r.fiscal_year)))];
    for (const y of years) {
      for (const m of metrics) {
        const vals = outRows.filter((r) => String(r.fiscal_year) === y && typeof r[m] === "number").map((r) => ({ c: String(r.company), v: r[m] as number }));
        if (vals.length < 2) continue;
        vals.sort((a, b) => b.v - a.v);
        (rankingByYear[y] ??= {})[m] = vals.map((x) => `${x.c} (${fmtV(m, x.v)})`).join(" > ");
      }
    }
  }

  const content = JSON.stringify({
    unit,
    ratios: "fractions (0.25 = 25%); not converted",
    ...(Object.keys(rankingByYear).length ? { ranking_by_year_highest_first: rankingByYear } : {}),
    rows: outRows,
    not_found: unresolved,
    fx_missing_for: fxProblems.slice(0, 20),
    caveats,
  });
  return {
    content,
    evidence,
    datasets: outRows.length ? [{ id: "fin-" + Date.now(), title: `Company financials (${unit})`, columns: csvCols, rows: csvRows }] : [],
  };
}

// ---- Peer comparison -------------------------------------------------------------------------------------------------
function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export async function peerComparison(input: Record<string, unknown>): Promise<ToolOutput> {
  let names = Array.isArray(input.companies) ? (input.companies as unknown[]).map(String) : [];
  const pool = getPool();
  let groupNote: string | null = null;
  if (names.length === 0 && typeof input.peer_group === "string" && input.peer_group.trim()) {
    const g = await peerGroupMembers(input.peer_group);
    if (!g.matched) {
      return { content: JSON.stringify({ found: false, note: "No peer group with that name.", available_peer_groups: g.available }) };
    }
    names = g.names;
    groupNote = g.matched;
  }
  if (names.length === 0) {
    // Default peer set: every company with at least five annual statements.
    const r = await pool.query(
      `SELECT COALESCE(c.short_name, c.name) n FROM core.companies c
       WHERE (SELECT count(*) FROM financials.income_statement i WHERE i.company_id = c.company_id AND i.period_type='FY' AND i.is_active) >= 5 ORDER BY 1`
    );
    names = r.rows.map((x) => String(x.n));
  }
  const { ids, unresolved } = await resolveCompanies(names);
  const all = await financialRows(ids);
  for (const r of all) addDerived(r);
  const fy = Number(input.fiscal_year) || null;

  const byCompany = new Map<string, Row[]>();
  for (const r of all) byCompany.set(String(r.company), [...(byCompany.get(String(r.company)) ?? []), r]);

  type Snap = Record<string, unknown>;
  const snaps: Snap[] = [];
  for (const [company, rows] of byCompany) {
    const idx = fy ? rows.findIndex((r) => Number(String(r.period_end).slice(0, 4)) === fy) : rows.length - 1;
    if (idx < 0) continue;
    const r = rows[idx];
    const prev = idx > 0 ? rows[idx - 1] : null;
    const prev3 = idx >= 3 ? rows[idx - 3] : null;
    const cur = String(r.currency);
    const usd = (v: unknown, rate: unknown) => (typeof v === "number" && typeof rate === "number" && rate > 0 ? v / rate : null);
    const rev = usd(r.revenue, r.fx_avg);
    const revPrev = prev ? usd(prev.revenue, prev.fx_avg) : null;
    const rev3 = prev3 ? usd(prev3.revenue, prev3.fx_avg) : null;
    const fcf = usd(r.free_cash_flow, r.fx_avg);
    const debt = usd(r.total_debt, r.fx_eop);
    const cash = usd(r.cash_and_equivalents, r.fx_eop);
    snaps.push({
      company,
      fiscal_year: Number(String(r.period_end).slice(0, 4)),
      period_end: r.period_end,
      reported_currency: cur,
      revenue_usd_m: round(rev === null ? null : rev / 1e6, 0),
      revenue_growth_1y: rev !== null && revPrev ? round(rev / revPrev - 1, 3) : null,
      revenue_cagr_3y: rev !== null && rev3 && rev3 > 0 ? round(Math.pow(rev / rev3, 1 / 3) - 1, 3) : null,
      gross_margin: round(r.gross_margin as number | null, 3),
      operating_margin: round(r.operating_margin as number | null, 3),
      net_margin: round(r.net_margin as number | null, 3),
      fcf_margin: fcf !== null && rev ? round(fcf / rev, 3) : null,
      return_on_equity: round(r.return_on_equity as number | null, 3),
      debt_to_equity: round(r.debt_to_equity as number | null, 2),
      net_debt_usd_m: debt !== null && cash !== null ? round((debt - cash) / 1e6, 0) : null,
    });
  }
  const metricKeys = ["revenue_usd_m", "revenue_growth_1y", "revenue_cagr_3y", "gross_margin", "operating_margin", "net_margin", "fcf_margin", "return_on_equity", "debt_to_equity"];
  const medians: Record<string, number | null> = {};
  const ranks: Record<string, Record<string, number>> = {};
  for (const k of metricKeys) {
    const vals = snaps.map((s) => s[k]).filter((v): v is number => typeof v === "number");
    medians[k] = round(median(vals), k === "revenue_usd_m" ? 0 : 3);
    // Higher is better for everything except leverage.
    const sorted = snaps.filter((s) => typeof s[k] === "number").sort((a, b) => (k === "debt_to_equity" ? (a[k] as number) - (b[k] as number) : (b[k] as number) - (a[k] as number)));
    ranks[k] = {};
    sorted.forEach((s, i) => (ranks[k][String(s.company)] = i + 1));
  }
  const withRanks = snaps.map((s) => ({ ...s, ranks: Object.fromEntries(metricKeys.map((k) => [k, ranks[k][String(s.company)] ?? null])) }));

  const cols = ["Company", "Fiscal year end", "Revenue (US$ m)", "Revenue growth 1y", "Revenue CAGR 3y", "Gross margin", "Operating margin", "Net margin", "FCF margin", "Return on equity", "Debt to equity", "Net debt (US$ m)"];
  const csv = snaps.map((s) => [String(s.company), String(s.period_end), s.revenue_usd_m, s.revenue_growth_1y, s.revenue_cagr_3y, s.gross_margin, s.operating_margin, s.net_margin, s.fcf_margin, s.return_on_equity, s.debt_to_equity, s.net_debt_usd_m] as (string | number | null)[]);
  const content = JSON.stringify({
    ...(groupNote ? { peer_group: groupNote, note_peer_group: "Members of this group that have no annual statements loaded are missing from the table." } : {}),
    basis: fy ? `fiscal year ${fy}` : "latest fiscal year available for each company (year ends differ)",
    unit: "revenue and net debt in US$ millions; growth, margins and returns are fractions (0.25 = 25%); rank 1 is best (lowest debt to equity is best)",
    peers: withRanks,
    peer_median: medians,
    not_found: unresolved,
    caveats: [
      "US dollar figures are converted at Bank for International Settlements average (income statement, cash flow) and month-end (balance sheet) rates, not the rates the companies used.",
      "Margins and returns are as stored for each company; a blank means the company does not report that line. Companies in different sub-sectors (miners, chemical makers, traders) have structurally different margins, so say what the peers have in common.",
      "Different year ends: the snapshot year for each company is shown.",
    ],
  });
  return {
    content,
    evidence: [
      { kind: "data", label: "Company financial statements (filings and annual reports)", detail: `${snaps.length} companies` },
      { kind: "data", label: "Exchange rates (Bank for International Settlements)", detail: "monthly averages and month-end rates" },
    ],
    datasets: snaps.length ? [{ id: "peer-" + Date.now(), title: "Peer comparison", columns: cols, rows: csv }] : [],
  };
}

// ---- Commodity price history -----------------------------------------------------------------------------------------
export async function priceHistory(input: Record<string, unknown>): Promise<ToolOutput> {
  const pool = getPool();
  const q = String(input.commodity ?? "").trim();
  const seriesIds = Array.isArray(input.series_ids) ? (input.series_ids as unknown[]).map((x) => Math.floor(Number(x))).filter(Number.isFinite).slice(0, 4) : [];
  const fromYear = Number(input.from_year) || null;
  const toYear = Number(input.to_year) || null;
  if (!q && seriesIds.length === 0) throw new Error("Give a commodity name or series_ids.");

  let chosen: Row[] = [];
  let candidates: Row[] = [];
  if (seriesIds.length) {
    chosen = (await pool.query(`SELECT * FROM markets.price_series WHERE series_id IN (${seriesIds.join(",")})`)).rows;
  } else {
    const like = `%${q.replace(/[%_]/g, "")}%`;
    candidates = (
      await pool.query(
        `SELECT series_id, source, series_name, commodity_label, frequency, unit, price_basis, first_period::text AS first_period, last_period::text AS last_period, n_observations
         FROM markets.price_series
         WHERE commodity_label ILIKE $1 OR series_name ILIKE $1
         ORDER BY (frequency = 'monthly') DESC,
                  CASE source WHEN 'WORLD_BANK_PINK_SHEET' THEN 0 WHEN 'IMF_PCPS' THEN 1 WHEN 'USGS_MCS_2026' THEN 2 ELSE 3 END,
                  (price_basis ILIKE '%constant%') ASC, n_observations DESC
         LIMIT 12`,
        [like]
      )
    ).rows;
    // Best match first; plot overlay only when the user clearly wants several, otherwise the single best series.
    chosen = candidates.slice(0, 1);
  }
  if (chosen.length === 0) {
    return { content: JSON.stringify({ found: false, note: "No price series matches. Prices are held for base and precious metals, uranium, cobalt, potash, phosphate, coal and about 90 USGS annual commodity prices (for example lithium carbonate, graphite, rare earth oxides)." }) };
  }

  const datasets: Dataset[] = [];
  const modelSeries: Record<string, unknown>[] = [];
  const chartSeries: { name: string; points: [string, number][] }[] = [];
  const csvRows: (string | number | null)[][] = [];
  let unit = "";
  for (const s of chosen) {
    const where = [`series_id = ${Math.floor(Number(s.series_id))}`];
    if (fromYear) where.push(`period_start >= '${fromYear}-01-01'`);
    if (toYear) where.push(`period_start <= '${toYear}-12-31'`);
    const pts = (
      await pool.query(`SELECT period_start::text AS d, value::float8 AS v, value_low::float8 AS lo, value_high::float8 AS hi, is_estimate FROM markets.prices WHERE ${where.join(" AND ")} ORDER BY period_start`)
    ).rows;
    const series: [string, number][] = [];
    for (const p of pts) {
      const v = typeof p.v === "number" ? p.v : typeof p.lo === "number" && typeof p.hi === "number" ? (p.lo + p.hi) / 2 : null;
      if (v !== null) {
        series.push([String(p.d), v]);
        csvRows.push([String(s.series_name), String(p.d), round(v, 4), String(s.unit ?? ""), p.is_estimate ? "estimate" : null]);
      }
    }
    if (!unit) unit = String(s.unit ?? "");
    const sameUnit = String(s.unit ?? "") === unit;
    if (sameUnit && series.length) chartSeries.push({ name: String(s.series_name), points: series });

    // For the model: summary stats plus yearly averages (or all points if the series is short).
    const vals = series.map((x) => x[1]);
    const last = series[series.length - 1];
    const peak = series.reduce((a, b) => (b[1] > a[1] ? b : a), series[0] ?? ["", -Infinity]);
    const low = series.reduce((a, b) => (b[1] < a[1] ? b : a), series[0] ?? ["", Infinity]);
    const byYear = new Map<string, number[]>();
    for (const [d, v] of series) byYear.set(d.slice(0, 4), [...(byYear.get(d.slice(0, 4)) ?? []), v]);
    const yearly = [...byYear.entries()].map(([y, a]) => ({ year: y, average: round(a.reduce((x, y2) => x + y2, 0) / a.length, 2), min: round(Math.min(...a), 2), max: round(Math.max(...a), 2), observations: a.length }));
    modelSeries.push({
      series_id: s.series_id,
      name: s.series_name,
      source: s.source,
      unit: s.unit,
      basis: s.price_basis,
      frequency: s.frequency,
      period: series.length ? `${series[0][0]} to ${last[0]}` : "no data in range",
      observations: series.length,
      latest: last ? { date: last[0], value: round(last[1], 2) } : null,
      peak: series.length ? { date: peak[0], value: round(peak[1], 2) } : null,
      lowest: series.length ? { date: low[0], value: round(low[1], 2) } : null,
      average: vals.length ? round(vals.reduce((a, b) => a + b, 0) / vals.length, 2) : null,
      ...(series.length <= 40 ? { points: series.map(([d, v]) => ({ date: d, value: round(v, 2) })) } : { yearly: yearly.slice(-45), last_12: series.slice(-12).map(([d, v]) => ({ date: d, value: round(v, 2) })) }),
    });
  }

  if (chartSeries.length) {
    datasets.push({
      id: "price-" + Date.now(),
      title: chartSeries.map((c) => c.name).join(" / "),
      columns: ["Series", "Period start", "Value", "Unit", "Flag"],
      rows: csvRows,
      chart: { unit, series: chartSeries },
    });
  }
  const content = JSON.stringify({
    series: modelSeries,
    other_matching_series: candidates.slice(1, 8).map((c) => ({ series_id: c.series_id, name: c.series_name, source: c.source, unit: c.unit, frequency: c.frequency, period: `${String(c.first_period).slice(0, 7)} to ${String(c.last_period).slice(0, 7)}` })),
    caveats: [
      "Units differ between series; read each unit before comparing. Always tell the user whether the price is real (inflation-adjusted) or nominal: it is stated in the series name and basis. Monthly series are market averages in nominal US dollars. USGS annual series are annual averages, the latest year may be an estimate, and USGS unit values of US apparent consumption are not world spot prices.",
      "A chart of this series is shown to the user automatically, so do not describe how to draw one; interpret it instead.",
    ],
  });
  return {
    content,
    evidence: chosen.map((s) => ({ kind: "data" as const, label: `${String(s.series_name)} (${String(s.source).replace(/_/g, " ").toLowerCase()})`, detail: String(s.unit ?? "") })),
    datasets,
  };
}

// ---- Operating data (production, sales volumes, realised prices, unit costs) taken from company reports -------------------
const OPERATING_METRICS = [
  "production",
  "sales_volume",
  "average_realised_price",
  "unit_cost_cash",
  "unit_cost_total",
  "ore_processed",
  "head_grade",
  "recovery_rate",
  "nameplate_capacity",
  "capex_sustaining",
  "capex_growth",
];
export const OPERATING_METRIC_NAMES = OPERATING_METRICS;

export async function operatingData(input: Record<string, unknown>): Promise<ToolOutput> {
  const pool = getPool();
  const names = Array.isArray(input.companies) ? (input.companies as unknown[]).map(String) : [];
  const metrics = Array.isArray(input.metrics) ? (input.metrics as unknown[]).map(String).filter((m) => OPERATING_METRICS.includes(m)) : [];
  const commodity = typeof input.commodity === "string" ? input.commodity.trim() : "";
  const fromYear = Number(input.from_year) || null;
  const toYear = Number(input.to_year) || null;

  const ids: number[] = [];
  const unresolved: string[] = [];
  for (const n of names) {
    const r = await pool.query(
      `SELECT c.company_id FROM core.companies c
       WHERE EXISTS (SELECT 1 FROM financials.operating_metrics m WHERE m.company_id = c.company_id AND m.is_active)
         AND (upper(c.ticker) = upper($1) OR c.short_name ILIKE $2 OR c.name ILIKE $2) ORDER BY c.company_id LIMIT 1`,
      [n.trim(), `%${n.trim()}%`]
    );
    if (r.rows[0]) ids.push(r.rows[0].company_id as number);
    else unresolved.push(n);
  }

  const where: string[] = ["m.is_active"];
  const params: unknown[] = [];
  if (ids.length) where.push(`m.company_id IN (${ids.join(",")})`);
  else if (names.length) where.push("false");
  if (metrics.length) {
    params.push(metrics);
    where.push(`m.metric = ANY($${params.length})`);
  }
  if (commodity) {
    params.push(`%${commodity}%`);
    where.push(`(m.commodity ILIKE $${params.length} OR m.asset_name ILIKE $${params.length})`);
  }
  if (fromYear) where.push(`m.period_end_date >= '${fromYear}-01-01'`);
  if (toYear) where.push(`m.period_end_date <= '${toYear}-12-31'`);

  const rows = (
    await pool.query(
      `SELECT COALESCE(c.short_name, c.name) AS company, m.period_end_date::text AS pe, m.commodity, m.asset_name, m.metric, m.value::float8 AS value, m.unit, m.basis,
              m.extraction_confidence AS confidence, d.title AS doc_title, m.page_number
       FROM financials.operating_metrics m
       JOIN core.companies c ON c.company_id = m.company_id
       LEFT JOIN docs.documents d ON d.document_id = m.source_document_id
       WHERE ${where.join(" AND ")}
       ORDER BY company, m.commodity, m.metric, m.basis NULLS FIRST, m.asset_name NULLS FIRST, m.period_end_date`,
      params
    )
  ).rows;

  if (rows.length === 0) {
    return {
      content: JSON.stringify({
        found: false,
        not_found: unresolved,
        note: "No operating figures match. Operating data (production, sales volumes, realised prices, unit costs) is loaded for only some companies and commodities.",
      }),
    };
  }

  type S = {
    company: string;
    commodity: string;
    asset: string | null;
    metric: string;
    unit: string;
    basis: string | null;
    points: Record<string, number>;
    medium_confidence_years: string[];
    sources: Record<string, string[]>;
  };
  const series = new Map<string, S>();
  for (const r of rows) {
    const key = [r.company, r.commodity, r.asset_name, r.metric, r.unit, r.basis].join("|");
    const s: S = series.get(key) ?? { company: r.company, commodity: r.commodity, asset: r.asset_name, metric: r.metric, unit: r.unit, basis: r.basis, points: {}, medium_confidence_years: [], sources: {} };
    s.points[String(r.pe).slice(0, 7)] = r.value;
    // Which report and page each year's figure comes from, grouped so the list stays short.
    const src = r.doc_title ? `${r.doc_title}, page ${r.page_number ?? "n/a"}` : "source not recorded";
    (s.sources[src] ??= []).push(String(r.pe).slice(0, 4));
    if (r.confidence === "medium") s.medium_confidence_years.push(String(r.pe).slice(0, 4));
    series.set(key, s);
  }
  const list = [...series.values()];

  // Evidence: the reports and pages behind the figures.
  const evidence: Evidence[] = [{ kind: "data", label: "Operating data from company annual reports", detail: `${rows.length} figures` }];
  const seenDoc = new Set<string>();
  for (const r of rows) {
    const k = `${r.doc_title}|${r.page_number}`;
    if (r.doc_title && !seenDoc.has(k) && seenDoc.size < 40) {
      seenDoc.add(k);
      evidence.push({ kind: "document", title: String(r.doc_title), page: typeof r.page_number === "number" ? r.page_number : undefined });
    }
  }

  const dataset: Dataset = {
    id: "ops-" + Date.now(),
    title: "Operating data from company reports",
    columns: ["Company", "Fiscal year end", "Commodity", "Asset", "Metric", "Value", "Unit", "Basis", "Confidence", "Source report", "Page"],
    rows: rows.map((r) => [r.company, String(r.pe), r.commodity, r.asset_name, r.metric, round(r.value, 4), r.unit, r.basis, r.confidence, r.doc_title, r.page_number]),
  };
  // Chart a handful of comparable series (same unit, at least three points).
  const chartable = list.filter((s) => Object.keys(s.points).length >= 3);
  if (chartable.length > 0 && chartable.length <= 4 && new Set(chartable.map((s) => s.unit)).size === 1) {
    dataset.chart = {
      unit: chartable[0].unit,
      series: chartable.map((s) => ({
        name: [s.company, s.commodity, s.asset, s.basis].filter(Boolean).join(" · ").slice(0, 80),
        points: Object.entries(s.points).map(([ym, v]) => [`${ym}-01`, v] as [string, number]),
      })),
    };
  }

  // Large selections: return a catalogue so the model narrows the request instead of reading hundreds of values.
  if (rows.length > 160) {
    const catalogue = list.map((s) => ({
      company: s.company,
      commodity: s.commodity,
      asset: s.asset,
      metric: s.metric,
      unit: s.unit,
      basis: s.basis,
      years: `${Object.keys(s.points)[0]?.slice(0, 4)}-${Object.keys(s.points).slice(-1)[0]?.slice(0, 4)}`,
      n: Object.keys(s.points).length,
    }));
    return {
      content: JSON.stringify({ too_many_values: rows.length, instruction: "Too many values to return at once. Call again with a commodity, metrics and/or years filter.", catalogue: catalogue.slice(0, 120) }),
      evidence: evidence.slice(0, 1),
    };
  }

  return {
    content: JSON.stringify({
      figures_are: "as published in the company's own annual report, with the report and page in the data download; fiscal year ends differ by company",
      series: list,
      not_found: unresolved,
      caveats: [
        "These are operating figures reported by each company, on that company's own basis (for example 100% basis vs attributable share, cost definitions). Read the basis field before comparing companies, and do not compare unit costs across companies without saying their definitions differ.",
        "Coverage is partial: only some companies, commodities and years are loaded. Say plainly when a requested figure is not in the data.",
        "Realised prices are the company's own average prices received, which differ from benchmark market prices.",
      ],
    }),
    evidence,
    datasets: [dataset],
  };
}

// ---- Price sensitivity: how a company's results have moved with a commodity price ------------------------------------------
// Small-sample statistics. Student t two-sided p-value via the regularised incomplete beta function.
function lgamma(x: number): number {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const cj of c) ser += cj / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}
function betacf(a: number, b: number, x: number): number {
  const FPMIN = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-12) break;
  }
  return h;
}
function betai(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}
const tTwoSidedP = (t: number, df: number) => (df > 0 && Number.isFinite(t) ? betai(df / 2, 0.5, df / (df + t * t)) : df > 0 ? 0 : null);

type Fit = { n: number; slope: number; intercept: number; r2: number; p: number | null };
function ols(x: number[], y: number[]): Fit | null {
  const n = x.length;
  if (n < 3) return null;
  const mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxx += (x[i] - mx) ** 2; sxy += (x[i] - mx) * (y[i] - my); syy += (y[i] - my) ** 2; }
  if (sxx === 0) return null;
  const slope = sxy / sxx, intercept = my - slope * mx;
  const sse = Math.max(syy - slope * sxy, 0);
  const r2 = syy === 0 ? 0 : 1 - sse / syy;
  const df = n - 2;
  const se = df > 0 ? Math.sqrt(sse / df / sxx) : NaN;
  const t = se > 0 ? slope / se : slope === 0 ? 0 : Infinity;
  return { n, slope, intercept, r2, p: tTwoSidedP(t, df) };
}
function pearson(x: number[], y: number[]): number | null {
  const n = x.length;
  if (n < 3) return null;
  const mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}
const strengthLabel = (f: Fit) =>
  f.p !== null && f.p < 0.05 && f.r2 >= 0.7 ? "strong" : f.p !== null && f.p < 0.1 && f.r2 >= 0.4 ? "moderate" : "weak or none";

// Companies whose revenue is not driven mainly by the one commodity chosen: say so in the answer.
const MIXED_REVENUE: [RegExp, string][] = [
  [/glencore/i, "Glencore is a diversified producer and trader (copper, coal, nickel, zinc, cobalt and a large marketing business); one metal price explains only part of its results."],
  [/rio tinto/i, "Rio Tinto earns most of its profit from iron ore but also from copper, aluminium and minerals; one price explains only part of its results."],
  [/south32/i, "South32 sells aluminium, alumina, manganese, zinc, lead, silver, nickel and coal; one price explains only part of its results."],
  [/umicore/i, "Umicore is mainly a materials-technology and recycling group; commodity prices are only one driver of its results."],
  [/sqm|sociedad quimica/i, "SQM sells lithium but also potash, iodine and nitrates; a lithium price explains only part of its results."],
  [/albemarle/i, "Albemarle sells lithium but also bromine and catalysts; a lithium price explains only part of its results."],
  [/sibanye/i, "Sibanye-Stillwater mines PGMs and gold in South Africa and PGMs in the US; platinum or palladium alone explains only part of its results."],
  [/impala/i, "Impala sells a basket of platinum, palladium, rhodium, nickel and other metals; a single metal price explains only part of its results."],
  [/china northern/i, "China Northern Rare Earth sells many rare earth and magnet products at domestic Chinese prices, not the series shown."],
  [/neo performance/i, "Neo Performance Materials processes and sells many materials; a single price explains only part of its results."],
];

const SENS_METRICS = ["revenue", "ebitda", "operating_income", "net_income", "free_cash_flow", "operating_margin", "ebitda_margin", "net_margin"] as const;
export const SENSITIVITY_METRICS: string[] = [...SENS_METRICS];

export async function priceSensitivity(input: Record<string, unknown>): Promise<ToolOutput> {
  const pool = getPool();
  let names = Array.isArray(input.companies) ? (input.companies as unknown[]).map(String) : typeof input.company === "string" ? [input.company] : [];
  if (names.length === 0 && typeof input.peer_group === "string" && input.peer_group.trim()) {
    const g = await peerGroupMembers(input.peer_group);
    if (!g.matched) return { content: JSON.stringify({ found: false, note: "No peer group with that name.", available_peer_groups: g.available }) };
    names = g.names;
  }
  if (names.length === 0) throw new Error("Name at least one company (or a peer group).");
  names = names.slice(0, 6);
  const metric = (SENS_METRICS as readonly string[]).includes(String(input.metric)) ? String(input.metric) : "revenue";
  const lag = Math.min(Math.max(Math.floor(Number(input.lag_years) || 0), 0), 2);
  const realised = input.price_source === "realised";
  const commodity = String(input.commodity ?? "").trim();
  const seriesIdIn = input.series_id === undefined || input.series_id === null ? NaN : Number(input.series_id);
  if (!commodity && !Number.isFinite(seriesIdIn)) throw new Error("Give a commodity (for example uranium, copper, platinum) or a series_id; with price_source \"realised\" the commodity filters the company's own realised-price series.");
  const fromYear = Number(input.from_year) || null;
  const toYear = Number(input.to_year) || null;
  const isMargin = metric.endsWith("_margin");

  const { ids, unresolved } = await resolveCompanies(names);
  const rowsAll = await financialRows(ids);
  const byCo = new Map<number, Row[]>();
  for (const r of rowsAll) {
    addDerived(r);
    byCo.set(r.company_id as number, [...(byCo.get(r.company_id as number) ?? []), r]);
  }
  // Same consistency rule as company_financials: no mixing of company-defined and derived EBITDA in one series.
  for (const rows of byCo.values()) {
    if (rows.some((r) => typeof r.ebitda_reported === "number")) for (const r of rows) if (typeof r.ebitda_reported !== "number") { r.ebitda = null; r.ebitda_basis = null; }
  }

  // Market price series (shared by all companies): the best monthly series if one exists, else the best annual one.
  type Series = { series_id: number; name: string; source: string; unit: string; frequency: string; basis: string; monthly: Map<string, number>; annual: Map<string, number> };
  let market: Series | null = null;
  if (!realised) {
    let cands: Row[];
    if (Number.isFinite(seriesIdIn)) {
      cands = (await pool.query(`SELECT * FROM markets.price_series WHERE series_id = $1 AND is_active`, [Math.floor(seriesIdIn)])).rows;
    } else {
      const like = `%${commodity.replace(/[%_]/g, "")}%`;
      cands = (
        await pool.query(
          `SELECT * FROM markets.price_series WHERE is_active AND (commodity_label ILIKE $1 OR series_name ILIKE $1) AND price_basis NOT ILIKE '%constant%'
           ORDER BY (frequency = 'monthly') DESC, n_observations DESC,
                    CASE source WHEN 'WORLD_BANK_PINK_SHEET' THEN 0 WHEN 'IMF_PCPS' THEN 1 WHEN 'USGS_MCS_2026' THEN 2 ELSE 3 END LIMIT 12`,
          [like]
        )
      ).rows;
    }
    const s = cands[0];
    if (!s) {
      return { content: JSON.stringify({ found: false, note: "No price series matches that commodity. Prices are held for base and precious metals, uranium, cobalt, potash and about 90 USGS annual commodity prices.", not_found_companies: unresolved }) };
    }
    const pts = (await pool.query(`SELECT period_start::text d, value::float8 v, value_low::float8 lo, value_high::float8 hi FROM markets.prices WHERE series_id = $1 ORDER BY period_start`, [s.series_id])).rows;
    const monthly = new Map<string, number>(), annual = new Map<string, number>();
    for (const p of pts) {
      const v = typeof p.v === "number" ? p.v : typeof p.lo === "number" && typeof p.hi === "number" ? (p.lo + p.hi) / 2 : null;
      if (v === null) continue;
      if (s.frequency === "monthly") monthly.set(String(p.d).slice(0, 7), v);
      else annual.set(String(p.d).slice(0, 4), v);
    }
    market = { series_id: Number(s.series_id), name: String(s.series_name), source: String(s.source), unit: String(s.unit ?? ""), frequency: String(s.frequency), basis: String(s.price_basis ?? ""), monthly, annual };
  }

  type Pt = { fy: number; pe: string; price: number; value: number; note: string | null };
  const results: Record<string, unknown>[] = [];
  const csvRows: (string | number | null)[][] = [];
  const chartSeries: { name: string; points: [string, number][] }[] = [];
  const evidence: Evidence[] = [{ kind: "data", label: "Company financial statements (filings and annual reports)", detail: "annual results" }];
  const scaled = (arr: number[]) => {
    const lo = Math.min(...arr), hi = Math.max(...arr);
    return arr.map((v) => (hi === lo ? 50 : ((v - lo) / (hi - lo)) * 100));
  };
  const rd = (v: number | null | undefined, dp = 3) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10 ** dp) / 10 ** dp);

  for (const [cid, rows] of byCo) {
    const company = String(rows[0].company);
    const reportedCur = String(rows[0].currency);

    // Price per fiscal year for this company.
    let priceUnit = "", priceName = "", priceNote = "", priceCur: string | null = null;
    const priceByFy = new Map<number, number>();
    if (realised) {
      const cand = (
        await pool.query(
          `SELECT m.commodity, m.basis, m.unit, m.asset_name, count(*) n FROM financials.operating_metrics m
           WHERE m.company_id = $1 AND m.is_active AND m.metric = 'average_realised_price' AND (m.commodity ILIKE $2 OR m.asset_name ILIKE $2)
           GROUP BY 1,2,3,4 ORDER BY (m.unit ILIKE 'US$%') DESC, count(*) DESC`,
          [cid, `%${commodity.replace(/[%_]/g, "")}%`]
        )
      ).rows;
      if (cand.length === 0) {
        results.push({ company, status: "no_data", reason: "No average realised price for that commodity is loaded for this company." });
        continue;
      }
      const c0 = cand[0];
      const pts = (
        await pool.query(
          `SELECT extract(year from period_end_date)::int y, value::float8 v FROM financials.operating_metrics
           WHERE company_id = $1 AND is_active AND metric = 'average_realised_price' AND commodity = $2 AND basis IS NOT DISTINCT FROM $3 AND unit = $4 AND asset_name IS NOT DISTINCT FROM $5 ORDER BY 1`,
          [cid, c0.commodity, c0.basis, c0.unit, c0.asset_name]
        )
      ).rows;
      for (const p of pts) priceByFy.set(p.y, p.v);
      priceUnit = String(c0.unit);
      priceName = `${company} average realised price: ${c0.commodity}${c0.basis ? " (" + c0.basis + ")" : ""}`;
      priceCur = /^US\$/.test(priceUnit) ? "USD" : /^A\$/.test(priceUnit) ? "AUD" : /^C\$/.test(priceUnit) ? "CAD" : null;
      priceNote = "The company's own average realised price per fiscal year, from its annual report (not a benchmark index). It reflects contract terms and product mix.";
      if (cand.length > 1) priceNote += ` Other realised-price series for this company: ${cand.slice(1, 4).map((c) => `${c.commodity}${c.basis ? " (" + c.basis + ")" : ""}`).join("; ")}.`;
    } else if (market) {
      priceUnit = market.unit;
      priceName = market.name;
      for (const r of rows) {
        const pe = String(r.period_end);
        const fy = Number(pe.slice(0, 4));
        if (market.frequency === "monthly") {
          // Average of the twelve monthly averages ending in the fiscal year-end month.
          const end = new Date(pe + "T00:00:00Z");
          const vals: number[] = [];
          for (let k = 0; k < 12; k++) {
            const d = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - k, 1));
            const v = market.monthly.get(d.toISOString().slice(0, 7));
            if (v !== undefined) vals.push(v);
          }
          if (vals.length === 12) priceByFy.set(fy, vals.reduce((a, b) => a + b, 0) / 12);
        } else if (market.annual.has(String(fy))) priceByFy.set(fy, market.annual.get(String(fy))!);
      }
      priceNote =
        market.frequency === "monthly"
          ? "Price is the average of the twelve monthly averages ending in the company's fiscal year-end month, so it lines up with the fiscal year."
          : "Annual price series: the calendar year in which the fiscal year ends. A June year end overlaps only half of that year.";
    }

    // Company figures are in US dollars unless the price is in the company's own reporting currency.
    const sameCur = priceCur !== null && priceCur === reportedCur && reportedCur !== "USD";
    const unit = isMargin ? "fraction of revenue" : sameCur ? `${reportedCur} millions (same currency as the price)` : "US$ millions";
    const amount = (v: number | null) => (v === null ? "n/a" : sameCur ? `${reportedCur} ${v} million` : `US$${v} million`);
    const pts: Pt[] = [];
    for (const r of rows) {
      const fy = Number(String(r.period_end).slice(0, 4));
      if ((fromYear && fy < fromYear) || (toYear && fy > toYear)) continue;
      const price = priceByFy.get(fy - lag);
      const rate = sameCur || reportedCur === "USD" ? 1 : (r.fx_avg as number | null);
      if (price === undefined || !rate) continue;
      const num = (key: string) => (typeof r[key] === "number" ? (r[key] as number) / rate / 1e6 : null);
      const rev = num("revenue");
      let value: number | null;
      if (metric === "revenue") value = rev;
      else if (metric === "ebitda") value = num("ebitda");
      else if (metric === "operating_income") value = num("operating_income");
      else if (metric === "net_income") value = num("net_income");
      else if (metric === "free_cash_flow") value = num("free_cash_flow");
      else {
        const top = metric === "operating_margin" ? num("operating_income") : metric === "ebitda_margin" ? num("ebitda") : num("net_income");
        value = top !== null && rev ? top / rev : null;
      }
      if (value === null || !Number.isFinite(value)) continue;
      pts.push({ fy, pe: String(r.period_end), price, value, note: typeof r.note === "string" && r.note.trim() ? r.note.trim().slice(0, 200) : null });
    }
    const mixed = MIXED_REVENUE.find(([re]) => re.test(company))?.[1];
    if (pts.length < 6) {
      results.push({
        company,
        status: "insufficient_history",
        reason: `Only ${pts.length} fiscal years have both a price and ${metric} (at least 6 are needed for a regression).`,
        price_series: priceName,
        years_available: pts.map((p) => p.fy),
        ...(market && market.frequency !== "monthly" ? { hint: "This commodity has only a short annual price series (2021-2025). Try price_source \"realised\" for a company that reports its own realised price, or a commodity with a long monthly series." } : {}),
        ...(mixed ? { mixed_revenue_warning: mixed } : {}),
      });
      continue;
    }

    const x = pts.map((p) => p.price), y = pts.map((p) => p.value);
    const fit = ols(x, y);
    if (!fit) {
      results.push({ company, status: "no_variation", reason: "The price did not vary across the years available." });
      continue;
    }
    const mx = x.reduce((a, b) => a + b, 0) / x.length, my = y.reduce((a, b) => a + b, 0) / y.length;
    const latest = pts[pts.length - 1];
    // Log-log elasticity (needs positive values), and year-on-year change correlation as a robustness check.
    const positive = !isMargin && y.every((v) => v > 0) && x.every((v) => v > 0);
    const logFit = positive ? ols(x.map(Math.log), y.map(Math.log)) : null;
    const dx: number[] = [], dy: number[] = [];
    if (positive) for (let i = 1; i < pts.length; i++) if (pts[i].fy - pts[i - 1].fy === 1) { dx.push(pts[i].price / pts[i - 1].price - 1); dy.push(pts[i].value / pts[i - 1].value - 1); }
    const yoyR = dx.length >= 5 ? pearson(dx, dy) : null;
    const strength = strengthLabel(fit);
    // Robustness: refit without the year the line fits worst (a one-off such as an impairment can drive a whole fit).
    let withoutOutlier: Record<string, unknown> | null = null;
    if (pts.length >= 8) {
      let worst = 0, wi = 0;
      pts.forEach((p, i) => { const e = Math.abs(p.value - (fit.intercept + fit.slope * p.price)); if (e > worst) { worst = e; wi = i; } });
      const f2 = ols(x.filter((_, i) => i !== wi), y.filter((_, i) => i !== wi));
      if (f2) {
        withoutOutlier = {
          excluded_year: pts[wi].fy,
          excluded_year_note: pts[wi].note,
          r_squared: rd(f2.r2, 3),
          p_value: rd(f2.p, 4),
          strength: strengthLabel(f2),
          slope_per_price_unit: rd(f2.slope, 4),
          meaning: isMargin
            ? `the margin moves ${rd(f2.slope * 0.1 * mx * 100, 1)} percentage points for a price change of 10% of its average level`
            : `${metric.replace(/_/g, " ")} moves by about ${amount(rd(f2.slope * 0.1 * mx, 1))} for a price change of 10% of its average level`,
        };
      }
    }

    const base = fit.intercept + fit.slope * latest.price;
    const whatIf = [-0.2, -0.1, 0.1, 0.2].map((s) => {
      const newPrice = latest.price * (1 + s);
      return {
        price_change: `${s > 0 ? "+" : ""}${Math.round(s * 100)}%`,
        price: rd(newPrice, 2),
        implied_change_in_metric: rd(fit.intercept + fit.slope * newPrice - base, isMargin ? 4 : 1),
        within_observed_price_range: newPrice >= Math.min(...x) && newPrice <= Math.max(...x),
      };
    });

    results.push({
      company,
      status: "ok",
      metric,
      metric_unit: unit,
      price_series: priceName,
      price_unit: priceUnit,
      price_alignment: priceNote + (lag ? ` The price is lagged by ${lag} year(s) (price of fiscal year t-${lag} against results of year t).` : ""),
      n_years: pts.length,
      years: `${pts[0].fy}-${latest.fy}`,
      fit: {
        slope_per_price_unit: rd(fit.slope, 4),
        meaning: isMargin
          ? `the margin moves ${rd(fit.slope * 0.1 * mx * 100, 1)} percentage points for a price change of 10% of its average level (${rd(mx, 2)} ${priceUnit})`
          : `${metric.replace(/_/g, " ")} moves by about ${amount(rd(fit.slope * 0.1 * mx, 1))} for a price change of 10% of its average level (${rd(mx, 2)} ${priceUnit})`,
        r_squared: rd(fit.r2, 3),
        p_value: rd(fit.p, 4),
        strength,
        elasticity_at_mean: !isMargin && my !== 0 ? rd((fit.slope * mx) / my, 2) : null,
        log_log_elasticity: logFit ? rd(logFit.slope, 2) : null,
        log_log_r_squared: logFit ? rd(logFit.r2, 3) : null,
        yoy_change_correlation: yoyR !== null ? rd(yoyR, 2) : null,
        yoy_pairs: dx.length,
      },
      ...(withoutOutlier ? { refit_without_worst_fitting_year: withoutOutlier } : {}),
      what_if_from_latest_price: { latest_price: rd(latest.price, 2), latest_year: latest.fy, scenarios: whatIf },
      ...(mixed ? { mixed_revenue_warning: mixed } : {}),
      data: pts.map((p) => ({ fiscal_year: p.fy, price: rd(p.price, 2), value: rd(p.value, isMargin ? 4 : 1), ...(p.note ? { company_note: p.note } : {}) })),
    });
    for (const p of pts) csvRows.push([company, p.fy, p.pe, rd(p.price, 2), priceUnit, rd(p.value, isMargin ? 4 : 1), unit]);
    const sp = scaled(x), sy = scaled(y);
    chartSeries.push({ name: `${company}: price`, points: pts.map((p, i) => [p.pe, sp[i]] as [string, number]) });
    chartSeries.push({ name: `${company}: ${metric.replace(/_/g, " ")}`, points: pts.map((p, i) => [p.pe, sy[i]] as [string, number]) });
  }

  if (market) evidence.push({ kind: "data", label: `${market.name} (${market.source.replace(/_/g, " ").toLowerCase()})`, detail: market.unit });
  if (realised) evidence.push({ kind: "data", label: "Average realised prices from company annual reports", detail: commodity });
  evidence.push({ kind: "data", label: "Exchange rates (Bank for International Settlements)", detail: "monthly averages" });

  const okCount = results.filter((x) => x.status === "ok").length;
  const dataset: Dataset | null = csvRows.length
    ? {
        id: "sens-" + Date.now(),
        title: `Results against price: ${metric.replace(/_/g, " ")}`,
        columns: ["Company", "Fiscal year", "Fiscal year end", "Price", "Price unit", metric.replace(/_/g, " "), "Metric unit"],
        rows: csvRows,
        // Both lines are scaled to run from 0 (lowest year) to 100 (highest year) so price and results can share one axis.
        chart: { unit: "scaled 0-100 (each line from its own lowest to highest year)", series: chartSeries },
      }
    : null;

  return {
    content: JSON.stringify({
      what_this_is: "A historical association between a commodity price and a company's results over its stored fiscal years. It describes the past; it is not a forecast and does not prove the price caused the results.",
      results,
      not_found: unresolved,
      how_to_report: [
        "Lead with the strength label, R-squared, the number of years and the plain-language meaning; then the what-if table, noting which scenarios fall outside the observed price range.",
        "With fewer than about 10 years the statistics are rough: say so. Never describe a 'weak or none' fit as a relationship.",
        "A chart showing the price and the results (each scaled 0 to 100) is shown to the user automatically; interpret it, do not describe how to draw it.",
        "Other things move results too: sales volumes, hedging, contract pricing, cost inflation, currency, acquisitions, impairments. Name these only as general possibilities. Do not state a specific company event (an acquisition, an accounting change, an impairment) as a fact unless it appears in a company_note in the data returned here or in another source you have used; otherwise offer to look it up.",
        "Always mention refit_without_worst_fitting_year when it exists: say which year it excludes, why if its company_note explains it, and whether the conclusion changes.",
        "If you ran the same question with a one- or two-year lag as well, say that you tried both and report both; do not present only the better fit.",
        okCount === 0 ? "Nothing could be fitted: say why and suggest the realised-price option or another commodity." : "",
      ].filter(Boolean),
    }),
    evidence,
    datasets: dataset ? [dataset] : [],
  };
}
