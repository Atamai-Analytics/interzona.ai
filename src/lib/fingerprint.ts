import { runReadOnlyQuery } from "@/lib/db";
import { creditsForSource } from "@/lib/licence";
import type { Dataset, Evidence } from "@/lib/types";

// Deposit fingerprint: which kinds of mineral deposit do a set of rock samples resemble in their trace-element chemistry?
// The reference is the Critical Minerals in Ores geochemistry database (Geoscience Australia / CMMI): about 1,250 deposits in 23 deposit groups, one median per
// deposit and element. Samples and deposits are compared as log-ratios (centred log-ratio over the elements both have), with a linear discriminant model
// (equal priors, shrunk covariance) trained on the reference. A set of samples is compared with the regional background from the same survey, because
// ordinary rock also gets assigned to some deposit type by any such model: what carries the signal is how much MORE a lead resembles a type than the background does.
// Cross-validated on the reference deposits themselves (about 50% correct first guess and 73% within the first three across 23 groups, against 4% by chance).

type Out = { content: string; evidence?: Evidence[]; datasets?: Dataset[] };

export const CANDIDATES = [
  "Ag", "As", "Ba", "Bi", "Cd", "Ce", "Co", "Cr", "Cs", "Cu", "Dy", "Er", "Eu", "Ga", "Gd", "Ge", "Hf", "Ho", "La", "Lu", "Mo", "Nb", "Nd", "Ni", "Pb", "Pr", "Rb", "Sb", "Sc", "Sm", "Sn",
  "Sr", "Tb", "Th", "Tl", "Tm", "U", "V", "W", "Y", "Yb", "Zn", "Zr",
];
export const MERGE: Record<string, string> = {
  Carbonatite: "Carbonatite / peralkaline igneous",
  "Peralkaline igneous": "Carbonatite / peralkaline igneous",
  "Ultramafic and (or) mafic-layered intrusion": "Mafic-ultramafic intrusion",
  "Ultramafic and (or) mafic intrusion": "Mafic-ultramafic intrusion",
  "Collapse breccia pipe": "Breccia pipe",
};
export const MIN_DEPOSITS = 10;
const SHRINK = 0.2;
export const TEMPERATURE = 2;
const MAX_SAMPLES = 3000;

// Surveys with multi-element ROCK data (the reference is rock chemistry, so stream sediments and soils are not compared).
export const SOURCES: Record<string, { label: string; types: string[] | null }> = {
  GREENLAND_GEUS: { label: "Greenland (GEUS) rock samples", types: ["Rock Sample (unspecified)"] },
  SWEDEN_SGU_LITHOGEOCHEMISTRY: { label: "Sweden (SGU) rock and drill-core samples", types: ["Rock Sample (unspecified)", "Drill Core (unspecified)"] },
  USA_USGS_NGDB: { label: "USA (USGS) rock samples", types: ["Grab Rock Sample", "Composite Rock Sample", "Float Rock Sample", "Drill core grab sample", "Outcrop Sample"] },
  FINLAND_GTK_ROCK: { label: "Finland (GTK) rock samples", types: null },
  AUSTRALIA_TAS_MRT: { label: "Tasmania (MRT) rock and drill-core samples", types: ["Rock Sample (unspecified)", "Outcrop Sample", "Float Rock Sample", "Drill Core (unspecified)"] },
  CANADA_QC_SIGEOM: { label: "Québec (SIGÉOM) rock and drill-core samples", types: ["Outcrop Sample", "Rock Sample (unspecified)", "Float Rock Sample", "Drill Core (unspecified)"] },
  CANADA_NRCAN_CDOGS: { label: "Canada (GSC CDoGS) rock samples", types: ["Rock Sample (unspecified)", "Select Rock Sample"] },
};

export type Reference = { uid: string; group: string; vals: Record<string, number> }[];
let refCache: { at: number; ref: Reference } | null = null;

