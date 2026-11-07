import { runReadOnlyQuery } from "@/lib/db";
import { creditsForSource } from "@/lib/licence";
import type { Dataset, Evidence, MapData, MapPoint } from "@/lib/types";
import { ELEMENTS, PRICE_UNITS, buildSegments, compositeHole, fromPpm, gxlLabel, r, resolveElement, toPpm, unitLabel, type Comp, type ElDef } from "@/lib/composite";

// Drill intercepts: find and rank them.
//  - REPORTED: the mineralised intercepts the source itself reported (drilling.intercepts; Québec SIGÉOM only so far), converted to one reporting form per element
//    (e.g. lithium always as % Li2O, gold as g/t) so they can be ranked together, then ranked by grade x length (or grade, or length).
//  - COMPOSITE: significant intercepts calculated from the analysed downhole sample intervals (Tasmania MRT, Athabasca OF 7792), with the method of the
//    Grade-Width Intercepts (OGWI) Shiny app: intervals at or above a cut-off grade are joined across low-grade or unsampled core as long as each run of
//    internal dilution is no longer than a set length and the whole composite stays at or above the cut-off; composites shorter than a minimum width are dropped.
//    Grades are length-weighted. Below-detection and unsampled core count as zero grade (conservative). Optional metal equivalent from prices and recoveries.
// Physically impossible grades (over 100 %) are left out and counted; exceptionally high grades are kept but flagged for checking against the source.

type Out = { content: string; evidence?: Evidence[]; datasets?: Dataset[]; maps?: MapData[] };


export const INTERCEPT_SOURCES = { reported: ["CANADA_QC_SIGEOM"], composite: ["AUSTRALIA_TAS_MRT", "CANADA_ATHABASCA_OF7792"] };
export const SOURCE_LABEL: Record<string, string> = {
  CANADA_QC_SIGEOM: "SIGÉOM (Québec Ministère des Ressources naturelles et des Forêts)",
  AUSTRALIA_TAS_MRT: "Mineral Resources Tasmania",
  CANADA_ATHABASCA_OF7792: "Geological Survey of Canada Open File 7792 (Athabasca)",
};


