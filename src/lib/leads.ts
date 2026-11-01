import { findGeochemicalAnomalies, type AnomalyParams } from "@/lib/anomalies";
import { creditsForSource } from "@/lib/licence";
import type { Dataset, Evidence, MapData, MapPoint } from "@/lib/types";

// Lead league table: the anomaly screen run on every survey, with the cells ranked together.
// Surveys differ in sample type, method and detection limits, so a raw value cannot be compared between them. What can be compared is how unlikely a cell's anomaly
// count is by chance within its OWN survey: the screen flags the top 5% of each sample type, so a cell of n samples would hold about 0.05 n flagged samples by chance,
// and the score is the binomial z-score of the actual count. Only cells with no catalogued occurrence of any kind nearby (new leads) are ranked unless asked otherwise.

type Out = { content: string; evidence?: Evidence[]; datasets?: Dataset[]; maps?: MapData[] };

const SURVEYS: Record<string, string> = {
  ARGENTINA_SEGEMAR: "Argentina (SEGEMAR)",
  GREENLAND_GEUS: "Greenland (GEUS)",
  FINLAND_GTK_ROCK: "Finland (GTK rock)",
  SWEDEN_SGU_LITHOGEOCHEMISTRY: "Sweden (SGU)",
  USA_USGS_NGDB: "USA (USGS)",
  AUSTRALIA_VIC_GSV_GEOCHEMISTRY: "Victoria, Australia (GSV)",
};

type Cell = Record<string, unknown>;
const num = (v: unknown): number | null => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const spike = (l: { max: number | null; median: number | null }) => (l.max !== null && l.median !== null && l.median > 0 ? Math.round((l.max / l.median) * 10) / 10 : null);
const round = (v: number | null, dp = 1) => (v === null ? null : Math.round(v * 10 ** dp) / 10 ** dp);

