import { getPool } from "@/lib/db";
import { creditsFromText, GEUS_RAW_DATA_LOCKED } from "@/lib/licence";

// Sample extracts from geochem.sample_chemistry_wide for the Multivariate tools page (one row per sample, one column per element and basis).
// Queries are built here from whitelisted column names and bound parameters only; nothing the browser sends becomes SQL text.

const META = ["lithology_category", "lithology_name", "sample_type_name", "source_system"] as const;
// Oxides and other wt% columns, with their display names.
const WT_PCT: Record<string, string> = {
  sio2: "SiO2", al2o3: "Al2O3", cao: "CaO", feo: "FeO", fe2o3: "Fe2O3", feto3: "Fe2O3T", k2o: "K2O", mgo: "MgO", mno: "MnO", mno2: "MnO2", na2o: "Na2O",
  p2o5: "P2O5", tio2: "TiO2", bao: "BaO", sro: "SrO", cr2o3: "Cr2O3", co2: "CO2", so3: "SO3", nio: "NiO", rb2o: "Rb2O", v2o5: "V2O5", zro2: "ZrO2",
  loi: "LOI", lof: "LOF", sum: "Total", vol: "Volatiles",
};
const TTL_MS = 6 * 3600_000;
export const MAX_SAMPLES = 20000;
const GEUS = "GREENLAND_GEUS";

export type Group = { source: string; sampleType: string; n: number; counts: Record<string, number> };
export type Options = { columns: { code: string; label: string }[]; groups: Group[]; lithologyCategories: string[]; credits: Record<string, string[]>; geusLocked: boolean };

/** Display label for a wide-table column, with its unit and basis: cu_t -> "Cu ppm (total)", sio2_t -> "SiO2 wt% (total)". */
export function columnLabel(code: string): string {
  if (code.endsWith("_pct")) return `${code.replace(/_pct$/, "").replace(/_/g, " ").replace(/^c /, "C ")} wt%`;
  const m = /^(.+)_(t|p)$/.exec(code);
  if (!m) return code;
  const [, base, basis] = m;
  const oxide = WT_PCT[base];
  const name = oxide ?? base[0].toUpperCase() + base.slice(1);
  return `${name} ${oxide ? "wt%" : "ppm"} (${basis === "t" ? "total" : "partial"})`;
}

let cache: { at: number; value: Options; cols: Set<string> } | null = null;