const num = (v: unknown): number | undefined => {
  const n = typeof v === "string" && v.trim() === "" ? NaN : Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const q = (s: string) => "'" + s.replace(/'/g, "''") + "'";

type Area = { where: string[]; distSql: string | null; note: string[]; occ?: { id: number; name: string; radiusKm: number } };

async function buildArea(input: Record<string, unknown>): Promise<Area | string> {
  const where: string[] = ["h.is_active"];
  const note: string[] = [];
  let distSql: string | null = null;
  let occ: Area["occ"];
  const bbox = Array.isArray(input.bbox) ? (input.bbox as unknown[]).map(Number) : null;
  if (bbox && bbox.length === 4 && bbox.every(Number.isFinite)) {
    const [w, s, e, n] = bbox;
    where.push(`h.lon BETWEEN ${Math.min(w, e)} AND ${Math.max(w, e)} AND h.lat BETWEEN ${Math.min(s, n)} AND ${Math.max(s, n)}`);
    note.push(`box ${w}, ${s} to ${e}, ${n}`);
  }
  const near = (input.near ?? null) as { lat?: unknown; lon?: unknown; radius_km?: unknown } | null;
  const lat = num(near?.lat), lon = num(near?.lon);
  if (lat !== undefined && lon !== undefined) {
    const rad = Math.min(Math.max(num(near?.radius_km) ?? 10, 0.1), 100);
    const pt = `ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)::geography`;
    where.push(`ST_DWithin(h.geog, ${pt}, ${rad * 1000})`);
    distSql = `ST_Distance(h.geog, ${pt}) / 1000.0`;
    note.push(`within ${rad} km of ${lat}, ${lon}`);
  }
  const occId = num(input.occurrence_id);
  if (occId !== undefined) {
    const rad = Math.min(Math.max(num(input.radius_km) ?? 1, 0), 20);
    const o = await runReadOnlyQuery(`SELECT occurrence_id, name, lat, lon FROM core.occurrences WHERE occurrence_id = ${Math.trunc(occId)}`, 1);
    if (!o.rows.length) return `No occurrence with id ${occId}.`;
    const row = o.rows[0];
    occ = { id: Number(row.occurrence_id), name: String(row.name ?? ""), radiusKm: rad };
    const og = `(SELECT geog FROM core.occurrences WHERE occurrence_id = ${occ.id})`;
    where.push(rad > 0 ? `(h.occurrence_id = ${occ.id} OR ST_DWithin(h.geog, ${og}, ${rad * 1000}))` : `h.occurrence_id = ${occ.id}`);
    distSql = `ST_Distance(h.geog, ${og}) / 1000.0`;
    note.push(`holes linked to ${occ.name || "occurrence " + occ.id}${rad > 0 ? ` or within ${rad} km of it` : ""}`);
  }
  const text = (k: string, col: string) => {
    const v = String(input[k] ?? "").trim();
    if (v) {
      where.push(`${col} ILIKE ${q("%" + v.replace(/[%_\\]/g, "") + "%")}`);
      note.push(`${k.replace("_", " ")} like '${v}'`);
    }
  };
  text("hole_name", "h.hole_name");
  text("prospect", "coalesce(h.prospect, '') || ' ' || coalesce(o.name, '')");
  text("company", "h.company");
  return { where, distSql, note, occ };
}

type ReportedRow = Record<string, unknown>;

async function reported(input: Record<string, unknown>, el: string, d: ElDef, area: Area): Promise<Out> {
  // Local intercept codes for this element and the factor from that code's mass to element mass.
  const locals: Record<string, number> = { [el]: 1, ...(d.extraLocals ?? {}) };
  for (const o of d.oxides) {
    const name = o.code.replace(/^(.)(.*)$/, (_, a: string, b: string) => a.toUpperCase() + b.replace(/o/g, "O"));
    locals[name] = o.elFrac;
  }
  const codeList = Object.keys(locals);
  const factorCase = `CASE i.analyte_local ${codeList.map((c) => `WHEN ${q(c)} THEN ${locals[c]}`).join(" ")} END`;
  const ppmExpr = `(CASE i.unit_code WHEN 'ppb' THEN i.grade / 1000.0 WHEN 'ppm' THEN i.grade WHEN '%' THEN i.grade * 10000.0 END) * ${factorCase}`;
  const repExpr = `(${ppmExpr}) * ${d.toReport} / ${d.unit === "%" ? 10000 : 1}`;
  const rankBy = String(input.rank_by ?? "grade_x_length");
  const order = rankBy === "grade" ? "grade_rep DESC" : rankBy === "length" ? "i.length_m DESC NULLS LAST, grade_rep DESC" : "gxl DESC";
  const minGrade = num(input.min_grade);
  const minLen = num(input.min_length_m);
  const minGxl = num(input.min_grade_x_length);
  const perHole = input.best_per_hole !== false;
  const limit = Math.min(Math.max(Math.trunc(num(input.limit) ?? 25), 1), 200);
  const impossible = `((${ppmExpr}) * ${Math.max(d.toReport, 1)} > 1000000 OR (h.total_depth_m > 0 AND i.length_m > h.total_depth_m + 0.5))`; // over 100 %, or longer than the hole
  const exceptional = `(${repExpr}) > ${d.exceptional}`;
  const withFlagged = input.include_exceptional === true;
  const base = `FROM drilling.intercepts i JOIN drilling.drillholes h USING (drillhole_id) LEFT JOIN core.occurrences o ON o.occurrence_id = h.occurrence_id
    WHERE i.is_active AND i.grade IS NOT NULL AND i.unit_code IN ('ppb', 'ppm', '%') AND i.analyte_local IN (${codeList.map(q).join(", ")}) AND ${area.where.join(" AND ")}`;
  const filt = [`NOT ${impossible}`, withFlagged ? "" : `NOT ${exceptional}`, minGrade !== undefined ? `${repExpr} >= ${minGrade}` : "", minLen !== undefined ? `i.length_m >= ${minLen}` : "", minGxl !== undefined ? `${repExpr} * coalesce(i.length_m, 0) >= ${minGxl}` : ""].filter(Boolean);
  const sel = `SELECT i.intercept_id, h.drillhole_id, h.hole_name, h.source_hole_id, h.company, h.prospect, o.name AS occurrence, h.occurrence_id, h.lat, h.lon,
      extract(year FROM h.date_drilled)::int AS year_drilled, i.analyte_local, i.grade AS grade_source, i.unit_code AS unit_source, ${repExpr} AS grade_rep, i.length_m,
      ${repExpr} * coalesce(i.length_m, 0) AS gxl, i.depth_from_m, i.depth_to_m, i.position_basis, i.mineral_local,
      (i.depth_to_m > i.depth_from_m AND i.length_m > i.depth_to_m - i.depth_from_m + 0.5) AS longer_than_unit
      ${area.distSql ? `, ${area.distSql} AS dist_km` : ""} ${base} AND ${filt.join(" AND ")}`;
  const ranked = perHole
    ? `SELECT * FROM (SELECT DISTINCT ON (drillhole_id) * FROM (${sel}) x ORDER BY drillhole_id, ${order.replace(/i\./g, "")}) y ORDER BY ${order.replace(/i\./g, "")}`
    : `${sel} ORDER BY ${order}`;
  const flaggedSql = `SELECT h.hole_name, ${repExpr} AS grade_rep, i.length_m, i.grade AS grade_source, i.unit_code AS unit_source, i.analyte_local ${base} AND NOT ${impossible} AND ${exceptional}
    ${minLen !== undefined ? `AND i.length_m >= ${minLen}` : ""} ORDER BY ${repExpr} * coalesce(i.length_m, 0) DESC`;
  const [rows, stats, flagged] = await Promise.all([
    runReadOnlyQuery(ranked, limit),
    runReadOnlyQuery(
      `SELECT count(*) FILTER (WHERE ${filt.join(" AND ")}) AS n, count(DISTINCT h.drillhole_id) FILTER (WHERE ${filt.join(" AND ")}) AS holes,
         count(*) FILTER (WHERE ${impossible}) AS impossible, count(*) FILTER (WHERE NOT ${impossible} AND ${exceptional}) AS exceptional, count(*) AS all_rows,
         count(*) FILTER (WHERE i.analyte_local <> ${q(el)}) AS from_other_forms ${base}`,
      1,
    ),
    withFlagged ? Promise.resolve({ rows: [] as Record<string, unknown>[] }) : runReadOnlyQuery(flaggedSql, 5),
  ]);
  const st = stats.rows[0] ?? {};
  const out = rows.rows as ReportedRow[];
  const u = unitLabel(d);
  const flagOf = (x: ReportedRow) =>
    [Number(x.grade_rep) > d.exceptional ? "exceptional grade - check the source" : "", x.longer_than_unit ? "length longer than the log unit holding it" : ""].filter(Boolean).join("; ");
  const depthText = (x: ReportedRow) =>
    x.depth_from_m != null && x.depth_to_m != null ? `${x.position_basis === "LITHOLOGY_UNIT" ? "within log unit " : ""}${r(Number(x.depth_from_m), 1)}-${r(Number(x.depth_to_m), 1)} m` : "";
  const dataset: Dataset = {
    id: "intercepts-" + Date.now().toString(36),
    title: `Reported ${d.name} intercepts${area.note.length ? " (" + area.note.join("; ") + ")" : ""}, ranked by ${rankBy.replace(/_/g, " ")}`,
    columns: ["Rank", "Hole", "Company", "Prospect / deposit", `Grade (${u})`, "Length (m)", gxlLabel(d), "Depth", "As reported", "Year drilled", ...(area.distSql ? ["Distance (km)"] : []), "Latitude", "Longitude", "Check"],
    rows: out.map((x, k) => [
      k + 1,
      String(x.hole_name ?? x.source_hole_id ?? ""),
      (x.company as string) ?? null,
      [x.occurrence, x.prospect].filter(Boolean).join(" / ") || null,
      r(Number(x.grade_rep)),
      x.length_m == null ? null : r(Number(x.length_m)),
      r(Number(x.gxl)),
      depthText(x),
      `${x.grade_source} ${x.unit_source} ${x.analyte_local}`,
      (x.year_drilled as number) ?? null,
      ...(area.distSql ? [r(Number(x.dist_km))] : []),
      r(Number(x.lat), 5),
      r(Number(x.lon), 5),
      flagOf(x),
    ]),
  };
  const maps = mapOf(out.map((x, k) => ({ lat: Number(x.lat), lon: Number(x.lon), hole: String(x.hole_name ?? ""), rank: k + 1, gxl: Number(x.gxl), text: `${r(Number(x.grade_rep))} ${u} over ${x.length_m ?? "?"} m` })), `Best reported ${d.name} intercepts`);
  const credits = creditsForSource("CANADA_QC_SIGEOM");
  const content = JSON.stringify({
    what: `Mineralised ${d.name} intercepts as REPORTED by the source (not recalculated), ${perHole ? "the best one per hole" : "every intercept"}, ranked by ${rankBy.replace(/_/g, " ")}`,
    source: SOURCE_LABEL.CANADA_QC_SIGEOM,
    reporting_unit: u,
    filters: { area: area.note.length ? area.note : ["all of Québec"], min_grade: minGrade ?? null, min_length_m: minLen ?? null, min_grade_x_length: minGxl ?? null },
    intercepts_matching: Number(st.n ?? 0),
    holes_matching: Number(st.holes ?? 0),
    left_out_physically_impossible: Number(st.impossible ?? 0),
    left_out_for_checking:
      !withFlagged && Number(st.exceptional ?? 0)
        ? `${st.exceptional} intercept(s) above ${d.exceptional} ${u} were LEFT OUT of the ranking (usually unit or typing errors in the source, occasionally real bonanza grades). The answer MUST say this and give the top examples: ${flagged.rows.map((x) => `${x.hole_name}: ${r(Number(x.grade_rep))} ${u} over ${x.length_m} m (reported ${x.grade_source} ${x.unit_source} ${x.analyte_local})`).join("; ")}`
        : "none",
    top: out.slice(0, 15).map((x, k) => ({
      rank: k + 1,
      hole: x.hole_name,
      company: x.company ?? null,
      prospect_or_deposit: [x.occurrence, x.prospect].filter(Boolean).join(" / ") || null,
      grade: r(Number(x.grade_rep)),
      length_m: x.length_m == null ? null : r(Number(x.length_m)),
      grade_x_length: r(Number(x.gxl)),
      depth: depthText(x) || null,
      as_reported: `${x.grade_source} ${x.unit_source} ${x.analyte_local}`,
      year_drilled: x.year_drilled ?? null,
      ...(area.distSql ? { distance_km: r(Number(x.dist_km)) } : {}),
      check: flagOf(x) || undefined,
    })),
    how_to_read: [
      `Grades are converted to ${u} so that intercepts reported as the element and as the oxide (or in ppb / ppm / %) can be compared; 'as reported' shows the source's own figure. ${Number(st.from_other_forms ?? 0) ? `${st.from_other_forms} of the matching rows were reported in another form and converted.` : ""}`,
      "Depths: SIGÉOM gives the log unit that holds the intercept, not the intercept's own from-to depths, so say 'within the log unit from X to Y m' and never present them as the intercept's depths.",
      `Grade x length is in ${gxlLabel(d)} (call it gram-metres only for g/t grades); it rewards both grade and width; say which ranking you used. A high grade over a very short length can be a single vein or a nugget.`,
      `Left out of the ranking: grades over 100 % or intercepts longer than the hole (source errors), and by default grades above ${d.exceptional} ${u}, which are usually unit or typing errors in the source (e.g. 50,000 g/t gold) but can occasionally be real bonanza grades. Say how many were left out; the examples are listed; set include_exceptional to rank them too. 'length longer than the log unit holding it' marks intercepts that may summarise several units or contain a typing error: mention it when quoting such a row.`,
      "These are intercepts reported in government assessment records over decades, not resource estimates and not NI 43-101 disclosure; do not imply economic grades or continuity.",
      "Only Québec (SIGÉOM) holds reported intercepts. For Tasmania or Athabasca drill holes use mode 'composite' (calculated from the downhole assays).",
      maps.length ? "A map of the ranked holes is shown to the user automatically; the full table is downloadable." : "",
    ].filter(Boolean),
    credit: credits,
  });
  return { content, evidence: [{ kind: "data", label: `Drill intercepts: ${credits.join("; ")}` }], datasets: [dataset], maps };
}

function mapOf(pts: { lat: number; lon: number; hole: string; rank: number; gxl: number; text: string }[], title: string): MapData[] {
  const ok = pts.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  if (ok.length < 2) return [];
  const max = Math.max(...ok.map((p) => p.gxl), 1e-9);
  const points: MapPoint[] = ok.map((p) => ({
    lat: p.lat,
    lon: p.lon,
    label: `#${p.rank} ${p.hole}`,
    group: p.rank <= 10 ? "Top 10" : "Others ranked",
    detail: p.text,
    size: 0.4 + 0.6 * Math.sqrt(Math.max(p.gxl, 0) / max),
  }));
  return [{ id: "map-int-" + Date.now() + "-" + Math.floor(Math.random() * 1e4), title, note: "Markers are drill collars (no downhole positions yet); size scales with grade x length.", points }];
}

// ---------- composite mode ----------


let wideCols: Set<string> | null = null;
async function wideColumns(): Promise<Set<string>> {
  if (wideCols) return wideCols;
  const res = await runReadOnlyQuery(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'geochem' AND table_name = 'sample_chemistry_wide'`, 1000);
  wideCols = new Set(res.rows.map((x) => String(x.column_name)));
  return wideCols;
}

/** SQL giving the element's grade in ppm (total digestion first, then partial), its basis, and whether it was assayed but below detection. */
export async function gradeSql(el: string, d: ElDef, alias: string) {
  const cols = await wideColumns();
  const parts: { sql: string; basis: string }[] = [];
  const bdl: string[] = [];
  for (const basis of ["t", "p"]) {
    const ec = `${el.toLowerCase()}_${basis}`;
    if (cols.has(ec)) {
      parts.push({ sql: `${alias}.${ec}`, basis: basis === "t" ? "total" : "partial" });
      bdl.push(ec);
    }
    for (const o of d.oxides) {
      const oc = `${o.code}_${basis}`;
      if (cols.has(oc)) {
        parts.push({ sql: `${alias}.${oc} * 10000.0 * ${o.elFrac}`, basis: basis === "t" ? "total" : "partial" });
        bdl.push(oc);
      }
    }
  }
  if (el === "C" && cols.has("c_noncarb_pct")) parts.unshift({ sql: `${alias}.c_noncarb_pct * 10000.0`, basis: "total" });
  if (!parts.length) return null;
  return {
    value: `coalesce(${parts.map((p) => p.sql).join(", ")})`,
    basis: `CASE ${parts.map((p) => `WHEN ${p.sql} IS NOT NULL THEN '${p.basis}'`).join(" ")} END`,
    bdl: bdl.length ? `coalesce(${alias}.bdl_codes && ARRAY[${bdl.map(q).join(", ")}]::text[], false)` : "false",
  };
}

async function composite(input: Record<string, unknown>, el: string, d: ElDef, area: Area): Promise<Out> {
  const src = String(input.source_system ?? "");
  const sources = INTERCEPT_SOURCES.composite.includes(src) ? [src] : INTERCEPT_SOURCES.composite;
  const cutoff = num(input.cutoff) ?? num(input.min_grade) ?? d.cutoff;
  if (cutoff === undefined || cutoff <= 0) return { content: `Give a cut-off grade in ${unitLabel(d)} for ${d.name}: there is no default for it.` };
  const minWidth = Math.max(num(input.min_width_m) ?? 1, 0);
  const maxDil = Math.max(num(input.max_internal_dilution_m) ?? 3, 0);
  const incl = num(input.including_cutoff);
  const limit = Math.min(Math.max(Math.trunc(num(input.limit) ?? 25), 1), 200);
  const perHole = input.best_per_hole !== false;
  const rankBy = String(input.rank_by ?? "grade_x_length");

  const g1 = await gradeSql(el, d, "w");
  if (!g1) return { content: `No ${d.name} assays are held for drill samples.` };

  // Optional metal equivalent.
  const eqIn = (input.equivalent ?? null) as Record<string, unknown> | null;
  let eq: { el: string; d: ElDef; ratio: number; text: string } | null = null;
  let g2: Awaited<ReturnType<typeof gradeSql>> = null;
  if (eqIn && eqIn.element) {
    const e2 = resolveElement(eqIn.element);
    if (!e2) return { content: `Unknown secondary element '${eqIn.element}'.` };
    const p1 = num(eqIn.price_primary), p2 = num(eqIn.price_secondary);
    const u1 = PRICE_UNITS[String(eqIn.price_unit_primary ?? (d.unit === "g/t" ? "$/oz" : "$/lb"))];
    const u2 = PRICE_UNITS[String(eqIn.price_unit_secondary ?? (ELEMENTS[e2].unit === "g/t" ? "$/oz" : "$/lb"))];
    if (!p1 || !p2 || !u1 || !u2) return { content: "A metal equivalent needs both prices (price_primary, price_secondary) and their units ($/oz, $/lb, $/t, $/kg or $/g)." };
    const rec1 = Math.min(Math.max(num(eqIn.recovery_primary) ?? 100, 1), 100) / 100;
    const rec2 = Math.min(Math.max(num(eqIn.recovery_secondary) ?? 100, 0), 100) / 100;
    // value per gram of element, times recovery; ratio converts secondary element ppm into primary element ppm of equal recovered value
    const ratio = ((p2 / u2) * rec2) / ((p1 / u1) * rec1);
    g2 = await gradeSql(e2, ELEMENTS[e2], "w");
    if (!g2) return { content: `No ${ELEMENTS[e2].name} assays are held for drill samples.` };
    eq = { el: e2, d: ELEMENTS[e2], ratio, text: `${d.reportAs} equivalent = ${d.reportAs} + ${ELEMENTS[e2].reportAs} converted at ${p2} ${eqIn.price_unit_secondary ?? (ELEMENTS[e2].unit === "g/t" ? "$/oz" : "$/lb")} (${Math.round(rec2 * 100)}% recovery) against ${p1} ${eqIn.price_unit_primary ?? (d.unit === "g/t" ? "$/oz" : "$/lb")} (${Math.round(rec1 * 100)}% recovery)` };
  }
  const cutPpm = toPpm(d, cutoff);
  const eqSql = g2 ? `coalesce(${g1.value}, 0) + coalesce(${g2.value}, 0) * ${eq!.ratio}` : g1.value;
  const holeLimit = 1000;
  const reaching = `SELECT h.drillhole_id FROM drilling.drillholes h LEFT JOIN core.occurrences o ON o.occurrence_id = h.occurrence_id
     JOIN geochem.sample_chemistry_wide w ON w.drillhole_id = h.drillhole_id
     WHERE ${area.where.join(" AND ")} AND w.source_system IN (${sources.map(q).join(", ")}) AND w.depth_to_m > w.depth_from_m
     GROUP BY h.drillhole_id HAVING max(${eqSql}) >= ${cutPpm}`;
  const holes = `${reaching} ORDER BY max(${eqSql}) DESC LIMIT ${holeLimit}`;
  const [samples, holeInfo, cand, reach] = await Promise.all([
    runReadOnlyQuery(
      `SELECT w.drillhole_id, w.source_system AS ssrc, w.sample_id, w.depth_from_m::float AS f, w.depth_to_m::float AS t, ${g1.value} AS g, ${g1.basis} AS basis, ${g1.bdl} AS bdl
         ${g2 ? `, ${g2.value} AS g2, ${g2.bdl} AS bdl2` : ""}
       FROM geochem.sample_chemistry_wide w WHERE w.drillhole_id IN (${holes}) AND w.source_system IN (${sources.map(q).join(", ")})`,
      200000,
    ),
    runReadOnlyQuery(
      `SELECT h.drillhole_id, h.hole_name, h.source_hole_id, h.source_system, h.company, h.prospect, o.name AS occurrence, h.lat, h.lon, h.total_depth_m,
         extract(year FROM h.date_drilled)::int AS year_drilled ${area.distSql ? `, ${area.distSql} AS dist_km` : ""}
       FROM drilling.drillholes h LEFT JOIN core.occurrences o ON o.occurrence_id = h.occurrence_id WHERE h.drillhole_id IN (${holes})`,
      holeLimit,
    ),
    runReadOnlyQuery(
      `SELECT count(DISTINCT h.drillhole_id) AS n FROM drilling.drillholes h LEFT JOIN core.occurrences o ON o.occurrence_id = h.occurrence_id
       JOIN geochem.sample_chemistry_wide w ON w.drillhole_id = h.drillhole_id WHERE ${area.where.join(" AND ")} AND w.source_system IN (${sources.map(q).join(", ")})
       AND w.depth_to_m > w.depth_from_m AND (${g1.value} IS NOT NULL OR ${g1.bdl})`,
      1,
    ),
    runReadOnlyQuery(`SELECT count(*) AS n FROM (${reaching}) x`, 1),
  ]);
  const info = new Map(holeInfo.rows.map((h) => [Number(h.drillhole_id), h]));
  const byHole = new Map<number, Record<string, unknown>[]>();
  for (const s of samples.rows) {
    const k = Number(s.drillhole_id);
    if (!byHole.has(k)) byHole.set(k, []);
    byHole.get(k)!.push(s);
  }
  let overlapsDropped = 0, impossible = 0;
  const sampleSources = new Map<number, string>();
  for (const s of samples.rows) sampleSources.set(Number(s.drillhole_id), String(s.ssrc));
  const basisCount: Record<string, number> = {};
  type Hit = Comp & { hole: number; including: string | null; flag: string };
  const hits: Hit[] = [];
  const excluded: string[] = [];
  for (const [hole, rows] of byHole) {
    for (const s of rows) if (s.basis) basisCount[String(s.basis)] = (basisCount[String(s.basis)] ?? 0) + 1;
    const built = buildSegments(
      rows.map((s) => ({ from: Number(s.f), to: Number(s.t), g: s.g == null ? null : Number(s.g), g2: s.g2 == null ? null : Number(s.g2), bdl: Boolean(s.bdl), bdl2: Boolean(s.bdl2) })),
      1e6 / Math.max(d.toReport, 1),
    );
    overlapsDropped += built.overlaps;
    impossible += built.impossible;
    for (const c of compositeHole(built.segs, { cutPpm, minWidth, maxDil, inclPpm: incl !== undefined ? toPpm(d, incl) : undefined, ratio: eq?.ratio })) {
      const including = c.incl ? `${r(c.incl.len, 1)} m at ${r(fromPpm(d, c.incl.eq))} ${unitLabel(d)}${eq ? " eq." : ""} from ${r(c.incl.from, 1)} m` : null;
      const exc = fromPpm(d, c.maxSample) > d.exceptional || (eq ? fromPpm(eq.d, c.maxSample2) > eq.d.exceptional : false);
      if (exc && input.include_exceptional !== true) {
        excluded.push(`${info.get(hole)?.hole_name ?? hole}: ${r(c.len, 1)} m at ${r(fromPpm(d, c.eq))} ${unitLabel(d)} from ${r(c.from, 1)} m (highest sample ${r(fromPpm(d, c.maxSample))} ${unitLabel(d)}${eq ? `, ${r(fromPpm(eq.d, c.maxSample2))} ${unitLabel(eq.d)}` : ""})`);
        continue;
      }
      hits.push({ ...c, hole, including, flag: exc ? "exceptional sample grade inside - check the source" : "" });
    }
  }
  const metric = (h: Hit) => (rankBy === "grade" ? h.eq : rankBy === "length" ? h.len : h.eq * h.len);
  let ranked = hits.sort((a, b) => metric(b) - metric(a));
  const holesWithHits = new Set(ranked.map((h) => h.hole)).size;
  if (perHole) {
    const seen = new Set<number>();
    ranked = ranked.filter((h) => (seen.has(h.hole) ? false : (seen.add(h.hole), true)));
  }
  const top = ranked.slice(0, limit);
  const u = unitLabel(d);
  const name = (h: Hit) => {
    const x = info.get(h.hole);
    return String(x?.hole_name ?? x?.source_hole_id ?? h.hole);
  };
  const srcUsed = [...new Set(top.map((h) => sampleSources.get(h.hole) ?? ""))].filter(Boolean);
  const dataset: Dataset = {
    id: "composites-" + Date.now().toString(36),
    title: `Calculated ${d.name} intercepts at ${cutoff} ${u}${eq ? " equivalent" : ""} cut-off, min ${minWidth} m, max ${maxDil} m internal dilution${area.note.length ? " (" + area.note.join("; ") + ")" : ""}`,
    columns: [
      "Rank", "Hole", "Source", "Company", "Prospect / deposit", "From (m)", "To (m)", "Length (m)", `Grade (${u})`,
      ...(eq ? [`${eq.d.reportAs} (${unitLabel(eq.d)})`, `${d.reportAs} equivalent (${u})`] : []),
      gxlLabel(d) + (eq ? " (equivalent)" : ""), "Including", "Samples", "Low-grade core inside, total (m)", "Unassayed core inside (m)", "Highest sample", "Year drilled",
      ...(area.distSql ? ["Distance (km)"] : []), "Latitude", "Longitude", "Check",
    ],
    rows: top.map((h, k) => {
      const x = info.get(h.hole) ?? {};
      return [
        k + 1, name(h), SOURCE_LABEL[sampleSources.get(h.hole) ?? ""] ?? sampleSources.get(h.hole) ?? "", (x.company as string) ?? null,
        [x.occurrence, x.prospect].filter(Boolean).join(" / ") || null, r(h.from, 1), r(h.to, 1), r(h.len, 1), r(fromPpm(d, h.grade)),
        ...(eq ? [r(fromPpm(eq.d, h.grade2)), r(fromPpm(d, h.eq))] : []),
        r(fromPpm(d, h.eq) * h.len), h.including, h.nSamples, r(h.dilutionM, 1), r(h.unassayedM, 1), r(fromPpm(d, h.maxSample)), (x.year_drilled as number) ?? null,
        ...(area.distSql ? [r(Number(x.dist_km))] : []), r(Number(x.lat), 5), r(Number(x.lon), 5), h.flag,
      ];
    }),
  };
  const maps = mapOf(
    top.map((h, k) => ({ lat: Number(info.get(h.hole)?.lat), lon: Number(info.get(h.hole)?.lon), hole: name(h), rank: k + 1, gxl: h.eq * h.len, text: `${r(h.len, 1)} m at ${r(fromPpm(d, h.eq))} ${u}${eq ? " eq." : ""} from ${r(h.from, 1)} m` })),
    `Best calculated ${d.name} intercepts`,
  );
  const credits = [...new Set((srcUsed.length ? srcUsed : sources).flatMap((s) => creditsForSource(s)))];
  const content = JSON.stringify({
    what: `${d.name[0].toUpperCase() + d.name.slice(1)} intercepts CALCULATED from the downhole sample assays (length-weighted composites, the Grade-Width Intercepts method), ${perHole ? "the best one per hole" : "every composite"}, ranked by ${rankBy.replace(/_/g, " ")}`,
    sources: (srcUsed.length ? srcUsed : sources).map((s) => SOURCE_LABEL[s] ?? s),
    parameters: { cutoff: `${cutoff} ${u}${eq ? " equivalent" : ""}`, min_width_m: minWidth, max_internal_dilution_m: maxDil, including_cutoff: incl ?? null, equivalent: eq?.text ?? null },
    area: area.note.length ? area.note : ["all holes with assays in these sources"],
    holes_with_assays_in_area: Number(cand.rows[0]?.n ?? 0),
    holes_with_an_assay_at_or_above_cutoff: Number(reach.rows[0]?.n ?? 0),
    holes_composited: byHole.size,
    holes_note: Number(reach.rows[0]?.n ?? 0) > byHole.size ? `Only the ${byHole.size} holes with the highest single assays were composited (of ${reach.rows[0]?.n} reaching the cut-off); narrow the area to see all.` : "Every hole reaching the cut-off was composited.",
    holes_with_an_intercept: holesWithHits,
    intercepts_found: hits.length,
    overlapping_sample_intervals_skipped: overlapsDropped,
    impossible_sample_grades_set_to_zero: impossible,
    left_out_for_checking: excluded.length
      ? `${excluded.length} intercept(s) were LEFT OUT of the ranking because they contain a single assay above ${d.exceptional} ${unitLabel(d)} (usually a source error, occasionally real). The answer MUST say this and name them: ${excluded.slice(0, 5).join("; ")}`
      : "none",
    digestion_basis_of_samples_used: basisCount,
    top: top.slice(0, 15).map((h, k) => {
      const x = info.get(h.hole) ?? {};
      return {
        rank: k + 1,
        hole: name(h),
        company: x.company ?? null,
        prospect_or_deposit: [x.occurrence, x.prospect].filter(Boolean).join(" / ") || null,
        from_m: r(h.from, 1),
        to_m: r(h.to, 1),
        length_m: r(h.len, 1),
        grade: r(fromPpm(d, h.grade)),
        ...(eq ? { [`${d.reportAs}_grade_${d.unit}`]: r(fromPpm(d, h.grade)), [`${eq.d.reportAs}_grade_${eq.d.unit}`]: r(fromPpm(eq.d, h.grade2)), [`${d.reportAs}_equivalent_${d.unit}`]: r(fromPpm(d, h.eq)) } : {}),
        grade_x_length: r(fromPpm(d, h.eq) * h.len),
        including: h.including ?? undefined,
        samples: h.nSamples,
        low_grade_core_inside_total_m: r(h.dilutionM, 1),
        unassayed_m: r(h.unassayedM, 1) || undefined,
        highest_sample: r(fromPpm(d, h.maxSample)),
        year_drilled: x.year_drilled ?? null,
        ...(area.distSql ? { distance_km: r(Number(x.dist_km)) } : {}),
        check: h.flag || undefined,
      };
    }),
    how_to_read: [
      `Quote intercepts the usual way, e.g. '12.0 m at 1.5 ${u} from 34.0 m (downhole)', and always give the cut-off, minimum width and maximum internal dilution used, since a different cut-off gives different intercepts.`,
      `The maximum internal dilution applies to EACH continuous run of low-grade or unsampled core; a composite can hold several such runs, so its total low-grade core can be larger than the maximum while the whole composite still averages at least the cut-off.`,
      `Grade x length is in ${gxlLabel(d)}; call it gram-metres only for g/t grades.`,
      ...(eq ? [`Metal equivalent: give each intercept's ${d.reportAs} and ${eq.d.reportAs} grades beside the ${d.reportAs}-equivalent grade, and state the prices and recoveries used (${eq.text}). An equivalent is a value comparison only; it ignores metallurgy, payability and costs.`] : []),
      "Downhole lengths, not true widths: the orientation of the mineralisation is not known.",
      "Below-detection results and unsampled core inside a composite count as zero grade (conservative); 'unassayed core inside' says how much of an intercept had no assay for this element. Overlapping sample intervals (re-assays, composites) were skipped so no metre is counted twice.",
      "Total-digestion values are used where present, otherwise partial (e.g. aqua regia) values, which can under-report resistant minerals; see digestion_basis_of_samples_used.",
      `A high 'highest sample' in a short intercept can mean one nugget or vein drives the grade. By default composites containing a single assay above ${d.exceptional} ${unitLabel(d)}${eq ? ` (or above ${eq.d.exceptional} ${unitLabel(eq.d)} for the second metal)` : ""} are left out of the ranking (usually source errors, occasionally real); say how many, and set include_exceptional to rank them.`,
      "These are calculated from government-compiled assays, not company-reported or resource figures; do not present them as either, or imply economic grades. They must not be used in public reporting without independent verification.",
      "Only Tasmania (MRT) and Athabasca (GSC Open File 7792) hold downhole assay intervals; Québec assays have no from-to depths, so for Québec use mode 'reported'.",
      "To try other cut-offs, widths, dilution or a metal equivalent and see each hole's strip log, the user can open the Drill intercepts page (the orange 'Drill intercepts' button at the top of the app); it uses the same calculation and also takes their own CSV. Mention it in one sentence at the end.",
      maps.length ? "A map of the ranked holes is shown to the user automatically; the full table is downloadable." : "",
    ].filter(Boolean),
    credit: credits,
  });
  return { content, evidence: [{ kind: "data", label: `Calculated drill intercepts: ${credits.join("; ")}` }], datasets: [dataset], maps };
}

export async function drillIntercepts(input: Record<string, unknown>): Promise<Out> {
  const el = resolveElement(input.element);
  if (!el) return { content: `Unknown or unsupported element '${String(input.element ?? "")}'. Supported: ${Object.keys(ELEMENTS).join(", ")}.` };
  const d = ELEMENTS[el];
  const src = String(input.source_system ?? "");
  let mode = String(input.mode ?? "");
  if (mode !== "reported" && mode !== "composite") mode = INTERCEPT_SOURCES.composite.includes(src) || input.cutoff !== undefined ? "composite" : "reported";
  const area = await buildArea(input);
  if (typeof area === "string") return { content: area };
  if (mode === "reported" && src && !INTERCEPT_SOURCES.reported.includes(src))
    return { content: `Reported intercepts are held only for Québec (SIGÉOM). For ${SOURCE_LABEL[src] ?? src} use mode 'composite' to calculate intercepts from the downhole assays.` };
  try {
    return mode === "composite" ? await composite(input, el, d, area) : await reported(input, el, d, area);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/timeout|canceling statement/i.test(msg)) return { content: "The search took too long. Narrow the area (a box, a point with a radius, or an occurrence) and try again." };
    throw e;
  }
}
