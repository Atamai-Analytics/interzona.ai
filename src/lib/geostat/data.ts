import { getPool } from "@/lib/db";
import { creditsFromText, GEUS_RAW_DATA_LOCKED } from "@/lib/licence";
import { getOptions, validColumns } from "@/lib/geochem-extract";
import { MAX_POINTS, MAX_SPAN_KM, spanKm } from "@/lib/geostat/limits";

export { MAX_POINTS, MAX_SPAN_KM, spanKm };

// Data for the Geostatistics page (/tools/geostatistics). A grid is only ever built from ONE series: one dataset, one sample type, one
// element, and within that one survey (where the dataset records surveys), one analytical method, one size fraction and one unit, so
// different labs, digestions or fractions are never mixed in one surface. Values come from the long results table
// (geochem.analytical_results), which keeps the method, fraction, qualifier and detection limit that the wide table merges away.
// Queries are built from fixed SQL and bound parameters only.

/** Sample types that can be interpolated in phase 1: soils, tills and lake sediments. Stream sediments represent their upstream catchment,
 *  not a point, and unspecified "sediment" may be stream sediment, so neither is offered (catchment maps are phase 2). */
const ALLOWED_CATEGORIES = ["SOIL", "TILL"];
const ALLOWED_EXTRA_TYPES = ["Lake Sediment"];

// Where a dataset records which survey a sample belongs to (in the sample comment written by its loader), the survey is part of the series.
const SURVEY_SQL = `CASE s.source_system
    WHEN 'CANADA_NRCAN_CDOGS' THEN substring(s.comments from 'CDoGS survey [0-9]+:[0-9]+')
    WHEN 'CANADA_QC_SIGEOM_SED' THEN substring(s.comments from 'project [0-9A-Za-z]+')
    WHEN 'USA_USGS_NGDB' THEN substring(s.comments from 'project [^;]+')
    WHEN 'USA_NURE_HSSR' THEN substring(s.comments from 'NURE quad [^;]+; methods [^;]+')
    ELSE NULL END`;
const SURVEY_DESC_SQL = `CASE s.source_system WHEN 'CANADA_NRCAN_CDOGS' THEN nullif(split_part(s.comments, '; ', 2), '') ELSE NULL END`;
export const SURVEY_DATASETS = new Set(["CANADA_NRCAN_CDOGS", "CANADA_QC_SIGEOM_SED", "USA_USGS_NGDB", "USA_NURE_HSSR"]);

export type GeostatDataset = { source: string; sampleType: string; n: number; elements: { symbol: string; n: number }[]; catchments?: boolean };
export type GeostatOptions = { datasets: GeostatDataset[] };

let typeCache: { at: number; names: Set<string> } | null = null;
async function allowedTypes(): Promise<Set<string>> {
  if (typeCache && Date.now() - typeCache.at < 6 * 3600_000) return typeCache.names;
  const r = await getPool().query(`SELECT sample_type_name FROM geochem.sample_types WHERE category_code = ANY($1::text[]) OR sample_type_name = ANY($2::text[])`, [ALLOWED_CATEGORIES, ALLOWED_EXTRA_TYPES]);
  typeCache = { at: Date.now(), names: new Set(r.rows.map((x) => x.sample_type_name as string)) };
  return typeCache.names;
}