async function inBatches<T, R>(items: T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

export async function rankLeads(input: Record<string, unknown>): Promise<Out> {
  const percentile = Math.min(Math.max(Number(input.percentile) || 0.95, 0.9), 0.99);
  const p0 = 1 - percentile;
  const topN = Math.min(Math.max(Math.floor(Number(input.top_n) || 12), 3), 25);
  const perSurvey = Math.min(Math.max(Math.floor(Number(input.max_per_survey) || 4), 1), 10);
  const includeKnown = input.include_near_known === true;
  const wanted = Array.isArray(input.surveys) ? (input.surveys as unknown[]).map(String).filter((s) => SURVEYS[s]) : Object.keys(SURVEYS);
  const base: AnomalyParams = {
    commodity: input.commodity ? String(input.commodity) : undefined,
    elements: Array.isArray(input.elements) ? (input.elements as unknown[]).map(String) : undefined,
    basis: input.basis ? String(input.basis) : "any",
    percentile,
    grid_deg: Number(input.grid_deg) || 0.25,
    min_anomalous: Math.max(3, Math.floor(Number(input.min_anomalous) || 3)),
    near_km: Number(input.near_km) || 15,
    limit: 40,
  };
  if (!base.commodity && !(base.elements && base.elements.length)) return { content: 'Give "commodity" (REE, LREE, HREE or PGE) or "elements" (element symbols such as ["li"] or ["cu","mo"]).' };

  type Screened = { source: string; status: "screened" | "no data" | "failed"; detail?: string; indicator?: string; basis?: string; analysed: number; cells: Cell[]; thresholds: Record<string, number> };
  const screened: Screened[] = await inBatches(wanted, 3, async (source): Promise<Screened> => {
    try {
      const r = (await findGeochemicalAnomalies({ ...base, source_system: source })) as { indicator: string; cells: Cell[]; coverage_by_sample_type: { sample_type: string; n_with_required_elements: number; threshold_ppm: number | null }[]; elements_used: string[] };
      const cov = r.coverage_by_sample_type ?? [];
      const analysed = cov.reduce((s, c) => s + (num(c.n_with_required_elements) ?? 0), 0);
      const thresholds: Record<string, number> = {};
      for (const c of cov) if (num(c.threshold_ppm) !== null) thresholds[c.sample_type] = Number(c.threshold_ppm);
      return { source, status: analysed > 0 ? "screened" : "no data", indicator: r.indicator, analysed, cells: r.cells ?? [], thresholds };
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      return { source, status: /no .*columns|No samples|Unknown/i.test(msg) ? "no data" : "failed", detail: msg.slice(0, 160), analysed: 0, cells: [], thresholds: {} };
    }
  });

  type Lead = { rank?: number; source: string; survey: string; lat: number; lon: number; types: string; nAnom: number; nAn: number; share: number; fold: number; z: number; median: number | null; max: number | null; intensity: number | null; group: string; kcName: string | null; kcKm: number | null; kaName: string | null; kaKm: number | null };
  const leads: Lead[] = [];
  for (const s of screened) {
    const mine: Lead[] = [];
    for (const c of s.cells) {
      const group = String(c.group);
      if (!includeKnown && group !== "NEW_LEAD") continue;
      const n = num(c.n_analysed) ?? 0;
      const k = num(c.n_anomalous) ?? 0;
      const lat = num(c.anom_lat);
      const lon = num(c.anom_lon);
      if (n < 5 || lat === null || lon === null) continue;
      const z = (k - n * p0) / Math.sqrt(n * p0 * (1 - p0));
      const types = String(c.anomalous_sample_types ?? "");
      const thr = types.split(", ").map((t) => s.thresholds[t]).filter((x) => x !== undefined);
      const median = num(c.median_anomalous_ppm);
      mine.push({
        source: s.source, survey: SURVEYS[s.source], lat, lon, types, nAnom: k, nAn: n, share: k / n, fold: k / n / p0, z, median, max: num(c.max_value_ppm),
        intensity: median !== null && thr.length === 1 && thr[0] > 0 ? median / thr[0] : null, group,
        kcName: c.nearest_commodity_occurrence ? String(c.nearest_commodity_occurrence) : null, kcKm: num(c.km_to_commodity_occurrence),
        kaName: c.nearest_any_occurrence ? String(c.nearest_any_occurrence) : null, kaKm: num(c.km_to_any_occurrence),
      });
    }
    mine.sort((a, b) => b.z - a.z);
    leads.push(...mine.slice(0, perSurvey));
  }
  leads.sort((a, b) => b.z - a.z);
  const top = leads.slice(0, topN);
  top.forEach((l, i) => (l.rank = i + 1));

  const coord = (lat: number, lon: number) => `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? "N" : "S"}, ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? "E" : "W"}`;
  const indicator = screened.find((s) => s.indicator)?.indicator ?? "selected elements";
  const points: MapPoint[] = top.map((l) => ({
    lat: l.lat,
    lon: l.lon,
    label: `#${l.rank} ${l.survey}, ${coord(l.lat, l.lon)}`,
    group: l.survey,
    detail: [
      `${l.nAnom} of ${l.nAn} samples anomalous (${round(l.fold, 1)} times the chance rate)`,
      l.max !== null ? `Highest value ${l.max} ppm` : "",
      `Sample types: ${l.types}`,
      l.kcName ? `Nearest known occurrence of this commodity: ${l.kcName}, ${l.kcKm} km` : "No known occurrence of this commodity close by",
      l.kaName ? `Nearest occurrence of any kind: ${l.kaName}, ${l.kaKm} km` : "",
    ].filter(Boolean).join("\n"),
    size: Math.min(1, l.z / Math.max(1, top[0]?.z ?? 1)),
  }));
  const map: MapData | null = points.length
    ? {
        id: "map-leads-" + Date.now().toString(36),
        title: `Anomaly screen across surveys: ${indicator}`,
        note: "Each marker is the average position of the anomalous samples in a grid cell, coloured by survey and ranked across surveys; larger means a more unlikely anomaly count. Positions of catalogued occurrences can be off by kilometres.",
        points,
      }
    : null;
  const dataset: Dataset = {
    id: "leads-" + Date.now().toString(36),
    title: `Top leads across surveys: ${indicator}`,
    columns: ["Rank", "Survey", "Area (lat, lon)", "Samples anomalous", "Samples analysed", "Times the chance rate", "Highest value (ppm)", "Highest / median of anomalous", "Sample types", "Nearest occurrence of any kind", "km"],
    rows: top.map((l) => [l.rank ?? 0, l.survey, coord(l.lat, l.lon), l.nAnom, l.nAn, round(l.fold, 1), l.max, spike(l), l.types, l.kaName, l.kaKm]),
  };
  const credits = [...new Set(top.flatMap((l) => creditsForSource(l.source)))];
  const evidence: Evidence[] = [{ kind: "data", label: `Sample geochemistry anomaly screen across surveys${credits.length ? ": " + credits.join("; ") : ""}` }];

  const content = JSON.stringify({
    what: "Anomaly screen run on each survey, cells ranked together by how unlikely their anomaly count is by chance within their own survey",
    indicator,
    basis: String(base.basis),
    how_ranked: `Each survey flags the top ${Math.round(p0 * 100)}% of every sample type (so about ${Math.round(p0 * 100)}% of samples are flagged by chance); a cell's score is the binomial z-score of its flagged count against that chance rate. Raw ppm values are not comparable between surveys, so they are shown but not ranked on.`,
    surveys: screened.map((s) => ({ survey: SURVEYS[s.source], status: s.status, samples_with_the_elements: s.analysed, new_leads_found: s.cells.filter((c) => c.group === "NEW_LEAD").length, ...(s.detail ? { note: s.detail } : {}) })),
    leads: top.map((l) => ({
      rank: l.rank, survey: l.survey, area: coord(l.lat, l.lon), sample_types: l.types, samples_anomalous: l.nAnom, samples_analysed: l.nAn, times_chance_rate: round(l.fold, 1), z_score: round(l.z, 1),
      median_anomalous_ppm: l.median, highest_ppm: l.max, highest_over_median: spike(l), driven_by_a_few_extreme_values: (spike(l) ?? 0) > 20, intensity_vs_threshold: round(l.intensity, 1), group: l.group,
      nearest_occurrence_of_commodity: l.kcName ? { name: l.kcName, km: l.kcKm } : null, nearest_occurrence_any: l.kaName ? { name: l.kaName, km: l.kaKm } : null,
    })),
    reading_notes: [
      "These are geochemical anomalies in regional survey samples, not deposits, grades or resources; many are single-sample or single-survey effects.",
      "How many samples a survey holds, its sample types and methods differ, so the surveys are not equally good at finding leads; say which surveys had data and which had none for these elements.",
      "A cell with 'no occurrence nearby' is only as good as the occurrence catalogue there; catalogues are thinner in some countries than others.",
      "Cells flagged driven_by_a_few_extreme_values (the highest value is more than 20 times the median of the anomalous samples) rest on one or two spikes, which are often unit or data-entry problems: say so and put cells with many consistently anomalous samples ahead of them in your reading.",
      "For a closer look at one lead pass its area to the deposit fingerprint or the anomaly screen for that survey.",
    ],
    credit: credits,
  });
  return { content, evidence, datasets: top.length ? [dataset] : [], maps: map ? [map] : [] };
}
