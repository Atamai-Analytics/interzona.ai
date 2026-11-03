import { runReadOnlyQuery } from "@/lib/db";

/**
 * find_geochemical_anomalies: the deterministic "where are the geochemical anomalies for X?" analysis behind exploration-targeting
 * questions. Works on geochem.sample_chemistry_wide (one row per sample, non-oxide analytes in ppm, <symbol>_t total basis and
 * <symbol>_p partial-digestion basis). For an indicator made of one or more elements it
 *   1. sums the element values per sample (below-detection counts as 0, not-analysed samples are left out),
 *   2. takes a percentile threshold SEPARATELY for every sample type (rock, stream sediment, soil ... are not comparable),
 *   3. bins the anomalous samples to a lat/lon grid,
 *   4. measures each cell's distance to the nearest catalogued occurrence of the commodity AND to the nearest occurrence of any kind,
 *   5. labels each cell NEAR_KNOWN_COMMODITY / NEAR_OTHER_OCCURRENCE / NEW_LEAD.
 * Everything runs as ONE read-only query (the same guard and 15 s timeout as run_sql); user-supplied values are validated against
 * whitelists or strict patterns because runReadOnlyQuery takes a plain SQL string.
 */

export type AnomalyParams = {
  commodity?: string; // preset: REE, LREE, HREE, PGE
  elements?: string[]; // element symbols, used when no preset fits (e.g. ["li"], ["cu", "mo"])
  source_system?: string;
  bbox?: number[]; // [west, south, east, north]
  basis?: string; // total | partial | any
  percentile?: number; // 0.5 - 0.999, default 0.95
  grid_deg?: number; // default 0.25
  min_anomalous?: number; // minimum anomalous samples in a cell, default 3
  min_elements?: number; // elements that must have been analysed, default 60% of the list
  sample_type_contains?: string[]; // e.g. ["stream", "rock"]
  include_drill_samples?: boolean; // default false: drill-hole assays (sample_context DRILLHOLE_INTERVAL) sit in known mineralised zones and are left out
  occurrence_commodity_pattern?: string; // regex over core.occurrences.commodities
  near_km?: number; // 'near a catalogued occurrence' distance, default 15
  limit?: number; // cells returned, default 15, max 40
};

// "required" = key elements that must have been analysed for a sample to count (the rest are added when present). Many rock-chip and
// stream-sediment surveys report only a handful of rare earths (La, Ce, Nd, Y), and requiring the full list would drop the strongest samples.
const PRESETS: Record<string, { elements: string[]; required: string[]; pattern: string; label: string }> = {
  REE: {
    elements: ["la", "ce", "pr", "nd", "sm", "eu", "gd", "tb", "dy", "ho", "er", "tm", "yb", "lu", "y"],
    required: ["la", "ce", "nd"],
    pattern: "rare earth|^l?h?ree$|^y2o3$|^(la|ce|pr|nd|sm|eu|gd|tb|dy|ho|er|tm|yb|lu|y)$",
    label: "total rare earths incl. Y (ppm)",
  },
  LREE: { elements: ["la", "ce", "pr", "nd", "sm"], required: ["la", "ce", "nd"], pattern: "rare earth|^l?ree$|^(la|ce|pr|nd|sm)$", label: "light rare earths La-Sm (ppm)" },
  HREE: {
    elements: ["gd", "tb", "dy", "ho", "er", "tm", "yb", "lu", "y"],
    required: ["y"],
    pattern: "heavy rare earth|^hree$|^y2o3$|^(gd|tb|dy|ho|er|tm|yb|lu|y)$",
    label: "heavy rare earths Gd-Lu + Y (ppm)",
  },
  PGE: { elements: ["pt", "pd", "rh", "ru", "ir", "os"], required: ["pt", "pd"], pattern: "^(pge|pgm|pt|pd|rh|ru|ir|os|platinum|palladium)$", label: "platinum-group elements (ppm)" },
};

let cache: { sources: Set<string>; columns: Set<string>; at: number } | null = null;