// Stream sediments are offered only where sample catchment basins have been built (geochem.sample_catchments, from
// lithosurfer-work/catchments/build_catchments.py), and only as catchment maps, never kriged.
export const STREAM_TYPE = "Stream Sediment";
let catchCache: { at: number; sources: Set<string> } | null = null;
async function catchmentSources(): Promise<Set<string>> {
  if (catchCache && Date.now() - catchCache.at < 3600_000) return catchCache.sources;
  const r = await getPool().query(`SELECT DISTINCT source_system FROM geochem.sample_catchments WHERE geom IS NOT NULL`);
  catchCache = { at: Date.now(), sources: new Set(r.rows.map((x) => x.source_system as string)) };
  return catchCache.sources;
}
/** "grid" for soil/till/lake sediment, "catchment" for stream sediments of a dataset with catchments; anything else is refused. */
async function checkType(source: string, sampleType: string): Promise<"grid" | "catchment"> {
  const [types, catch_] = await Promise.all([allowedTypes(), catchmentSources()]);
  if (types.has(sampleType)) return "grid";
  if (sampleType === STREAM_TYPE && catch_.has(source)) return "catchment";
  throw new Error("Only soil, till and lake-sediment samples can be gridded, and stream sediments only where catchments have been built.");
}
const CATCH_ONLY = (alias: string) => `AND EXISTS (SELECT 1 FROM geochem.sample_catchments c WHERE c.sample_id = ${alias}.sample_id AND c.geom IS NOT NULL)`;

const OXIDE_OR_OTHER = /^(sio2|al2o3|cao|feo|fe2o3|feto3|k2o|mgo|mno|mno2|na2o|p2o5|tio2|bao|sro|cr2o3|co2|so3|nio|rb2o|v2o5|zro2|loi|lof|sum|vol)$/;

/** Datasets x sample types that can be gridded, with the elements each has (from the wide table's per-column counts). */
export async function geostatOptions(): Promise<GeostatOptions> {
  const [opts, types, catch_] = await Promise.all([getOptions(), allowedTypes(), catchmentSources()]);
  const datasets: GeostatDataset[] = [];
  for (const g of opts.groups) {
    const isCatch = g.sampleType === STREAM_TYPE && catch_.has(g.source);
    if ((!types.has(g.sampleType) && !isCatch) || g.n < 30) continue;
    const el = new Map<string, number>();
    for (const [col, n] of Object.entries(g.counts)) {
      const m = /^([a-z]{1,2})_(t|p)$/.exec(col);
      if (!m || OXIDE_OR_OTHER.test(m[1])) continue;
      const sym = m[1][0].toUpperCase() + m[1].slice(1);
      el.set(sym, Math.max(el.get(sym) ?? 0, n));
    }
    const elements = [...el.entries()].filter(([, n]) => n >= 30).map(([symbol, n]) => ({ symbol, n })).sort((a, b) => a.symbol.localeCompare(b.symbol));
    if (elements.length) datasets.push({ source: g.source, sampleType: g.sampleType, n: g.n, elements, ...(isCatch ? { catchments: true } : {}) });
  }
  datasets.sort((a, b) => a.source.localeCompare(b.source) || b.n - a.n);
  return { datasets };
}

export type Bbox = [number, number, number, number]; // west, south, east, north

/** Where the samples of one dataset, sample type and element are: their extent and a random set of up to 4,000 locations for the area-picker
 *  map (from the wide table, which is fast to scan; the series step then applies the exact survey/method split). */
export type Locations = { total: number; extent: Bbox | null; points: [number, number][] };
export async function fetchLocations(q: { source: string; sampleType: string; element: string }): Promise<Locations> {
  const [kind, valid] = await Promise.all([checkType(q.source, q.sampleType), validColumns()]);
  if (!/^[A-Z][a-z]?$/.test(q.element)) throw new Error("Choose an element.");
  const cols = ["_t", "_p"].map((s) => q.element.toLowerCase() + s).filter((c) => valid.has(c));
  if (!cols.length) return { total: 0, extent: null, points: [] };
  // Column names come from the whitelist above; values are bound parameters.
  const has = cols.map((c) => `("${c}" IS NOT NULL OR '${c}' = ANY(bdl_codes))`).join(" OR ");
  const where = `source_system = $1 AND coalesce(sample_type_name, 'Unknown') = $2 AND lat IS NOT NULL AND lon IS NOT NULL AND (${has})
    ${kind === "catchment" ? CATCH_ONLY("sample_chemistry_wide") : ""}`;
  return withClient(20000, async (c) => {
    const ext = (await c.query(`SELECT count(*)::int n, min(lon) w, min(lat) s, max(lon) e, max(lat) n_ FROM geochem.sample_chemistry_wide WHERE ${where}`, [q.source, q.sampleType])).rows[0];
    const pts = (await c.query(`SELECT lon, lat FROM geochem.sample_chemistry_wide WHERE ${where} ORDER BY random() LIMIT 4000`, [q.source, q.sampleType])).rows;
    return {
      total: ext.n,
      extent: ext.n ? [Number(ext.w), Number(ext.s), Number(ext.e), Number(ext.n_)] : null,
      points: pts.map((r) => [Number(Number(r.lon).toFixed(4)), Number(Number(r.lat).toFixed(4))] as [number, number]),
    };
  });
}
export type SeriesKey = { survey: string | null; method: string | null; fraction: string | null; unit: string | null };
export type SeriesRequest = { source: string; sampleType: string; element: string; bbox: Bbox };
export type Series = SeriesKey & { surveyDesc: string | null; samples: number; bdl: number; dlMin: number | null; dlMax: number | null };


