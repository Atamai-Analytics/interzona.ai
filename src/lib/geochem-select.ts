import { getPool } from "@/lib/db";
import { creditsFromText } from "@/lib/licence";
import { validColumns } from "@/lib/geochem-extract";
import { MAX_SELECTED_SAMPLES, METHODS, NEEDED_COLUMNS, isRockSampleType, usableFor, type Selection } from "@/lib/geochem-methods";

// Sample selection for the Geochemistry page: a random draw of sample_ids from geochem.sample_chemistry_wide by dataset/sample type, lithology
// and area, with a count of how many of the drawn samples each analysis can use. Built from whitelisted column names and bound parameters only.

export type SelectRequest = {
  groups: { source: string; sampleType: string }[];
  lithologyCategories: string[];
  bbox: [number, number, number, number] | null; // west, south, east, north
  limit: number;
  seed: number;
};

export function parseSelect(body: unknown): SelectRequest {
  const b = (body ?? {}) as Record<string, unknown>;
  const groups = Array.isArray(b.groups) ? b.groups.filter((g): g is { source: string; sampleType: string } => typeof g?.source === "string" && typeof g?.sampleType === "string").slice(0, 100) : [];
  if (groups.length === 0) throw new Error("Choose at least one dataset and sample type.");
  const lithologyCategories = Array.isArray(b.lithologyCategories) ? b.lithologyCategories.filter((c): c is string => typeof c === "string").slice(0, 20) : [];
  const bbox = Array.isArray(b.bbox) && b.bbox.length === 4 && b.bbox.every((v) => typeof v === "number" && Number.isFinite(v)) ? (b.bbox as [number, number, number, number]) : null;
  const limit = Math.min(Math.max(Math.round(Number(b.limit) || 1000), 10), MAX_SELECTED_SAMPLES);
  return { groups, lithologyCategories, bbox, limit, seed: Math.round(Number(b.seed) || 1) };
}

export async function selectSamples(req: SelectRequest): Promise<Selection> {
  const valid = await validColumns();
  const cols = NEEDED_COLUMNS.filter((c) => valid.has(c));
  const params: unknown[] = [];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  const where: string[] = [
    `(source_system, coalesce(sample_type_name, 'Unknown')) IN (SELECT * FROM unnest(${p(req.groups.map((g) => g.source))}::text[], ${p(req.groups.map((g) => g.sampleType))}::text[]))`,
  ];
  if (req.lithologyCategories.length) where.push(`lithology_category = ANY(${p(req.lithologyCategories)}::text[])`);
  if (req.bbox) {
    const [w, s, e, n] = req.bbox;
    where.push(`lat BETWEEN ${p(Math.min(s, n))} AND ${p(Math.max(s, n))}`);
    where.push(w <= e ? `lon BETWEEN ${p(w)} AND ${p(e)}` : `(lon >= ${p(w)} OR lon <= ${p(e)})`);
  }
  // Only samples that at least one analysis could use: anything else would just dilute the random draw.
  where.push(`(${cols.map((c) => `"${c}" IS NOT NULL`).join(" OR ")})`);
  const w = where.join(" AND ");

  const client = await getPool().connect();
  try {
    await client.query("SET statement_timeout = 25000");
    const matching = Number((await client.query(`SELECT count(*) n FROM geochem.sample_chemistry_wide WHERE ${w}`, params)).rows[0].n);
    const seed = p(String(req.seed));
    const limit = p(req.limit);
    const r = await client.query(
      `SELECT sample_id, source_system, coalesce(sample_type_name, 'Unknown') sample_type_name, lithology_category, ${cols.map((c) => `"${c}"`).join(", ")}
         FROM geochem.sample_chemistry_wide WHERE ${w} ORDER BY md5(sample_id::text || ${seed}) LIMIT ${limit}`,
      params
    );
    const count = (key: (row: Record<string, unknown>) => string) => {
      const m = new Map<string, number>();
      for (const row of r.rows) m.set(key(row), (m.get(key(row)) ?? 0) + 1);
      return [...m.entries()].sort((a, b) => b[1] - a[1]);
    };
    const usable: Record<string, number> = {};
    for (const m of METHODS) usable[m.id] = r.rows.filter((row) => usableFor(m, (c) => row[c] !== null && row[c] !== undefined)).length;
    const sources = count((row) => String(row.source_system));
    return {
      ids: r.rows.map((row) => Number(row.sample_id)),
      matching,
      bySource: sources.map(([source, n]) => ({ source, n })),
      bySampleType: count((row) => String(row.sample_type_name)).map(([type, n]) => ({ type, n })),
      byLithology: count((row) => String(row.lithology_category ?? "not recorded")).map(([category, n]) => ({ category, n })),
      usable,
      nonRock: r.rows.filter((row) => !isRockSampleType(String(row.sample_type_name))).length,
      credits: sources.flatMap(([s]) => creditsFromText(s)).filter((c, i, a) => a.indexOf(c) === i),
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
