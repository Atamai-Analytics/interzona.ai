import { runReadOnlyQuery } from "@/lib/db";
import type { Dataset, Evidence } from "@/lib/types";

// Trade comparison over years from CEPII BACI (markets.trade_flows_named). Every cross-year fact - ranks, years ranked first, years with
// no flow, minimum and maximum, peak and low of the total - is computed HERE from the rows and returned as ready-made statements, because
// answers that summarised multi-year tables by eye kept getting ranges wrong ("largest every year", "under $13 million every year").

type Out = { content: string; evidence?: Evidence[]; datasets?: Dataset[] };
type Row = { year: number; key: string; label: string; usd_million: number; tonnes: number | null };

const CREDIT = "CEPII BACI (version 202601, HS12), Gaulier and Zignago (2010), Etalab Open Licence 2.0";
const FIRST_YEAR = 2012;
const LAST_YEAR = 2024;
const ALIASES: Record<string, string> = {
  drc: "COD", "dr congo": "COD", "democratic republic of the congo": "COD", "congo, dem. rep.": "COD", "dem. rep. of the congo": "COD",
  uk: "GBR", "united kingdom": "GBR", britain: "GBR", us: "USA", usa: "USA", "united states": "USA", america: "USA",
  "south korea": "KOR", korea: "KOR", russia: "RUS", turkey: "TUR", "türkiye": "TUR", vietnam: "VNM", "viet nam": "VNM", iran: "IRN",
};
const TAIWAN = /^(taiwan|chinese taipei|other asia)/i;

const esc = (s: string) => s.replace(/'/g, "''");
const r1 = (x: number) => Math.round(x * 10) / 10;
const usd = (m: number) => (m >= 1000 ? `US$${(m / 1000).toLocaleString("en-US", { maximumFractionDigits: 2 })} billion` : `US$${r1(m).toLocaleString("en-US")} million`);

/** 2012, 2013, 2014, 2016 -> "2012-2014 and 2016". */
function yearList(ys: number[]): string {
  const s = [...new Set(ys)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < s.length; ) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    parts.push(j > i ? `${s[i]}-${s[j]}` : `${s[i]}`);
    i = j + 1;
  }
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0] ?? "";
}

async function country(q: string): Promise<{ codes: number[]; name: string } | { error: string }> {
  const t = q.trim();
  if (TAIWAN.test(t)) return { codes: [490], name: "Taiwan (reported as Other Asia, n.e.s.)" };
  const iso = ALIASES[t.toLowerCase()] ?? (/^[A-Za-z]{3}$/.test(t) ? t.toUpperCase() : null);
  const where = iso ? `iso3 = '${esc(iso)}'` : `lower(country_name) = lower('${esc(t)}') OR country_name ILIKE '%${esc(t)}%'`;
  const rows = (await runReadOnlyQuery(`SELECT country_code, country_name, iso3 FROM markets.trade_countries WHERE ${where} ORDER BY (lower(country_name) = lower('${esc(t)}')) DESC, country_name`, 20)).rows as { country_code: number; country_name: string; iso3: string | null }[];
  if (!rows.length) return { error: `No country matches "${q}" in the BACI country list.` };
  const exact = rows.filter((r) => r.country_name.toLowerCase() === t.toLowerCase() || (iso && r.iso3 === iso));
  const pick = exact.length ? exact : rows.length === 1 ? rows : null;
  if (!pick) return { error: `"${q}" matches several countries: ${rows.map((r) => `${r.country_name} (${r.iso3 ?? r.country_code})`).join("; ")}. Ask again with one of these names or its ISO3 code.` };
  return { codes: pick.map((r) => Number(r.country_code)), name: pick[0].country_name };
}