export async function getOptions(): Promise<Options> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const client = await getPool().connect();
  try {
    await client.query("SET statement_timeout = 30000");
    const cols = (
      await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'geochem' AND table_name = 'sample_chemistry_wide'
           AND data_type = 'double precision' AND column_name NOT IN ('lat', 'lon') ORDER BY ordinal_position`
      )
    ).rows.map((r) => r.column_name as string);
    const counts = await client.query(`SELECT source_system, sample_type_name, count(*) n, ${cols.map((c) => `count("${c}") "${c}"`).join(", ")} FROM geochem.sample_chemistry_wide GROUP BY 1, 2`);
    const groups: Group[] = counts.rows.map((r) => ({
      source: r.source_system,
      sampleType: r.sample_type_name ?? "Unknown",
      n: Number(r.n),
      counts: Object.fromEntries(cols.map((c) => [c, Number(r[c])]).filter(([, v]) => (v as number) > 0)),
    }));
    const lith = (await client.query(`SELECT DISTINCT lithology_category FROM geochem.sample_chemistry_wide WHERE lithology_category IS NOT NULL ORDER BY 1`)).rows.map((r) => r.lithology_category as string);
    const sources = [...new Set(groups.map((g) => g.source))];
    const value: Options = {
      columns: cols.map((c) => ({ code: c, label: columnLabel(c) })),
      groups,
      lithologyCategories: lith,
      credits: Object.fromEntries(sources.map((s) => [s, creditsFromText(s)])),
      geusLocked: GEUS_RAW_DATA_LOCKED,
    };
    cache = { at: Date.now(), value, cols: new Set(cols) };
    return value;
  } finally {
    try {
      await client.query("RESET statement_timeout");
    } catch {
      /* released either way */
    }
    client.release();
  }
}

export type SampleRequest = {
  groups: { source: string; sampleType: string }[];
  lithologyCategories: string[];
  bbox: [number, number, number, number] | null; // west, south, east, north
  columns: string[];
  requireAll: boolean;
  limit: number;
  seed: number;
};

export type SampleResponse = {
  columns: string[]; // meta columns, then lon, lat, then element columns (codes)
  labels: string[];
  rows: (string | number | null)[][];
  bdl: number[][]; // per row: indexes into columns of values reported below detection (the value itself is null)
  matching: number;
  credits: string[];
  restricted: boolean; // true when Greenland (GEUS) rows are included and their raw values are locked
};

export function parseRequest(body: unknown, valid: Set<string>): SampleRequest {
  const b = (body ?? {}) as Record<string, unknown>;
  const groups = Array.isArray(b.groups) ? b.groups.filter((g): g is { source: string; sampleType: string } => typeof g?.source === "string" && typeof g?.sampleType === "string").slice(0, 100) : [];
  if (groups.length === 0) throw new Error("Choose at least one dataset and sample type.");
  const columns = Array.isArray(b.columns) ? [...new Set(b.columns.filter((c): c is string => typeof c === "string" && valid.has(c)))].slice(0, 60) : [];
  if (columns.length < 2) throw new Error("Choose at least two elements.");
  const lithologyCategories = Array.isArray(b.lithologyCategories) ? b.lithologyCategories.filter((c): c is string => typeof c === "string").slice(0, 20) : [];
  const bb = Array.isArray(b.bbox) && b.bbox.length === 4 && b.bbox.every((v) => typeof v === "number" && Number.isFinite(v)) ? (b.bbox as [number, number, number, number]) : null;
  const limit = Math.min(Math.max(Math.round(Number(b.limit) || 5000), 10), MAX_SAMPLES);
  return { groups, lithologyCategories, bbox: bb, columns, requireAll: b.requireAll !== false, limit, seed: Math.round(Number(b.seed) || 1) };
}

export async function fetchSamples(req: SampleRequest): Promise<SampleResponse> {
  await getOptions();
  const valid = cache!.cols;
  const cols = req.columns.filter((c) => valid.has(c));
  const params: unknown[] = [];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  const where: string[] = [];
  where.push(`(source_system, coalesce(sample_type_name, 'Unknown')) IN (SELECT * FROM unnest(${p(req.groups.map((g) => g.source))}::text[], ${p(req.groups.map((g) => g.sampleType))}::text[]))`);
  if (req.lithologyCategories.length) where.push(`lithology_category = ANY(${p(req.lithologyCategories)}::text[])`);
  if (req.bbox) {
    const [w, s, e, n] = req.bbox;
    where.push(`lat BETWEEN ${p(Math.min(s, n))} AND ${p(Math.max(s, n))}`);
    // A west edge greater than the east edge means the box crosses the 180° meridian.
    where.push(w <= e ? `lon BETWEEN ${p(w)} AND ${p(e)}` : `(lon >= ${p(w)} OR lon <= ${p(e)})`);
  }
  // A value reported below detection counts as present: it is analysed, just low.
  const present = (c: string) => `("${c}" IS NOT NULL OR '${c}' = ANY(bdl_codes))`;
  where.push(req.requireAll ? cols.map(present).join(" AND ") : `(${cols.map(present).join(" OR ")})`);
  const w = where.join(" AND ");

  const client = await getPool().connect();
  try {
    await client.query("SET statement_timeout = 20000");
    const matching = Number((await client.query(`SELECT count(*) n FROM geochem.sample_chemistry_wide WHERE ${w}`, params)).rows[0].n);
    const seed = p(String(req.seed));
    const limit = p(req.limit);
    const r = await client.query(
      `SELECT sample_id::text sample_id, ${META.join(", ")}, lon, lat, ${cols.map((c) => `"${c}"`).join(", ")}, bdl_codes
         FROM geochem.sample_chemistry_wide WHERE ${w} ORDER BY md5(sample_id::text || ${seed}) LIMIT ${limit}`,
      params
    );
    const columns = ["sample_id", ...META, "lon", "lat", ...cols];
    const firstEl = columns.length - cols.length;
    const rows = r.rows.map((row) => columns.map((c) => (row[c] === undefined ? null : row[c])));
    const bdl = r.rows.map((row) => {
      const codes: string[] = row.bdl_codes ?? [];
      return cols.flatMap((c, k) => (row[c] === null && codes.includes(c) ? [firstEl + k] : []));
    });
    const sources = [...new Set(r.rows.map((row) => row.source_system as string))];
    return {
      columns,
      labels: columns.map((c, i) => (i >= firstEl ? columnLabel(c) : c)),
      rows,
      bdl,
      matching,
      credits: sources.flatMap((s) => creditsFromText(s)).filter((c, i, a) => a.indexOf(c) === i),
      restricted: GEUS_RAW_DATA_LOCKED && sources.includes(GEUS),
    };
  } finally {
    try {
      await client.query("RESET statement_timeout");
    } catch {
      /* released either way */
    }
    client.release();
  }
}

export async function validColumns(): Promise<Set<string>> {
  await getOptions();
  return cache!.cols;
}