export function parseSeriesRequest(body: unknown): SeriesRequest {
  const b = (body ?? {}) as Record<string, unknown>;
  const str = (v: unknown, max = 120) => (typeof v === "string" && v.trim() && v.length <= max ? v.trim() : null);
  const source = str(b.source), sampleType = str(b.sampleType), element = str(b.element, 3);
  if (!source || !sampleType) throw new Error("Choose a dataset and sample type.");
  if (!element || !/^[A-Z][a-z]?$/.test(element)) throw new Error("Choose an element.");
  const bb = b.bbox;
  if (!Array.isArray(bb) || bb.length !== 4 || !bb.every((v) => typeof v === "number" && Number.isFinite(v))) throw new Error("Give the area as west, south, east and north edges in decimal degrees.");
  const [w, s, e, n] = bb as number[];
  if (w >= e || s >= n || w < -180 || e > 180 || s < -90 || n > 90) throw new Error("The area edges are not valid (west must be less than east, south less than north).");
  const span = spanKm([w, s, e, n]);
  if (span.ew > MAX_SPAN_KM || span.ns > MAX_SPAN_KM) throw new Error(`The area is too large (${Math.round(span.ew)} x ${Math.round(span.ns)} km). Keep each side under ${MAX_SPAN_KM} km: interpolation over a whole country hides the local detail and distorts distances.`);
  return { source, sampleType, element, bbox: [w, s, e, n] };
}

const BASE_FROM = `FROM geochem.samples s
  JOIN geochem.sample_types st ON st.sample_type_id = s.sample_type_id
  JOIN geochem.analytical_results r ON r.sample_id = s.sample_id AND r.source_system = s.source_system`;
const baseWhere = (p: (v: unknown) => string, q: SeriesRequest) =>
  `s.source_system = ${p(q.source)} AND st.sample_type_name = ${p(q.sampleType)} AND s.is_active AND r.is_active
   AND r.analyte_symbol = ${p(q.element)}
   AND s.lat BETWEEN ${p(q.bbox[1])} AND ${p(q.bbox[3])} AND s.lon BETWEEN ${p(q.bbox[0])} AND ${p(q.bbox[2])}`;
// Null-safe: most results have no qualifier, and NOT (NULL IN (...)) would be NULL and drop them.
const LT = `coalesce(r.qualifier_code IN ('<', 'ND'), false)`;

async function withClient<T>(ms: number, f: (c: import("pg").PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query(`SET statement_timeout = ${ms}`);
    return await f(client);
  } finally {
    try { await client.query("RESET statement_timeout"); } catch { /* released either way */ }
    client.release();
  }
}