export async function loadReference(): Promise<Reference> {
  if (refCache && Date.now() - refCache.at < 12 * 3600_000) return refCache.ref;
  const sql = `
WITH r AS (
  SELECT d.deposit_uid, d.deposit_group, a.element_symbol el, r.sample_id,
         CASE r.unit_code WHEN 'ppm' THEN r.value WHEN 'ppb' THEN r.value / 1000.0 END v
  FROM geochem.analytical_results_global_deposit_geochem_ga r
  JOIN geochem.result_classifications_global_deposit_geochem_ga c ON c.result_id = r.result_id AND c.source_system = r.source_system
  JOIN geochem.sample_deposit_context d ON d.sample_id = r.sample_id
  JOIN geochem.analytes a ON a.analyte_id = r.analyte_id
  WHERE r.is_active AND c.use_in_statistics AND r.unit_code IN ('ppm', 'ppb') AND NOT a.is_oxide AND r.value > 0
    AND a.element_symbol IN (${CANDIDATES.map((e) => `'${e}'`).join(",")})
    AND r.method_code !~* '(_AR|AR_|^AA_|AAS|_P$|unknown|CALC|NA_LC)'
), s AS (SELECT deposit_uid, deposit_group, el, sample_id, percentile_cont(0.5) WITHIN GROUP (ORDER BY v) v FROM r GROUP BY 1, 2, 3, 4)
SELECT deposit_uid, deposit_group, el, percentile_cont(0.5) WITHIN GROUP (ORDER BY v) med FROM s GROUP BY 1, 2, 3`;
  const res = await runReadOnlyQuery(sql, 120000);
  const by = new Map<string, { group: string; vals: Record<string, number> }>();
  for (const r of res.rows) {
    const uid = String(r.deposit_uid);
    const g = MERGE[String(r.deposit_group)] ?? String(r.deposit_group);
    const e = by.get(uid) ?? { group: g, vals: {} };
    e.vals[String(r.el)] = Number(r.med);
    by.set(uid, e);
  }
  const ref = [...by.entries()].map(([uid, v]) => ({ uid, group: v.group, vals: v.vals })).sort((a, b) => (a.uid < b.uid ? -1 : 1));
  refCache = { at: Date.now(), ref };
  return ref;
}

// ---- small linear algebra ---------------------------------------------------------------------------------------------------------------------
export const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
export const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
function invert(M: number[][]): number[][] {
  const n = M.length;
  const A = M.map((r, i) => [...r, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    const d = A[c][c] || 1e-12;
    for (let j = 0; j < 2 * n; j++) A[c][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = A[r][c];
      if (f === 0) continue;
      for (let j = 0; j < 2 * n; j++) A[r][j] -= f * A[c][j];
    }
  }
  return A.map((r) => r.slice(n));
}
export const clr = (logs: number[]) => {
  const m = mean(logs);
  return logs.map((x) => (x - m) * Math.LN10);
};

export type Model = { classes: string[]; mu: number[][]; coef: number[][]; icpt: number[]; P: number[][] };

export function train(X: number[][], y: number[], K: number): Model {
  const p = X[0].length;
  const mu: number[][] = [];
  const cov: number[][] = Array.from({ length: p }, () => new Array(p).fill(0));
  for (let g = 0; g < K; g++) {
    const rows = X.filter((_, i) => y[i] === g);
    const m = Array.from({ length: p }, (_, j) => mean(rows.map((r) => r[j])));
    mu.push(m);
    const sd = m.map((mj, j) => Math.sqrt(mean(rows.map((r) => (r[j] - mj) ** 2))) || 1);
    const Z = rows.map((r) => r.map((v, j) => (v - m[j]) / sd[j]));
    for (let a = 0; a < p; a++)
      for (let b = 0; b < p; b++) {
        let c = mean(Z.map((z) => z[a] * z[b]));
        c = (1 - SHRINK) * c + (a === b ? SHRINK : 0);
        cov[a][b] += (c * sd[a] * sd[b]) / K;
      }
  }
  const P = invert(cov);
  const coef = mu.map((m) => P.map((row) => row.reduce((s, v, j) => s + v * m[j], 0)));
  const icpt = mu.map((m, g) => -0.5 * m.reduce((s, v, j) => s + v * coef[g][j], 0) + Math.log(1 / K));
  return { classes: [], mu, coef, icpt, P };
}
export const scores = (m: Model, x: number[]) => m.coef.map((c, g) => c.reduce((s, v, j) => s + v * x[j], 0) + m.icpt[g]);
export const softmax = (d: number[], T: number) => {
  const mx = Math.max(...d);
  const e = d.map((v) => Math.exp((v - mx) / T));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / s);
};
const mahal2 = (m: Model, x: number[], g: number) => {
  const d = x.map((v, j) => v - m.mu[g][j]);
  return d.reduce((s, dj, a) => s + dj * m.P[a].reduce((t, pv, b) => t + pv * d[b], 0), 0);
};