async function allowed() {
  if (cache && Date.now() - cache.at < 10 * 60_000) return cache;
  const src = await runReadOnlyQuery("SELECT DISTINCT source_system FROM geochem.sample_chemistry_wide", 100);
  const cols = await runReadOnlyQuery(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = 'geochem' AND table_name = 'sample_chemistry_wide'",
    400
  );
  cache = {
    sources: new Set(src.rows.map((r) => String(r.source_system))),
    columns: new Set(cols.rows.map((r) => String(r.column_name))),
    at: Date.now(),
  };
  return cache;
}

function num(v: unknown, def: number, min: number, max: number, name: string) {
  if (v === undefined || v === null) return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name} must be a number between ${min} and ${max}.`);
  return n;
}

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

export async function findGeochemicalAnomalies(p: AnomalyParams) {
  const ok = await allowed();

  // indicator elements
  const preset = p.commodity ? PRESETS[p.commodity.trim().toUpperCase()] : undefined;
  if (p.commodity && !preset) {
    throw new Error(`Unknown commodity preset "${p.commodity}". Presets: ${Object.keys(PRESETS).join(", ")}. For anything else pass "elements" (element symbols).`);
  }
  const elements = (preset?.elements ?? (p.elements ?? []).map((e) => String(e).trim().toLowerCase())).filter(Boolean);
  if (elements.length === 0) throw new Error('Give either "commodity" (a preset) or "elements" (element symbols such as ["li"] or ["cu","mo"]).');
  if (elements.length > 20) throw new Error("At most 20 elements.");
  for (const e of elements) if (!/^[a-z]{1,2}$/.test(e)) throw new Error(`"${e}" is not an element symbol (oxides are not supported here; use run_sql for those).`);

  const basis = (p.basis ?? "total").toLowerCase();
  if (!["total", "partial", "any"].includes(basis)) throw new Error('basis must be "total", "partial" or "any".');
  const colFor = (e: string) => {
    const t = `${e}_t`, pcol = `${e}_p`;
    if (basis === "total") return ok.columns.has(t) ? [t] : [];
    if (basis === "partial") return ok.columns.has(pcol) ? [pcol] : [];
    return [t, pcol].filter((c) => ok.columns.has(c));
  };
  const used: string[][] = [];
  const missing: string[] = [];
  for (const e of elements) {
    const c = colFor(e);
    if (c.length === 0) missing.push(e); else used.push(c);
  }
  if (used.length === 0) throw new Error(`No ${basis}-basis columns for ${elements.join(", ")} in geochem.sample_chemistry_wide.`);

  // per element: value = first non-null of its columns; analysed = a value or a below-detection flag on any of its columns
  const valExpr = used.map((c) => (c.length === 1 ? `coalesce(${c[0]}, 0)` : `coalesce(${c.join(", ")}, 0)`)).join(" + ");
  const presExpr = used
    .map((c) => `(CASE WHEN ${c.map((x) => `${x} IS NOT NULL OR ${lit(x)} = ANY(bdl_codes)`).join(" OR ")} THEN 1 ELSE 0 END)`)
    .join(" + ");
  const analysed = (c: string[]) => c.map((x) => `${x} IS NOT NULL OR ${lit(x)} = ANY(bdl_codes)`).join(" OR ");
  const requiredCols = (preset?.required ?? []).map(colFor).filter((c) => c.length > 0);
  const minElements = Math.min(used.length, Math.max(1, Math.round(num(p.min_elements, preset ? 1 : Math.ceil(used.length * 0.6), 1, 20, "min_elements"))));
  // a sample counts when every required key element was analysed (presets) and at least minElements elements were analysed
  const okExpr = [...requiredCols.map((c) => `(${analysed(c)})`), `(${presExpr}) >= ${minElements}`].join(" AND ");

  const percentile = num(p.percentile, 0.95, 0.5, 0.999, "percentile");
  const grid = num(p.grid_deg, 0.25, 0.01, 5, "grid_deg");
  const minAnom = Math.round(num(p.min_anomalous, 3, 1, 1000, "min_anomalous"));
  const nearKm = num(p.near_km, 15, 1, 500, "near_km");
  const limit = Math.round(num(p.limit, 15, 1, 40, "limit"));

  // scope filters
  const where: string[] = ["lat IS NOT NULL", "lon IS NOT NULL"];
  if (p.source_system) {
    if (!ok.sources.has(p.source_system)) throw new Error(`Unknown source_system "${p.source_system}". Valid: ${[...ok.sources].sort().join(", ")}.`);
    where.push(`source_system = ${lit(p.source_system)}`);
  }
  if (p.bbox) {
    if (p.bbox.length !== 4 || p.bbox.some((x) => !Number.isFinite(Number(x)))) throw new Error("bbox must be [west, south, east, north] in degrees.");
    const [w, s, e, n] = p.bbox.map(Number);
    where.push(`lon BETWEEN ${w} AND ${e}`, `lat BETWEEN ${s} AND ${n}`);
  }
  if (!p.source_system && !p.bbox) throw new Error("Give a source_system and/or a bbox so the analysis has a region.");
  if (p.include_drill_samples !== true) where.push("sample_context IS DISTINCT FROM 'DRILLHOLE_INTERVAL'");
  if (p.sample_type_contains?.length) {
    const parts = p.sample_type_contains.map((t) => {
      if (!/^[A-Za-z0-9 ()\-/]{2,40}$/.test(t)) throw new Error(`Invalid sample_type_contains value "${t}".`);
      return `sample_type_name ILIKE ${lit(`%${t}%`)}`;
    });
    where.push(`(${parts.join(" OR ")})`);
  }

  const pattern = p.occurrence_commodity_pattern ?? preset?.pattern ?? `^(${elements.join("|")})$`;
  if (!/^[A-Za-z0-9 ^$|?.*()\-_]{1,200}$/.test(pattern)) throw new Error("occurrence_commodity_pattern contains unsupported characters.");

  // ONE pass over the wide table: per-type counts and thresholds (coverage), anomalous samples, cells, then the distance lookups.
  // "co" is MATERIALIZED so the commodity-occurrence set is built once, not once per cell.
  const sql = `