export async function tradeComparison(input: Record<string, unknown>): Promise<Out> {
  const compare = ["codes", "exporters", "importers"].includes(String(input.compare)) ? String(input.compare) : "codes";
  const fromYear = Math.max(FIRST_YEAR, Math.min(LAST_YEAR, Number(input.from_year) || FIRST_YEAR));
  const toYear = Math.max(fromYear, Math.min(LAST_YEAR, Number(input.to_year) || LAST_YEAR));
  const topN = Math.max(3, Math.min(15, Number(input.top_n) || 8));

  // ---- product filter -------------------------------------------------------------------------------------------------------------------
  const hsIn = (Array.isArray(input.hs6) ? input.hs6 : String(input.hs6 ?? "").split(/[,\s]+/)).map((x) => String(x).trim()).filter((x) => /^\d{6}$/.test(x));
  const commodityIn = String(input.commodity ?? "").trim();
  let productWhere = "";
  let productLabel = "";
  if (hsIn.length) {
    productWhere = `hs6 IN (${hsIn.map((h) => `'${h}'`).join(",")})`;
    productLabel = `HS ${hsIn.join(", ")}`;
  } else if (commodityIn) {
    const groups = (await runReadOnlyQuery(`SELECT DISTINCT commodity FROM markets.trade_products ORDER BY 1`, 400)).rows.map((r) => String((r as { commodity: string }).commodity));
    const q = commodityIn.toLowerCase();
    let match = groups.filter((g) => g.toLowerCase() === q);
    if (!match.length) match = groups.filter((g) => g.toLowerCase().startsWith(q) || g.toLowerCase().includes(q));
    if (!match.length) return { content: `No traded product group matches "${commodityIn}". Groups available: ${groups.join("; ")}.` };
    if (match.length > 1 && !match.some((g) => g.toLowerCase() === q)) match = [match[0]];
    productWhere = `commodity IN (${match.map((m) => `'${esc(m)}'`).join(",")})`;
    productLabel = match.join(", ");
  } else {
    return { content: "Give a commodity (e.g. cobalt, lithium, rare earths) or one or more HS6 codes." };
  }

  // ---- country filters ------------------------------------------------------------------------------------------------------------------
  const filters: string[] = [productWhere, `year BETWEEN ${fromYear} AND ${toYear}`];
  const names: Record<string, string> = {};
  for (const side of ["exporter", "importer"] as const) {
    const v = String(input[side] ?? "").trim();
    if (!v) continue;
    const c = await country(v);
    if ("error" in c) return { content: c.error };
    filters.push(`${side}_code IN (${c.codes.join(",")})`);
    names[side] = c.name;
  }
  if (compare === "exporters" && names.exporter) return { content: "To compare exporters, leave the exporter out (give an importer and/or a product)." };
  if (compare === "importers" && names.importer) return { content: "To compare importers, leave the importer out (give an exporter and/or a product)." };

  const keyCol = compare === "codes" ? "hs6" : compare === "exporters" ? "exporter" : "importer";
  const labelCol = compare === "codes" ? "min(product)" : keyCol;
  const sql = `SELECT year, ${keyCol} AS key, ${labelCol} AS label, sum(value_kusd)/1000.0 AS usd_million, sum(quantity_t) AS tonnes
               FROM markets.trade_flows_named WHERE ${filters.join(" AND ")} GROUP BY year, ${keyCol} ORDER BY year, usd_million DESC`;
  const raw = (await runReadOnlyQuery(sql, 5000)).rows as { year: number; key: string; label: string; usd_million: string; tonnes: string | null }[];
  if (!raw.length) return { content: `No BACI flows for ${productLabel}${names.exporter ? ` from ${names.exporter}` : ""}${names.importer ? ` to ${names.importer}` : ""} in ${fromYear}-${toYear}.` };
  const rows: Row[] = raw.map((r) => ({ year: Number(r.year), key: String(r.key), label: String(r.label ?? r.key), usd_million: Number(r.usd_million), tonnes: r.tonnes === null ? null : Number(r.tonnes) }));
  const keyName = (k: string, lbl: string) => (compare === "codes" ? `HS ${k} (${lbl.split(":")[0].slice(0, 70)})` : k === "Other Asia, nes" ? "Taiwan (reported as Other Asia, n.e.s.)" : k);

  // ---- per year: totals and ranks -------------------------------------------------------------------------------------------------------
  const years = [...new Set(rows.map((r) => r.year))].sort((a, b) => a - b);
  const allYears = Array.from({ length: toYear - fromYear + 1 }, (_, i) => fromYear + i);
  const totals = new Map<number, { usd: number; t: number }>();
  const rank = new Map<string, number>();
  for (const y of years) {
    const ry = rows.filter((r) => r.year === y).sort((a, b) => b.usd_million - a.usd_million);
    totals.set(y, { usd: ry.reduce((s, r) => s + r.usd_million, 0), t: ry.reduce((s, r) => s + (r.tonnes ?? 0), 0) });
    ry.forEach((r, i) => rank.set(`${y}|${r.key}`, i + 1));
  }

  // ---- per key facts -------------------------------------------------------------------------------------------------------------------
  const keys = [...new Set(rows.map((r) => r.key))];
  const facts = keys.map((k) => {
    const rk = rows.filter((r) => r.key === k);
    const lbl = keyName(k, rk[0].label);
    const firstYears = rk.filter((r) => rank.get(`${r.year}|${k}`) === 1).map((r) => r.year);
    const withFlow = rk.filter((r) => r.usd_million >= 0.05).map((r) => r.year);
    const noFlow = allYears.filter((y) => !withFlow.includes(y));
    const mn = rk.reduce((a, b) => (b.usd_million < a.usd_million ? b : a));
    const mx = rk.reduce((a, b) => (b.usd_million > a.usd_million ? b : a));
    const sum = rk.reduce((s, r) => s + r.usd_million, 0);
    // share of each year's total (a year with no row counts as 0%), so "small" / "large" claims can be checked against numbers
    const shares = allYears.filter((y) => totals.has(y)).map((y) => {
      const r = rk.find((x) => x.year === y);
      const tot = totals.get(y)!.usd;
      return { year: y, pct: tot > 0 && r ? (r.usd_million / tot) * 100 : 0 };
    });
    const sMin = shares.reduce((a, b) => (b.pct < a.pct ? b : a));
    const sMax = shares.reduce((a, b) => (b.pct > a.pct ? b : a));
    const over20 = shares.filter((s) => s.pct >= 20).map((s) => s.year);
    return { key: k, label: lbl, total_usd_million: r1(sum), years_with_flows: withFlow.length, years_ranked_first: firstYears.length, ranked_first_in: yearList(firstYears) || "none", no_recorded_flow_in: yearList(noFlow) || "none", min: { usd_million: r1(mn.usd_million), year: mn.year }, max: { usd_million: r1(mx.usd_million), year: mx.year }, share_of_year_total_pct: { min: r1(sMin.pct), min_year: sMin.year, max: r1(sMax.pct), max_year: sMax.year, years_at_or_above_20pct: yearList(over20) || "none" } };
  }).sort((a, b) => b.total_usd_million - a.total_usd_million);

  // ---- ready-made statements -----------------------------------------------------------------------------------------------------------
  const nY = allYears.length;
  const statements: string[] = [];
  const peak = [...totals.entries()].reduce((a, b) => (b[1].usd > a[1].usd ? b : a));
  const low = [...totals.entries()].reduce((a, b) => (b[1].usd < a[1].usd ? b : a));
  statements.push(`Over ${fromYear}-${toYear} the total was highest in ${peak[0]} (${usd(peak[1].usd)}) and lowest in ${low[0]} (${usd(low[1].usd)}).`);
  // where the latest year sits in the series (answers otherwise invent "lowest since ..." / "highest since ...")
  const lastY = years[years.length - 1];
  const lastT = totals.get(lastY)!.usd;
  const byValue = [...totals.entries()].sort((a, b) => b[1].usd - a[1].usd);
  const lastRank = byValue.findIndex(([y]) => y === lastY) + 1;
  const earlierLower = years.filter((y) => y < lastY && totals.get(y)!.usd < lastT);
  const earlierHigher = years.filter((y) => y < lastY && totals.get(y)!.usd > lastT);
  statements.push(
    `The ${lastY} total (${usd(lastT)}) was the ${lastRank === 1 ? "highest" : lastRank === years.length ? "lowest" : `number ${lastRank} of ${years.length}`} year by value; ` +
      `${earlierLower.length ? `the most recent earlier year with a lower total was ${Math.max(...earlierLower)}` : "no earlier year had a lower total"}, and ` +
      `${earlierHigher.length ? `the most recent earlier year with a higher total was ${Math.max(...earlierHigher)}` : "no earlier year had a higher total"}.`,
  );
  if (years.length >= 2) {
    const prevY = years[years.length - 2];
    const prevT = totals.get(prevY)!.usd;
    statements.push(`From ${prevY} to ${lastY} the total went from ${usd(prevT)} to ${usd(lastT)} (${prevT > 0 ? `${lastT >= prevT ? "+" : ""}${r1(((lastT - prevT) / prevT) * 100)}%` : "no earlier value"}).`);
  }
  if (peak[0] !== lastY) {
    statements.push(`From the peak in ${peak[0]} (${usd(peak[1].usd)}) to ${lastY} (${usd(lastT)}) the total changed by ${r1(((lastT - peak[1].usd) / peak[1].usd) * 100)}%.`);
  }
  const yNo = allYears.filter((y) => !totals.has(y));
  if (yNo.length) statements.push(`No flow was recorded at all in ${yearList(yNo)}.`);
  for (const f of facts.slice(0, topN)) {
    const firstPart = f.years_ranked_first === 0 ? `was never the largest ${compare === "codes" ? "code" : compare.slice(0, -1)}` : f.years_ranked_first === nY ? `was the largest in all ${nY} years` : `was the largest in ${f.years_ranked_first} of ${nY} years (${f.ranked_first_in})`;
    const flowPart = f.no_recorded_flow_in === "none" ? "" : `; no flow (or under US$0.05 million) was recorded in ${f.no_recorded_flow_in}`;
    const range = f.min.usd_million === f.max.usd_million ? `${usd(f.max.usd_million)} in ${f.max.year}` : `ranged from ${usd(f.min.usd_million)} (${f.min.year}) to ${usd(f.max.usd_million)} (${f.max.year})`;
    statements.push(`${f.label} ${firstPart}; in the years it appears it ${range}${flowPart}.`);
    // full rank by year (answers otherwise guess "second in most years")
    const byRank = new Map<number, number[]>();
    for (const y of years) { const rk = rank.get(`${y}|${f.key}`); if (rk) byRank.set(rk, [...(byRank.get(rk) ?? []), y]); }
    const ord = (n: number) => (n === 1 ? "1st" : n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`);
    statements.push(`${f.label} ranked ${[...byRank.entries()].sort((a, b) => a[0] - b[0]).map(([n, ys]) => `${ord(n)} in ${yearList(ys)}`).join("; ")}${f.no_recorded_flow_in === "none" ? "" : `; not ranked (no flow) in ${f.no_recorded_flow_in}`}.`);
    const sh = f.share_of_year_total_pct;
    statements.push(
      `${f.label}'s share of each year's total ranged from ${sh.min}% (${sh.min_year}) to ${sh.max}% (${sh.max_year})` +
        (sh.years_at_or_above_20pct === "none" ? "; it was below 20% of the total in every year." : `; it was 20% or more of the total in ${sh.years_at_or_above_20pct}.`),
    );
  }

  // ---- tables -------------------------------------------------------------------------------------------------------------------------
  const shown = facts.slice(0, topN).map((f) => f.key);
  const table = years.map((y) => {
    const tot = totals.get(y)!;
    const cells = shown.map((k) => {
      const r = rows.find((x) => x.year === y && x.key === k);
      return r ? { usd_million: r1(r.usd_million), tonnes: r.tonnes === null ? null : Math.round(r.tonnes), rank: rank.get(`${y}|${k}`) } : null;
    });
    return { year: y, total_usd_million: r1(tot.usd), total_tonnes: Math.round(tot.t), by_key: Object.fromEntries(shown.map((k, i) => [facts.find((f) => f.key === k)!.label, cells[i]])) };
  });
  const title = `${productLabel}${names.exporter ? ` from ${names.exporter}` : ""}${names.importer ? ` to ${names.importer}` : ""}, ${fromYear}-${toYear}, by ${compare === "codes" ? "HS code" : compare.slice(0, -1)}`;
  const dataset: Dataset = {
    id: "trade-" + Date.now().toString(36),
    title: `Trade: ${title} (US$ million)`,
    columns: ["Year", "Total", ...shown.map((k) => facts.find((f) => f.key === k)!.label)],
    rows: years.map((y) => [y, r1(totals.get(y)!.usd), ...shown.map((k) => { const r = rows.find((x) => x.year === y && x.key === k); return r ? r1(r.usd_million) : null; })]),
    chart: { unit: "US$ million (current)", series: shown.slice(0, 6).map((k) => ({ name: facts.find((f) => f.key === k)!.label, points: years.map((y) => [String(y), r1(rows.find((x) => x.year === y && x.key === k)?.usd_million ?? 0)] as [string, number]) })) },
  };

  return {
    content: JSON.stringify({
      what: `Trade comparison over years: ${title}`,
      units: "Values in current US dollars (FOB-reconciled by CEPII from UN Comtrade); tonnes are the weight of the product shipped (ore, concentrate, hydroxide, matte...), NOT metal content; 2024 is provisional.",
      how_to_use: "For ANY statement that compares years, ranks, ranges or says 'every year' / 'never' / 'from X onward' / 'under $X' / 'lowest (highest) since', quote or closely paraphrase the matching entry in 'statements' - if no statement covers a comparison, do not make it. Words like 'small', 'large', 'minor', 'negligible', 'dominant' or 'always' about a code or country across years are comparisons too: use them only for the years the share statements support (e.g. 'small since 2015' only if its share was low in every year from 2015), otherwise give the share range from the statement. Never compute a percentage change yourself - use the change statements; never say a code was 'second' or 'largest' in a year unless the rank statement says so. Per-year figures may be quoted from 'table'. Shares are of recorded trade, not production. Write tonnage as 'tonnes of <product shipped>' (e.g. 'tonnes of cobalt intermediate product') - NEVER 'tonnes of cobalt' or any metal name alone, including in the opening sentence.",
      statements,
      per_key: facts.slice(0, topN),
      other_keys_not_shown: Math.max(0, facts.length - topN),
      table,
      credit: CREDIT,
    }),
    evidence: [{ kind: "data", label: `Trade flows: ${CREDIT}`, detail: title }],
    datasets: [dataset],
  };
}