type RefMatrix = { X: number[][]; y: number[]; classes: string[]; colMedian: number[]; counts: Record<string, number> };

function refMatrix(ref: Reference, els: string[]): RefMatrix {
  // A type is kept if the reference holds at least MIN_DEPOSITS deposits of it in all, and at least 6 of them have most of the elements in use.
  const all: Record<string, number> = {};
  for (const d of ref) all[d.group] = (all[d.group] ?? 0) + 1;
  const usable = ref.filter((d) => els.filter((e) => d.vals[e] > 0).length >= 0.7 * els.length);
  const counts: Record<string, number> = {};
  for (const d of usable) counts[d.group] = (counts[d.group] ?? 0) + 1;
  const classes = Object.keys(counts)
    .filter((g) => all[g] >= MIN_DEPOSITS && counts[g] >= 6 && g.trim())
    .sort((a, b) => counts[b] - counts[a]);
  const kept = usable.filter((d) => classes.includes(d.group));
  const colMedian = els.map((e) => median(kept.map((d) => d.vals[e]).filter((v) => v > 0).map(Math.log10)));
  const X = kept.map((d) => clr(els.map((e, j) => (d.vals[e] > 0 ? Math.log10(d.vals[e]) : colMedian[j]))));
  return { X, y: kept.map((d) => classes.indexOf(d.group)), classes, colMedian, counts };
}

function crossValidate(rm: RefMatrix): { top1: number; top3: number } {
  const K = rm.classes.length;
  let t1 = 0;
  let t3 = 0;
  for (let f = 0; f < 5; f++) {
    const tr = rm.X.map((_, i) => i).filter((i) => i % 5 !== f);
    const te = rm.X.map((_, i) => i).filter((i) => i % 5 === f);
    const m = train(tr.map((i) => rm.X[i]), tr.map((i) => rm.y[i]), K);
    for (const i of te) {
      const order = scores(m, rm.X[i]).map((v, g) => [v, g]).sort((a, b) => b[0] - a[0]);
      if (order[0][1] === rm.y[i]) t1++;
      if (order.slice(0, 3).some((o) => o[1] === rm.y[i])) t3++;
    }
  }
  return { top1: t1 / rm.X.length, top3: t3 / rm.X.length };
}

// ---- samples ------------------------------------------------------------------------------------------------------------------------------------
export type Filter = { source_system: string; bbox?: number[]; element?: string; min_ppm?: number };

export function whereFor(f: Filter, withElement: boolean): string {
  const cfg = SOURCES[f.source_system];
  const w = [`source_system = '${f.source_system}'`, "n_values >= 20"];
  if (cfg.types) w.push(`sample_type_name IN (${cfg.types.map((t) => `'${t}'`).join(",")})`);
  if (f.bbox && f.bbox.length === 4 && f.bbox.every((n) => Number.isFinite(n))) w.push(`lon BETWEEN ${f.bbox[0]} AND ${f.bbox[2]} AND lat BETWEEN ${f.bbox[1]} AND ${f.bbox[3]}`);
  if (withElement && f.element && Number.isFinite(f.min_ppm)) w.push(`${f.element.toLowerCase()}_t >= ${Number(f.min_ppm)}`);
  return w.join(" AND ");
}

async function pull(where: string): Promise<number[][]> {
  const cols = CANDIDATES.map((e) => `${e.toLowerCase()}_t`).join(", ");
  const r = await runReadOnlyQuery(`SELECT ${cols} FROM geochem.sample_chemistry_wide WHERE ${where} ORDER BY random() LIMIT ${MAX_SAMPLES}`, MAX_SAMPLES);
  return r.rows.map((row) => CANDIDATES.map((e) => (row[`${e.toLowerCase()}_t`] === null ? NaN : Number(row[`${e.toLowerCase()}_t`]))));
}

const pct = (x: number) => Math.round(x * 1000) / 10;