WITH s AS (
  SELECT sample_id, sample_type_name AS st, lat, lon, (${valExpr}) AS v, (${okExpr}) AS ok
  FROM geochem.sample_chemistry_wide WHERE ${where.join(" AND ")}),
p AS (
  SELECT st, count(*) AS n_scope, count(*) FILTER (WHERE ok) AS n_ok,
         percentile_cont(${percentile}) WITHIN GROUP (ORDER BY v) FILTER (WHERE ok) AS thr
  FROM s GROUP BY st),
a AS (SELECT s.*, p.thr, (s.v >= p.thr AND s.v > 0) AS anom FROM s JOIN p USING (st) WHERE s.ok AND p.n_ok >= 30),
cells AS (
  SELECT round(lat / ${grid}) * ${grid} AS lat_c, round(lon / ${grid}) * ${grid} AS lon_c,
         count(*) AS n_analysed, count(*) FILTER (WHERE anom) AS n_anomalous,
         round(max(v) FILTER (WHERE anom)::numeric, 1) AS max_value_ppm,
         round((percentile_cont(0.5) WITHIN GROUP (ORDER BY v) FILTER (WHERE anom))::numeric, 1) AS median_anomalous_ppm,
         round(avg(lat) FILTER (WHERE anom)::numeric, 3) AS anom_lat, round(avg(lon) FILTER (WHERE anom)::numeric, 3) AS anom_lon,
         string_agg(DISTINCT st, ', ') FILTER (WHERE anom) AS anomalous_sample_types,
         (array_agg(sample_id ORDER BY v DESC) FILTER (WHERE anom))[1:8] AS top_sample_ids
  FROM a GROUP BY 1, 2 HAVING count(*) FILTER (WHERE anom) >= ${minAnom}
  ORDER BY count(*) FILTER (WHERE anom) DESC, max(v) FILTER (WHERE anom) DESC LIMIT ${limit}),
cov AS (
  SELECT json_agg(json_build_object('sample_type', st, 'n_in_scope', n_scope, 'n_with_required_elements', n_ok,
                                    'threshold_ppm', CASE WHEN n_ok >= 30 THEN round(thr::numeric, 1) END) ORDER BY n_ok DESC) AS coverage
  FROM p WHERE n_ok > 0),