/** The series (survey x method x fraction x unit) available for one dataset, sample type and element inside the area. */
export async function listSeries(q: SeriesRequest): Promise<{ series: Series[]; credits: string[] }> {
  const kind = await checkType(q.source, q.sampleType);
  const params: unknown[] = [];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  const sql = `SELECT ${SURVEY_SQL} survey, min(${SURVEY_DESC_SQL}) survey_desc, r.method_code, r.fraction, r.unit_code,
      count(DISTINCT s.sample_id)::int samples, count(DISTINCT s.sample_id) FILTER (WHERE ${LT})::int bdl,
      min(coalesce(r.lower_detection_limit, abs(r.value))) FILTER (WHERE ${LT}) dl_min, max(coalesce(r.lower_detection_limit, abs(r.value))) FILTER (WHERE ${LT}) dl_max
    ${BASE_FROM} WHERE ${baseWhere(p, q)} ${kind === "catchment" ? CATCH_ONLY("s") : ""} GROUP BY 1, 3, 4, 5 ORDER BY samples DESC LIMIT 200`;
  const rows = await withClient(25000, async (c) => (await c.query(sql, params)).rows);
  return {
    series: rows.map((r) => ({
      survey: r.survey, surveyDesc: r.survey_desc, method: r.method_code, fraction: r.fraction, unit: r.unit_code,
      samples: r.samples, bdl: r.bdl, dlMin: r.dl_min === null ? null : Number(r.dl_min), dlMax: r.dl_max === null ? null : Number(r.dl_max),
    })),
    credits: creditsFromText(q.source),
  };
}

export type DataRequest = SeriesRequest & { series: SeriesKey; limit: number; seed: number };
export type GeostatPoint = [number, number, number | null, number | null, number]; // lon, lat, value (null when below detection), detection limit, flags (1 = '>' upper limit, 2 = non-positive value dropped)
export type GeostatData = { points: GeostatPoint[]; ids: string[]; matching: number; credits: string[]; restricted: boolean };

export function parseDataRequest(body: unknown): DataRequest {
  const base = parseSeriesRequest(body);
  const b = (body ?? {}) as Record<string, unknown>;
  const s = (b.series ?? {}) as Record<string, unknown>;
  const opt = (v: unknown) => (v === null || v === undefined ? null : typeof v === "string" && v.length <= 200 ? v : (() => { throw new Error("Bad series."); })());
  return {
    ...base,
    series: { survey: opt(s.survey), method: opt(s.method), fraction: opt(s.fraction), unit: opt(s.unit) },
    limit: Math.min(Math.max(Math.round(Number(b.limit) || MAX_POINTS), 50), MAX_POINTS),
    seed: Math.round(Number(b.seed) || 1),
  };
}

/** One value per sample for the chosen series. Repeat analyses of a sample are averaged; a sample is below detection only if every analysis is. */
export async function fetchSeries(q: DataRequest): Promise<GeostatData> {
  const kind = await checkType(q.source, q.sampleType);
  const params: unknown[] = [];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  const where = `${baseWhere(p, q)}
    AND (${SURVEY_SQL}) IS NOT DISTINCT FROM ${p(q.series.survey)}::text
    AND r.method_code IS NOT DISTINCT FROM ${p(q.series.method)}::text
    AND r.fraction IS NOT DISTINCT FROM ${p(q.series.fraction)}::text
    AND r.unit_code IS NOT DISTINCT FROM ${p(q.series.unit)}::text
    ${kind === "catchment" ? CATCH_ONLY("s") : ""}`;
  const sql = `WITH per AS (
      SELECT s.sample_id, s.lon, s.lat,
        avg(r.value) FILTER (WHERE NOT ${LT} AND r.value > 0) v,
        min(coalesce(r.lower_detection_limit, abs(r.value))) FILTER (WHERE ${LT}) dl,
        bool_or(r.qualifier_code = '>') gt,
        bool_or(NOT ${LT} AND r.value <= 0) nonpos
      ${BASE_FROM} WHERE ${where} GROUP BY 1, 2, 3)
    SELECT sample_id::text id, lon, lat, v, dl, gt, nonpos, count(*) OVER () matching FROM per
    WHERE lon IS NOT NULL AND lat IS NOT NULL AND (v IS NOT NULL OR dl > 0 OR nonpos)
    ORDER BY md5(sample_id::text || ${p(String(q.seed))}) LIMIT ${p(q.limit)}`;
  const rows = await withClient(30000, async (c) => (await c.query(sql, params)).rows);
  return {
    points: rows.map((r) => [Number(r.lon), Number(r.lat), r.v === null ? null : Number(r.v), r.dl === null ? null : Number(r.dl), (r.gt ? 1 : 0) | (r.v === null && r.dl === null && r.nonpos ? 2 : 0)]),
    ids: rows.map((r) => r.id as string),
    matching: rows.length ? Number(rows[0].matching) : 0,
    credits: creditsFromText(q.source),
    restricted: GEUS_RAW_DATA_LOCKED && q.source === "GREENLAND_GEUS",
  };
}

