import type { MapData, MapPoint } from "@/lib/types";

// Turns tool results into map points. Nothing here is generated: every point is a position that a query or the anomaly screen returned.

const MAX_POINTS = 300;
const POSITION_NOTE = "Positions are as catalogued by each source; some are only accurate to tens of kilometres, so treat a point as an area, not a precise site.";

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
const validPos = (lat: number | null, lon: number | null): lat is number =>
  lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);
const fmtCoord = (lat: number, lon: number) => `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? "N" : "S"}, ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? "E" : "W"}`;
const pretty = (s: string) => s.replace(/_/g, " ").replace(/\b(\w)/, (m) => m.toUpperCase());
// Stored status and category codes become words ("PAST_PRODUCER" -> "Past producing"); ordinary text is left alone.
const STATUS_WORDS: Record<string, string> = { PRODUCER: "Producing", PAST_PRODUCER: "Past producing", CARE_AND_MAINTENANCE: "Care and maintenance", DEVELOPMENT: "Development", EXPLORATION: "Exploration" };
const plainValue = (v: unknown) => {
  const t = String(v);
  if (STATUS_WORDS[t]) return STATUS_WORDS[t];
  return /^[A-Z][A-Z0-9_ ]+$/.test(t) && t.length > 2 ? pretty(t.toLowerCase()) : t;
};

const NAME_COLS = ["name", "occurrence_name", "site_name", "site", "project", "project_name", "deposit", "location", "label"];
const GROUP_COLS = ["status", "group", "category", "commodity", "primary_commodity", "type", "sample_type", "sample_type_name", "dataset", "source_system", "country"];
const SKIP_DETAIL = new Set(["lat", "lon", "latitude", "longitude", "lng", "geom", "geog"]);

/** A map from query rows that carry latitude and longitude columns; null when they do not (so ordinary tables never get a map). */
export function mapFromRows(rows: Record<string, unknown>[], title = "Places in this answer"): MapData | null {
  if (!rows.length) return null;
  const keys = Object.keys(rows[0]);
  const latKey = keys.find((k) => /^(lat|latitude)$/i.test(k));
  const lonKey = keys.find((k) => /^(lon|lng|long|longitude)$/i.test(k));
  if (!latKey || !lonKey) return null;
  const nameKey = NAME_COLS.find((c) => keys.some((k) => k.toLowerCase() === c));
  const nameCol = nameKey ? keys.find((k) => k.toLowerCase() === nameKey) : undefined;
  const groupKey = GROUP_COLS.find((c) => keys.some((k) => k.toLowerCase() === c));
  const groupCol = groupKey ? keys.find((k) => k.toLowerCase() === groupKey) : undefined;
  const points: MapPoint[] = [];
  for (const r of rows) {
    const lat = num(r[latKey]), lon = num(r[lonKey]);
    if (!validPos(lat, lon)) continue;
    // A source position known to be wrong (position_accuracy UNRELIABLE) is never drawn.
    if (String(r.position_accuracy ?? "") === "UNRELIABLE") continue;
    // Popup lines: identifiers are hidden, true/false flags become words ("is_deposit" true -> "Deposit", false -> omitted).
    const detail = keys
      .filter((k) => !SKIP_DETAIL.has(k.toLowerCase()) && !/(^|_)id$/i.test(k) && k !== nameCol && r[k] !== null && r[k] !== undefined && r[k] !== "")
      .map((k) => {
        const v = r[k];
        if (/^is_/i.test(k) || typeof v === "boolean") return v === true || v === "true" ? pretty(k.replace(/^is_/i, "")) : null;
        return `${pretty(k)}: ${plainValue(v).slice(0, 60)}`;
      })
      .filter((x): x is string => x !== null)
      .slice(0, 5)
      .join("\n");
    points.push({
      lat: lat as number,
      lon: lon as number,
      label: nameCol && r[nameCol] ? String(r[nameCol]).slice(0, 80) : fmtCoord(lat as number, lon as number),
      group: groupCol && r[groupCol] !== null && r[groupCol] !== undefined && String(r[groupCol]) !== "" ? plainValue(r[groupCol]).slice(0, 40) : "Result",
      detail: detail || undefined,
    });
    if (points.length >= MAX_POINTS) break;
  }
  // A single place is often an exploratory lookup, so the chat route holds one-place maps back and shows only the last one, and only when the
  // answer has no larger map (an answer about one plant still gets its map).
  if (points.length < 1) return null;
  return { id: "map-" + Date.now() + "-" + Math.floor(Math.random() * 1e4), title, note: POSITION_NOTE, points };
}

const GROUP_LABEL: Record<string, string> = {
  NEW_LEAD: "New lead (no known occurrence nearby)",
  NEAR_OTHER_OCCURRENCE: "Near an occurrence of a different commodity",
  NEAR_KNOWN_COMMODITY: "Near a known occurrence of this commodity",
};

/** A map of the anomaly screen's ranked cells: one marker per cell at the average position of its anomalous samples. */
export function mapFromAnomalies(result: { indicator?: string; grid_deg?: number; cells?: Record<string, unknown>[] }): MapData | null {
  const cells = result.cells ?? [];
  const points: MapPoint[] = [];
  const maxN = Math.max(1, ...cells.map((c) => num(c.n_anomalous) ?? 0));
  for (const c of cells) {
    const lat = num(c.anom_lat), lon = num(c.anom_lon);
    if (!validPos(lat, lon)) continue;
    const nA = num(c.n_anomalous) ?? 0, nT = num(c.n_analysed) ?? 0;
    const lines = [
      `${nA} of ${nT} samples anomalous`,
      num(c.max_value_ppm) !== null ? `Highest value ${num(c.max_value_ppm)} ppm` : "",
      c.anomalous_sample_types ? `Sample types: ${String(c.anomalous_sample_types)}` : "",
      c.nearest_commodity_occurrence ? `Nearest known occurrence of this commodity: ${String(c.nearest_commodity_occurrence)}, ${num(c.km_to_commodity_occurrence)} km` : "",
      c.nearest_any_occurrence ? `Nearest occurrence of any kind: ${String(c.nearest_any_occurrence)}, ${num(c.km_to_any_occurrence)} km` : "",
    ].filter(Boolean);
    points.push({
      lat: lat as number,
      lon: lon as number,
      label: `Anomalous area near ${fmtCoord(lat as number, lon as number)}`,
      group: GROUP_LABEL[String(c.group)] ?? "Anomalous area",
      detail: lines.join("\n"),
      size: nA / maxN,
    });
  }
  if (!points.length) return null;
  return {
    id: "map-" + Date.now() + "-" + Math.floor(Math.random() * 1e4),
    title: `Anomaly screen: ${result.indicator ?? "selected elements"}`,
    note: `Each marker is the average position of the anomalous samples in a ${result.grid_deg ?? ""}° cell (larger means more anomalous samples). ${POSITION_NOTE}`,
    points,
  };
}