co AS MATERIALIZED (SELECT o.name, o.geog FROM core.occurrences o WHERE o.is_active AND o.position_accuracy IS DISTINCT FROM 'UNRELIABLE' AND EXISTS (SELECT 1 FROM unnest(o.commodities) k WHERE k ~* ${lit(pattern)}))
SELECT cov.coverage, c.*, kc.name AS nearest_commodity_occurrence, kc.km AS km_to_commodity_occurrence, ka.name AS nearest_any_occurrence, ka.km AS km_to_any_occurrence
FROM cov
LEFT JOIN cells c ON true
LEFT JOIN LATERAL (SELECT ST_SetSRID(ST_MakePoint(c.anom_lon::float8, c.anom_lat::float8), 4326)::geography AS pt) x ON true
LEFT JOIN LATERAL (SELECT co.name, round((ST_Distance(co.geog, x.pt) / 1000)::numeric, 1) AS km FROM co WHERE x.pt IS NOT NULL ORDER BY ST_Distance(co.geog, x.pt) LIMIT 1) kc ON true
LEFT JOIN LATERAL (SELECT o.name, round((ST_Distance(o.geog, x.pt) / 1000)::numeric, 1) AS km FROM core.occurrences o WHERE x.pt IS NOT NULL AND o.is_active AND o.position_accuracy IS DISTINCT FROM 'UNRELIABLE' ORDER BY o.geog <-> x.pt LIMIT 1) ka ON true
ORDER BY c.n_anomalous DESC NULLS LAST, c.max_value_ppm DESC NULLS LAST`;

  const res = await runReadOnlyQuery(sql, 100);
  const coverage = res.rows.length ? res.rows[0].coverage ?? [] : [];
  const rows = res.rows
    .filter((r) => r.lat_c !== null && r.lat_c !== undefined)
    .map((r) => {
      const { coverage: _cov, ...rest } = r;
      void _cov;
      const kc = rest.km_to_commodity_occurrence === null ? null : Number(rest.km_to_commodity_occurrence);
      const ka = rest.km_to_any_occurrence === null ? null : Number(rest.km_to_any_occurrence);
      const group = kc !== null && kc <= nearKm ? "NEAR_KNOWN_COMMODITY" : ka !== null && ka <= nearKm ? "NEAR_OTHER_OCCURRENCE" : "NEW_LEAD";
      return { group, ...rest };
    });
  const order = { NEW_LEAD: 0, NEAR_OTHER_OCCURRENCE: 1, NEAR_KNOWN_COMMODITY: 2 } as const;
  rows.sort((x, y) => order[x.group as keyof typeof order] - order[y.group as keyof typeof order]);

  return {
    indicator: preset?.label ?? `sum of ${used.map((c) => c[0].replace(/_[tp]$/, "")).join(", ")} (${basis} basis, ppm)`,
    elements_used: used.map((c) => c.join("/")),
    elements_missing_from_table: missing,
    required_key_elements: (preset?.required ?? []),
    min_elements_analysed: minElements,
    percentile,
    grid_deg: grid,
    near_km: nearKm,
    occurrence_commodity_pattern: pattern,
    coverage_by_sample_type: coverage,
    cells: rows,
    cell_count: rows.length,
    notes: [
      "Threshold is the chosen percentile of the indicator WITHIN each sample type (only types with at least 30 qualifying samples are used); samples never compared across types.",
      "Below-detection results count as 0; samples with fewer than min_elements elements analysed are left out. Values are single-point assays, not grades or resources.",
      "n_analysed is every qualifying sample in the cell: anomaly counts partly track where surveys went. top_sample_ids can be passed to run_geochem_analysis.",
      "NEW_LEAD = no catalogued occurrence of the commodity AND none of any kind within near_km; NEAR_OTHER_OCCURRENCE = only an occurrence of a different commodity nearby (check whether it is tagged correctly); NEAR_KNOWN_COMMODITY = the data see a known system.",
      "Some catalogued positions are only map-level (+/-50 km for part of Greenland), which blurs the distance columns.",
      "Sanity-check extreme values before calling them leads: a maximum or threshold far above any plausible trace-element level (for example thousands of ppm gold) usually means a unit or data-entry problem in that survey, not an ore body; say so and compare max with median_anomalous_ppm.",
      ...(coverage.length === 0 ? ["No samples in this scope have the required key elements analysed, so there is nothing to rank: report that, and try basis 'any', a wider region, or different elements."] : []),
    ],
  };
}