/** Sample catchment basins for the given samples. Samples taken at the same stream point share one polygon (pour), sent once. */
export type CatchmentPour = {
  pour: number; geometry: unknown; ownKm2: number; upstreamKm2: number; iceShare: number; upstreamSamples: number; snapM: number;
  lon: number; lat: number; downstream: number | null;
};
export type Catchments = { pours: CatchmentPour[]; pourOf: Record<string, number>; method: string; credits: string[] };
export const CATCHMENT_CREDITS = [
  "Catchments: Copernicus DEM GLO-90 (c) DLR e.V. 2010-2014 and (c) Airbus Defence and Space GmbH 2014-2018, provided under COPERNICUS by the European Union and ESA",
  "Ice mask: ESA WorldCover 2021 v200 (CC BY 4.0)",
];
export async function fetchCatchments(ids: string[]): Promise<Catchments> {
  const clean = [...new Set(ids.filter((v) => /^[0-9]{1,18}$/.test(v)))].slice(0, MAX_POINTS);
  // Vercel caps a function response at about 4.5 MB: simplify the outlines more (0.0004 degrees is about 40 m) until the polygons fit.
  const rows = await withClient(20000, async (c) => {
    let out: Record<string, unknown>[] = [];
    for (const tol of [0.0004, 0.0008, 0.0016, 0.003]) {
      out = (await c.query(
        `SELECT sample_id::text id, region, pour_id, own_area_km2, upstream_area_km2, ice_share, upstream_samples, snap_m, pour_lon, pour_lat,
                downstream_pour_id, method, ST_AsGeoJSON(ST_SimplifyPreserveTopology(geom, $2), 4) g
           FROM geochem.sample_catchments WHERE sample_id = ANY($1::bigint[]) AND geom IS NOT NULL`,
        [clean, tol]
      )).rows;
      const seen = new Set<string>();
      let size = 0;
      for (const r of out) { const k = `${r.region}:${r.pour_id}`; if (!seen.has(k)) { seen.add(k); size += String(r.g).length + 200; } }
      if (size < 3_500_000) break;
    }
    return out;
  });
  // pour_id is unique within a region; key on region too in case several regions are loaded.
  const key = (r: Record<string, unknown>) => `${r.region}:${r.pour_id}`;
  const index = new Map<string, number>();
  const pours: CatchmentPour[] = [];
  const pourOf: Record<string, number> = {};
  for (const r of rows) {
    let k = index.get(key(r));
    if (k === undefined) {
      k = pours.length;
      index.set(key(r), k);
      pours.push({
        pour: k, geometry: JSON.parse(String(r.g)), ownKm2: Number(r.own_area_km2), upstreamKm2: Number(r.upstream_area_km2), iceShare: Number(r.ice_share),
        upstreamSamples: Number(r.upstream_samples), snapM: Number(r.snap_m), lon: Number(r.pour_lon), lat: Number(r.pour_lat),
        downstream: r.downstream_pour_id === null ? null : Number(r.downstream_pour_id),
      });
    }
    pourOf[String(r.id)] = k;
  }
  return { pours, pourOf, method: String(rows[0]?.method ?? ""), credits: CATCHMENT_CREDITS };
}
