import { runReadOnlyQuery } from "@/lib/db";
import { creditsForSource } from "@/lib/licence";
import type { Dataset, Evidence } from "@/lib/types";
import { CANDIDATES, MERGE, MIN_DEPOSITS, TEMPERATURE, clr, depositFingerprint, loadReference, mean, median, scores, softmax, train, whereFor, type Filter, type Reference } from "@/lib/fingerprint";

// What to assay next: for a lead whose deposit-type signature is ambiguous, which element NOT yet measured on the lead samples would best tell the leading deposit types apart?
// Answered from the reference deposits themselves, not from the lead: for each candidate element the same discriminant model is cross-validated on the reference deposits
// that have the element, with and without it, on exactly the same deposits and folds, so the difference is a paired gain in first-guess accuracy with an error bar.
// The measure is the average probability the model gives to the correct type. Because many elements are tried, the 'clear gain' test is Bonferroni-adjusted for the number of elements tested,
// otherwise about one in twenty useless elements would look useful. Done twice: among the leading types for this lead (default: the three with the biggest difference from the regional background), and across all types.

type Out = { content: string; evidence?: Evidence[]; datasets?: Dataset[] };

const FOLDS = 5;
const MIN_ROWS = 40;
const MIN_PER_CLASS = 6;
const pts = (x: number) => Math.round(x * 1000) / 10;

// Standard normal quantile (Abramowitz and Stegun 26.2.23), for the multiple-testing adjustment.
function zFor(tail: number): number {
  const t = Math.sqrt(-2 * Math.log(tail));
  return t - (2.515517 + 0.802853 * t + 0.010328 * t * t) / (1 + 1.432788 * t + 0.189269 * t * t + 0.001308 * t * t * t);
}

type Row = { group: string; vals: Record<string, number> };

// Deterministic 5-fold cross-validation; returns, per row, the probability the model gives to the correct type (a smoother measure than right or wrong, so a real gain
// shows above the noise with only a few hundred deposits).
function cvProb(X: number[][], y: number[], K: number): number[] {
  const out = new Array(X.length).fill(0);
  for (let f = 0; f < FOLDS; f++) {
    const tr = X.map((_, i) => i).filter((i) => i % FOLDS !== f);
    const te = X.map((_, i) => i).filter((i) => i % FOLDS === f);
    const m = train(tr.map((i) => X[i]), tr.map((i) => y[i]), K);
    for (const i of te) out[i] = softmax(scores(m, X[i]), TEMPERATURE)[y[i]];
  }
  return out;
}

function matrix(rows: Row[], els: string[], classes: string[]) {
  const kept = rows.filter((d) => classes.includes(d.group));
  const colMedian = els.map((e) => median(kept.map((d) => d.vals[e]).filter((v) => v > 0).map(Math.log10)));
  const X = kept.map((d) => clr(els.map((e, j) => (d.vals[e] > 0 ? Math.log10(d.vals[e]) : colMedian[j]))));
  return { X, y: kept.map((d) => classes.indexOf(d.group)) };
}

// Paired gain of adding one element, on the reference deposits that have it, restricted to the given classes.
function pairedGain(ref: Row[], els: string[], extra: string, classes: string[] | null): { gain: number; se: number; n: number; baseline: number; chance: number; classes: string[] } | null {
  const have = ref.filter((d) => d.vals[extra] > 0 && els.filter((e) => d.vals[e] > 0).length >= 0.7 * els.length);
  const counts: Record<string, number> = {};
  for (const d of have) counts[d.group] = (counts[d.group] ?? 0) + 1;
  const total: Record<string, number> = {};
  for (const d of ref) total[d.group] = (total[d.group] ?? 0) + 1;
  const cls = (classes ?? Object.keys(counts).filter((g) => total[g] >= MIN_DEPOSITS && g.trim())).filter((g) => (counts[g] ?? 0) >= MIN_PER_CLASS);
  if (classes && cls.length < Math.min(2, classes.length)) return null;
  if (cls.length < 2) return null;
  const rows = have.filter((d) => cls.includes(d.group));
  if (rows.length < MIN_ROWS) return null;
  const a = matrix(rows, els, cls);
  const b = matrix(rows, [...els, extra], cls);
  const ca = cvProb(a.X, a.y, cls.length);
  const cb = cvProb(b.X, b.y, cls.length);
  const diff = cb.map((v, i) => v - ca[i]);
  const g = mean(diff);
  const sd = Math.sqrt(mean(diff.map((d) => (d - g) ** 2)));
  return { gain: g, se: sd / Math.sqrt(diff.length), n: rows.length, baseline: mean(ca), chance: 1 / cls.length, classes: cls };
}

