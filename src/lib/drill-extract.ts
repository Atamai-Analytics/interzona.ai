import { runReadOnlyQuery } from "@/lib/db";
import { creditsForSource } from "@/lib/licence";
import { ELEMENTS, fromPpm, resolveElement } from "@/lib/composite";
import { INTERCEPT_SOURCES, SOURCE_LABEL, gradeSql } from "@/lib/intercepts";

// Server side of the Drill intercepts page: find drill holes that have downhole assay intervals for an element (Tasmania MRT, Athabasca OF 7792)
// and load their intervals. The compositing itself runs in the browser (src/lib/composite.ts). Read-only role; every value that reaches SQL is a
// whitelisted code, a number or an escaped search string.

export const DRILL_SOURCES = INTERCEPT_SOURCES.composite;
const q = (s: string) => "'" + s.replace(/'/g, "''") + "'";

export type HoleRow = {
  id: number; name: string; source: string; prospect: string | null; company: string | null; lat: number | null; lon: number | null;
  depth: number | null; year: number | null; assayed: number; maxGrade: number | null;
};

function sourcesOf(raw: unknown): string[] {
  const s = String(raw ?? "");
  return DRILL_SOURCES.includes(s) ? [s] : DRILL_SOURCES;
}

export async function findHoles(params: { element?: unknown; source?: unknown; q?: unknown; bbox?: unknown }): Promise<{ holes: HoleRow[]; truncated: boolean; unit: string } | { error: string }> {
  const el = resolveElement(params.element);
  if (!el) return { error: "Unknown element." };
  const d = ELEMENTS[el];
  const g = await gradeSql(el, d, "w");
  if (!g) return { error: `No ${d.name} assays are held for drill samples.` };
  const sources = sourcesOf(params.source);
  const where = ["h.is_active"];
  const text = String(params.q ?? "").trim().replace(/[%_\\]/g, "").slice(0, 80);
  if (text) {
    const like = q("%" + text + "%");
    where.push(`(h.hole_name ILIKE ${like} OR h.prospect ILIKE ${like} OR h.company ILIKE ${like} OR o.name ILIKE ${like})`);
  }
  const bbox = Array.isArray(params.bbox) ? (params.bbox as unknown[]).map(Number) : null;
  if (bbox && bbox.length === 4 && bbox.every(Number.isFinite)) {
    const [w, s, e, n] = bbox;
    where.push(`h.lon BETWEEN ${Math.min(w, e)} AND ${Math.max(w, e)} AND h.lat BETWEEN ${Math.min(s, n)} AND ${Math.max(s, n)}`);
  }
  const LIMIT = 500;
  const res = await runReadOnlyQuery(
    `SELECT h.drillhole_id AS id, coalesce(h.hole_name, h.source_hole_id) AS name, min(w.source_system) AS source, nullif(concat_ws(' / ', o.name, h.prospect), '') AS prospect,
       h.company, h.lat, h.lon, h.total_depth_m AS depth, extract(year FROM h.date_drilled)::int AS year,
       count(*) FILTER (WHERE ${g.value} IS NOT NULL OR ${g.bdl}) AS assayed, max(${g.value}) AS max_ppm
     FROM drilling.drillholes h JOIN geochem.sample_chemistry_wide w ON w.drillhole_id = h.drillhole_id
       AND w.source_system IN (${sources.map(q).join(", ")}) AND w.depth_to_m > w.depth_from_m
     LEFT JOIN core.occurrences o ON o.occurrence_id = h.occurrence_id
     WHERE ${where.join(" AND ")}
     GROUP BY h.drillhole_id, h.hole_name, h.source_hole_id, o.name, h.prospect, h.company, h.lat, h.lon, h.total_depth_m, h.date_drilled
     HAVING count(*) FILTER (WHERE ${g.value} IS NOT NULL OR ${g.bdl}) > 0
     ORDER BY max(${g.value}) DESC NULLS LAST`,
    LIMIT,
  );
  const unit = d.unit === "g/t" ? `g/t ${d.reportAs}` : `${d.unit} ${d.reportAs}`;
  return {
    unit,
    truncated: res.truncated,
    holes: res.rows.map((x) => ({
      id: Number(x.id), name: String(x.name ?? x.id), source: String(x.source), prospect: (x.prospect as string) ?? null, company: (x.company as string) ?? null,
      lat: x.lat == null ? null : Number(x.lat), lon: x.lon == null ? null : Number(x.lon), depth: x.depth == null ? null : Number(x.depth),
      year: x.year == null ? null : Number(x.year), assayed: Number(x.assayed), maxGrade: x.max_ppm == null ? null : fromPpm(d, Number(x.max_ppm)),
    })),
  };
}

/** Intervals as [hole id, from, to, primary ppm | null, secondary ppm | null, flags] where flags: 1 = primary below detection, 2 = secondary below detection, 4 = partial digestion. */
export type IntervalRow = [number, number, number, number | null, number | null, number];

export async function loadIntervals(body: { holes?: unknown; element?: unknown; secondary?: unknown }): Promise<{ intervals: IntervalRow[]; credits: string[]; sources: string[] } | { error: string }> {
  const ids = Array.isArray(body.holes) ? [...new Set((body.holes as unknown[]).map(Number).filter((n) => Number.isInteger(n) && n > 0))] : [];
  if (!ids.length) return { error: "Choose at least one hole." };
  if (ids.length > 300) return { error: "Choose at most 300 holes at a time." };
  const el = resolveElement(body.element);
  if (!el) return { error: "Unknown element." };
  const g1 = await gradeSql(el, ELEMENTS[el], "w");
  if (!g1) return { error: `No ${ELEMENTS[el].name} assays are held for drill samples.` };
  let g2: Awaited<ReturnType<typeof gradeSql>> = null;
  if (body.secondary) {
    const e2 = resolveElement(body.secondary);
    if (!e2) return { error: "Unknown second element." };
    g2 = await gradeSql(e2, ELEMENTS[e2], "w");
    if (!g2) return { error: `No ${ELEMENTS[e2].name} assays are held for drill samples.` };
  }
  const res = await runReadOnlyQuery(
    `SELECT w.drillhole_id AS h, w.source_system AS s, w.depth_from_m::float AS f, w.depth_to_m::float AS t, ${g1.value} AS g, ${g1.bdl} AS b, ${g1.basis} AS basis
       ${g2 ? `, ${g2.value} AS g2, ${g2.bdl} AS b2` : ""}
     FROM geochem.sample_chemistry_wide w
     WHERE w.drillhole_id IN (${ids.join(", ")}) AND w.source_system IN (${DRILL_SOURCES.map(q).join(", ")}) AND w.depth_from_m IS NOT NULL
     ORDER BY w.drillhole_id, w.depth_from_m, w.depth_to_m`,
    150000,
  );
  const sources = [...new Set(res.rows.map((x) => String(x.s)))];
  return {
    sources: sources.map((s) => SOURCE_LABEL[s] ?? s),
    credits: [...new Set(sources.flatMap((s) => creditsForSource(s)))],
    intervals: res.rows.map((x) => [
      Number(x.h), Number(x.f), x.t == null ? NaN : Number(x.t), x.g == null ? null : Number(x.g), x.g2 == null ? null : Number(x.g2),
      (x.b ? 1 : 0) | (x.b2 ? 2 : 0) | (x.basis === "partial" ? 4 : 0),
    ]),
  };
}

// Latest monthly metal prices for the Drill intercepts page's metal equivalent ('use latest prices'). Only series quoted per unit of METAL are used
// (World Bank Pink Sheet monthly averages, IMF where the Pink Sheet has none); uranium is quoted per pound of U3O8 and is converted to uranium metal.
// Elements with only annual USGS compound prices (lithium carbonate, WO3, V2O5, rare earth oxides ...) are not offered.
const PRICE_SERIES: Record<string, { series: number; unit: "$/oz" | "$/t" | "$/lb"; perMetal: number; note?: string }> = {
  Au: { series: 49, unit: "$/oz", perMetal: 1 },
  Ag: { series: 51, unit: "$/oz", perMetal: 1 },
  Pt: { series: 50, unit: "$/oz", perMetal: 1 },
  Pd: { series: 54, unit: "$/oz", perMetal: 1 },
  Cu: { series: 44, unit: "$/t", perMetal: 1 },
  Ni: { series: 47, unit: "$/t", perMetal: 1 },
  Zn: { series: 48, unit: "$/t", perMetal: 1 },
  Pb: { series: 45, unit: "$/t", perMetal: 1 },
  Sn: { series: 46, unit: "$/t", perMetal: 1 },
  Co: { series: 53, unit: "$/t", perMetal: 1 },
  U: { series: 52, unit: "$/lb", perMetal: 1 / 0.848, note: "converted from US$ per lb U3O8 to per lb of uranium" },
};
export const PRICED_ELEMENTS = Object.keys(PRICE_SERIES);

export type LatestPrice = { element: string; price: number; unit: string; period: string; series: string; source: string; note?: string };

export async function latestPrices(elements: string[]): Promise<Record<string, LatestPrice | null>> {
  const want = [...new Set(elements.map((e) => resolveElement(e)).filter((e): e is string => !!e))];
  const ids = want.map((e) => PRICE_SERIES[e]?.series).filter((x): x is number => !!x);
  const out: Record<string, LatestPrice | null> = Object.fromEntries(want.map((e) => [e, null]));
  if (!ids.length) return out;
  const res = await runReadOnlyQuery(
    `SELECT DISTINCT ON (p.series_id) p.series_id, p.value::float AS value, to_char(p.period_start, 'Mon YYYY') AS period, s.series_name, s.source
     FROM markets.prices p JOIN markets.price_series s USING (series_id)
     WHERE p.series_id IN (${ids.join(", ")}) AND p.value IS NOT NULL ORDER BY p.series_id, p.period_start DESC`,
    50,
  );
  const bySeries = new Map(res.rows.map((r) => [Number(r.series_id), r]));
  for (const e of want) {
    const d = PRICE_SERIES[e];
    const r = d ? bySeries.get(d.series) : undefined;
    if (!d || !r) continue;
    out[e] = {
      element: e, price: Math.round(Number(r.value) * d.perMetal * 100) / 100, unit: d.unit, period: String(r.period),
      series: String(r.series_name), source: String(r.source) === "WORLD_BANK_PINK_SHEET" ? "World Bank Pink Sheet (monthly average)" : "IMF Primary Commodity Prices (monthly average)",
      ...(d.note ? { note: d.note } : {}),
    };
  }
  return out;
}
