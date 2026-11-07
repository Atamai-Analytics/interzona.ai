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