export async function assayNext(input: Record<string, unknown>): Promise<Out> {
  const fpOut = await depositFingerprint(input);
  let fp: {
    survey: string;
    elements_used: string[];
    lead: { samples_used: number; filter: string };
    ranked_types: { type: string; difference_points: number; reference_deposits: number }[];
    reference_accuracy: { correct_first_guess_pct: number };
  };
  try {
    fp = JSON.parse(fpOut.content);
  } catch {
    return { content: `A deposit fingerprint has to be possible before the next assay can be suggested. ${fpOut.content}` };
  }
  const src = String(input.source_system);
  const els = fp.elements_used;
  const lf = (input.lead_filter ?? {}) as { element?: string; min_ppm?: number };
  const el = lf.element ? String(lf.element).charAt(0).toUpperCase() + String(lf.element).slice(1).toLowerCase() : undefined;
  const bbox = Array.isArray(input.bbox) ? (input.bbox as unknown[]).map(Number) : undefined;
  const leadFilter: Filter = { source_system: src, bbox, element: el, min_ppm: Number(lf.min_ppm) };

  const requested = Array.isArray(input.types) ? (input.types as unknown[]).map(String) : [];
  const known = new Set(fp.ranked_types.map((t) => t.type));
  const focus = (requested.length ? requested.filter((t) => known.has(t)) : fp.ranked_types.slice(0, 3).map((t) => t.type)).slice(0, 4);
  if (focus.length < 2) return { content: `Need at least two deposit types to tell apart. Types available from this lead: ${[...known].join("; ")}.` };

  const reference: Reference = await loadReference();
  const ref: Row[] = reference.map((d) => ({ group: MERGE[d.group] ?? d.group, vals: d.vals }));
  const unmeasured = CANDIDATES.filter((e) => !els.includes(e));

  // How much of the lead is already measured for each of these elements.
  const cols = unmeasured.map((e) => `count(${e.toLowerCase()}_t) AS ${e.toLowerCase()}_n`).join(", ");
  const cov = await runReadOnlyQuery(`SELECT count(*) AS n, ${cols} FROM geochem.sample_chemistry_wide WHERE ${whereFor(leadFilter, true)}`, 5);
  const nLead = Number(cov.rows[0]?.n ?? 0);
  const measuredPct = (e: string) => (nLead ? Math.round((100 * Number(cov.rows[0]?.[`${e.toLowerCase()}_n`] ?? 0)) / nLead) : 0);

  const results = unmeasured
    .map((e) => ({ e, f: pairedGain(ref, els, e, focus), a: pairedGain(ref, els, e, null), have: ref.filter((d) => d.vals[e] > 0).length }))
    .filter((r) => r.f);
  const ranked = results.sort((x, y) => y.f!.gain - x.f!.gain);
  const zAdj = zFor(0.05 / (2 * Math.max(1, results.length)));
  const lo = (g: { gain: number; se: number }) => g.gain - zAdj * g.se;
  const hi = (g: { gain: number; se: number }) => g.gain + zAdj * g.se;
  const clear = (g: { gain: number; se: number }) => lo(g) > 0;
  const top = ranked.slice(0, 8);
  const skipped = unmeasured.filter((e) => !results.some((r) => r.e === e));

  const rows = top.map((r) => [
    r.e,
    measuredPct(r.e),
    r.f!.n,
    pts(r.f!.gain),
    `${pts(lo(r.f!))} to ${pts(hi(r.f!))}`,
    r.a ? pts(r.a.gain) : null,
    clear(r.f!) ? "yes" : "not clearly",
  ]);
  const dataset: Dataset = {
    id: "assaynext-" + Date.now().toString(36),
    title: `Which extra element would best separate: ${focus.join(" / ")}`,
    columns: ["Element to add", "Already measured in these lead samples (%)", "Reference deposits tested", "Gain in confidence in the right type, among these types (points)", `Range, allowing for ${results.length} elements tried (points)`, "Gain across all types (points)", "Clear gain?"],
    rows,
    bars: { unit: "points gained in the probability given to the right type, among these types", legend: ["Gain"], items: top.map((r) => ({ label: r.e, value: Math.max(0, pts(r.f!.gain)) })) },
  };

  const clearOnes = ranked.filter((r) => clear(r.f!));
  const base = ranked[0]?.f;
  const credits = [...creditsForSource(src), "Geoscience Australia / Critical Minerals Mapping Initiative with the Geological Survey of Canada and the USGS, Critical Minerals in Ores - geochemistry database (CC BY 4.0)"];
  const content = JSON.stringify({
    what: "Which element, not yet measured on these lead samples, would best tell the leading deposit types apart, tested on the known reference deposits",
    survey: fp.survey,
    lead: { samples_matching: nLead, filter: fp.lead.filter },
    types_to_separate: focus,
    elements_already_used: els,
    chance_probability_on_right_type_pct: base ? pts(base.chance) : null,
    baseline_probability_on_right_type_pct_among_these_types: base ? pts(base.baseline) : null,
    elements_tried: results.length,
    suggestions: top.slice(0, 6).map((r) => ({
      element: r.e,
      already_measured_in_pct_of_lead_samples: measuredPct(r.e),
      reference_deposits_tested: r.f!.n,
      gain_points_among_these_types: pts(r.f!.gain),
      gain_range_points_allowing_for_all_elements_tried: [pts(lo(r.f!)), pts(hi(r.f!))],
      gain_points_across_all_types: r.a ? pts(r.a.gain) : null,
      clear_gain: clear(r.f!),
    })),
    clear_gain_count: clearOnes.length,
    elements_not_testable: skipped,
    not_assessed: "Only the 43 trace elements in the reference set are tested. Gold, platinum-group elements, lithium, beryllium, selenium, tellurium and rhenium are not, and nor is the cost or the lab method of any assay.",
    how_to_read:
      "Each gain is how many percentage points the average probability given to the CORRECT type among the listed types rises on known reference deposits when that element is added (cross-validated on the same deposits with and without it). The range is widened for the number of elements tried, so that chance does not produce a false winner. " +
      "A gain whose range includes zero is NOT a recommendation. If none is clear, say plainly that the elements already measured are about as good as this data can do, and that no single extra element would clearly help. " +
      "These are single-element additions, not a combined package. The reference is ore and altered rock, the leads are regional rock samples, and the model only separates types it was trained on: say that this guides what to measure to separate the types, it does not show the lead is any of them. " +
      "If an element is already measured in part of the lead samples, the cheapest step may be to extend it to the rest. Ask the lab whether the digestion is total or partial for resistant minerals before relying on a result. Do not state costs or lab prices.",
    credit: credits,
  });
  return { content, evidence: [{ kind: "data", label: `What to assay next: ${credits.join("; ")}` }], datasets: [dataset] };
}