export async function depositFingerprint(input: Record<string, unknown>): Promise<Out> {
  const src = String(input.source_system ?? "");
  if (!SOURCES[src]) {
    return { content: `The deposit fingerprint needs multi-element ROCK data. It is available for: ${Object.entries(SOURCES).map(([k, v]) => `${k} (${v.label})`).join("; ")}. Stream sediments and soils are not compared because the reference is rock chemistry.` };
  }
  const lf = (input.lead_filter ?? {}) as { element?: string; min_ppm?: number };
  const element = lf.element ? String(lf.element) : undefined;
  if (element && !CANDIDATES.includes(element.charAt(0).toUpperCase() + element.slice(1).toLowerCase())) return { content: `lead_filter.element must be one of: ${CANDIDATES.join(", ")}.` };
  const bbox = Array.isArray(input.bbox) ? (input.bbox as unknown[]).map(Number) : undefined;
  const bgBbox = Array.isArray(input.background_bbox) ? (input.background_bbox as unknown[]).map(Number) : undefined;
  const el = element ? element.charAt(0).toUpperCase() + element.slice(1).toLowerCase() : undefined;
  const leadFilter: Filter = { source_system: src, bbox, element: el, min_ppm: Number(lf.min_ppm) };
  const bgFilter: Filter = { source_system: src, bbox: bgBbox };

  const [ref, lead] = await Promise.all([loadReference(), pull(whereFor(leadFilter, true))]);
  if (lead.length < 10) return { content: `Only ${lead.length} rock samples match (at least 10 are needed for a fingerprint). Widen the area or loosen the element filter.` };

  const frac = (rows: number[][], j: number) => rows.filter((r) => r[j] > 0).length / rows.length;
  // The elements are chosen from what the LEAD samples have; the background is then drawn from samples that have most of the same elements (a survey's
  // routine rock suite and its enriched-element suite often differ, and a background without Zr or Nb would hide exactly the elements that separate types).
  const use = CANDIDATES.map((_, j) => j).filter((j) => frac(lead, j) >= 0.5);
  const els = use.map((j) => CANDIDATES[j]);
  if (els.length < 10) {
    return { content: `Only ${els.length} elements are measured in at least half of the lead samples (${els.join(", ") || "none"}); at least 10 are needed, so a deposit fingerprint would not be reliable for this survey and area.` };
  }
  const need = Math.ceil(0.8 * els.length);
  const bgWhere = whereFor(bgFilter, false) + ` AND (${els.map((e) => `(${e.toLowerCase()}_t IS NOT NULL)::int`).join(" + ")}) >= ${need}`;
  const bg = await pull(bgWhere);
  const complete = (rows: number[][]) => rows.filter((r) => use.filter((j) => r[j] > 0).length >= 0.8 * use.length);
  const leadOk = complete(lead);
  const bgOk = complete(bg);
  if (leadOk.length < 10) return { content: "Too few lead samples have most of the elements measured for a fingerprint." };
  if (bgOk.length < 30) return { content: `Only ${bgOk.length} background rock samples in the survey have most of these ${els.length} elements measured, so there is no fair background to compare with; widen background_bbox or leave it out.` };

  const rm = refMatrix(ref, els);
  const K = rm.classes.length;
  const cv = crossValidate(rm);
  const model = train(rm.X, rm.y, K);

  const toClr = (r: number[]) => clr(use.map((j, k) => (r[j] > 0 ? Math.log10(r[j]) : rm.colMedian[k])));
  const leadC = leadOk.map(toClr);
  const bgC = bgOk.map(toClr);
  const vote = (rows: number[][]) => {
    const v = new Array(K).fill(0);
    for (const r of rows) v[scores(model, r).reduce((b, s, g, a) => (s > a[b] ? g : b), 0)]++;
    return v.map((n) => n / rows.length);
  };
  const leadShare = vote(leadC);
  const bgShare = vote(bgC);
  const medVec = (rows: number[][]) => els.map((_, j) => median(rows.map((r) => r[j])));
  const leadMed = medVec(leadC);
  const bgMed = medVec(bgC);
  const post = softmax(scores(model, leadMed), TEMPERATURE);
  const ownD2 = rm.X.map((x, i) => mahal2(model, x, rm.y[i])).sort((a, b) => a - b);
  const p95 = ownD2[Math.floor(0.95 * (ownD2.length - 1))];
  const nearest = model.mu.map((_, g) => mahal2(model, leadMed, g)).reduce((b, d, g, a) => (d < a[b] ? g : b), 0);
  const nearestD2 = mahal2(model, leadMed, nearest);

  const order = rm.classes.map((_, g) => g).sort((a, b) => leadShare[b] - bgShare[b] - (leadShare[a] - bgShare[a]));
  const best = order[0];
  // elements behind the best type: where the leads differ from the background, and whether that points the way the type does
  const typeMean = model.mu[best].map((v, j) => v - mean(model.mu.map((m) => m[j])));
  const raw = (rows: number[][], j: number) => median(rows.filter((r) => r[use[j]] > 0).map((r) => r[use[j]]));
  const drivers = els
    .map((e, j) => ({ e, d: leadMed[j] - bgMed[j], fold: raw(leadOk, j) / raw(bgOk, j), agrees: Math.sign(leadMed[j] - bgMed[j]) === Math.sign(typeMean[j]) }))
    .sort((a, b) => Math.abs(b.d) - Math.abs(a.d))
    .slice(0, 6);

  const rows = order.slice(0, 10).map((g) => [rm.classes[g], rm.counts[rm.classes[g]], pct(leadShare[g]), pct(bgShare[g]), pct(leadShare[g] - bgShare[g]), pct(post[g])]);
  const dataset: Dataset = {
    id: "fingerprint-" + Date.now().toString(36),
    title: "Deposit fingerprint: leads against regional background",
    columns: ["Deposit type", "Reference deposits", "Share of lead samples (%)", "Share of background samples (%)", "Difference (points)", "Relative match of the median lead (%)"],
    rows,
    bars: {
      unit: "% of samples whose chemistry is closest to this type",
      legend: ["Lead samples", "Regional background"],
      items: order.slice(0, 8).map((g) => ({ label: rm.classes[g], value: pct(leadShare[g]), compare: pct(bgShare[g]) })),
    },
  };
  const credits = [...creditsForSource(src), "Geoscience Australia / Critical Minerals Mapping Initiative with the Geological Survey of Canada and the USGS, Critical Minerals in Ores - geochemistry database (CC BY 4.0)"];
  const evidence: Evidence[] = [{ kind: "data", label: `Deposit-type fingerprint: ${credits.join("; ")}` }];

  const content = JSON.stringify({
    what: "Compares the chemistry of rock samples with known deposit types, relative to the regional background",
    survey: SOURCES[src].label,
    lead: { samples_used: leadOk.length, samples_matching_filter_shown: lead.length, filter: el ? `${el} >= ${lf.min_ppm} ppm` : "none", area: bbox ?? "whole survey" },
    background: { samples_used: bgOk.length, area: bgBbox ?? "whole survey" },
    elements_used: els,
    ranked_types: order.slice(0, 6).map((g) => ({
      type: rm.classes[g],
      reference_deposits: rm.counts[rm.classes[g]],
      lead_share_pct: pct(leadShare[g]),
      background_share_pct: pct(bgShare[g]),
      difference_points: pct(leadShare[g] - bgShare[g]),
      relative_match_median_lead_pct: pct(post[g]),
      small_reference: rm.counts[rm.classes[g]] < 15,
    })),
    elements_behind_best_type: { type: rm.classes[best], items: drivers.map((d) => ({ element: d.e, lead_vs_background_fold: Math.round(d.fold * 100) / 100, points_towards_type: d.agrees })) },
    does_not_resemble_any_type_well: nearestD2 > p95,
    reference_accuracy: { known_deposits: rm.X.length, types: K, correct_first_guess_pct: pct(cv.top1), correct_in_top_three_pct: pct(cv.top3), chance_first_guess_pct: pct(1 / K) },
    how_to_read:
      "Each sample is assigned to the deposit type its chemistry is closest to. Any rock, even ordinary background, gets assigned to some type, so what matters is the DIFFERENCE between the lead and the background shares. A screening aid for ideas to check, not a classification: never state that a lead IS a deposit of a type. Say the accuracy on known deposits, which element set was used, and that types needing elements that were not measured (for example Cu, Mo, Au, Ag, Pb or Sn) cannot be told apart here. The reference is ore and altered rock, the leads are regional rock samples.",
    credit: credits,
  });
  return { content, evidence, datasets: [dataset] };
}
