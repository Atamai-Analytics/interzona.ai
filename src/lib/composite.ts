// Drill-intercept maths shared by the assistant's drill_intercepts tool (server) and the Drill intercepts page (browser): the element table
// (reporting forms, oxide factors, default cut-offs, exceptional-grade ceilings) and the Grade-Width Intercepts (OGWI) compositing.
// No database access here, so it can run in the browser.

export type Unit = "g/t" | "%" | "ppm";
export type Oxide = { code: string; elFrac: number };
export type ElDef = {
  name: string;
  reportAs: string; // the form grades are reported in, e.g. Li2O
  unit: Unit;
  toReport: number; // element mass -> reporting form (oxide factor)
  oxides: Oxide[]; // oxide (or compound) forms that can stand in for the element; elFrac = element mass fraction
  extraLocals?: Record<string, number>; // other local intercept codes -> element fraction
  cutoff?: number; // default cut-off in reporting units (composite mode)
  exceptional: number; // above this (reporting units) a grade is flagged for checking
};

const OX = (code: string, elFrac: number): Oxide => ({ code, elFrac });
export const ELEMENTS: Record<string, ElDef> = {
  Au: { name: "gold", reportAs: "Au", unit: "g/t", toReport: 1, oxides: [], cutoff: 0.5, exceptional: 500 },
  Ag: { name: "silver", reportAs: "Ag", unit: "g/t", toReport: 1, oxides: [], cutoff: 30, exceptional: 10000 },
  Pt: { name: "platinum", reportAs: "Pt", unit: "g/t", toReport: 1, oxides: [], cutoff: 0.5, exceptional: 300 },
  Pd: { name: "palladium", reportAs: "Pd", unit: "g/t", toReport: 1, oxides: [], cutoff: 0.5, exceptional: 300 },
  Cu: { name: "copper", reportAs: "Cu", unit: "%", toReport: 1, oxides: [], cutoff: 0.3, exceptional: 40 },
  Ni: { name: "nickel", reportAs: "Ni", unit: "%", toReport: 1, oxides: [OX("nio", 0.7858)], cutoff: 0.3, exceptional: 30 },
  Co: { name: "cobalt", reportAs: "Co", unit: "%", toReport: 1, oxides: [], cutoff: 0.05, exceptional: 20 },
  Zn: { name: "zinc", reportAs: "Zn", unit: "%", toReport: 1, oxides: [OX("zno", 0.8034)], cutoff: 1, exceptional: 60 },
  Pb: { name: "lead", reportAs: "Pb", unit: "%", toReport: 1, oxides: [], cutoff: 1, exceptional: 80 },
  Sn: { name: "tin", reportAs: "Sn", unit: "%", toReport: 1, oxides: [], cutoff: 0.2, exceptional: 50 },
  W: { name: "tungsten", reportAs: "WO3", unit: "%", toReport: 1.2611, oxides: [OX("wo3", 0.793)], cutoff: 0.1, exceptional: 50 },
  Mo: { name: "molybdenum", reportAs: "Mo", unit: "%", toReport: 1, oxides: [], extraLocals: { MoS2: 0.5994 }, cutoff: 0.05, exceptional: 40 },
  Li: { name: "lithium", reportAs: "Li2O", unit: "%", toReport: 2.1527, oxides: [OX("li2o", 0.4645)], cutoff: 0.5, exceptional: 7.5 },
  Nb: { name: "niobium", reportAs: "Nb2O5", unit: "%", toReport: 1.4305, oxides: [OX("nb2o5", 0.699)], cutoff: 0.2, exceptional: 30 },
  Ta: { name: "tantalum", reportAs: "Ta2O5", unit: "ppm", toReport: 1.2211, oxides: [OX("ta2o5", 0.819)], cutoff: 100, exceptional: 50000 },
  U: { name: "uranium", reportAs: "U3O8", unit: "%", toReport: 1.1792, oxides: [OX("u3o8", 0.848)], cutoff: 0.05, exceptional: 85 },
  V: { name: "vanadium", reportAs: "V2O5", unit: "%", toReport: 1.7852, oxides: [OX("v2o5", 0.5602), OX("v2o3", 0.6798)], cutoff: 0.2, exceptional: 20 },
  Ti: { name: "titanium", reportAs: "TiO2", unit: "%", toReport: 1.6681, oxides: [OX("tio2", 0.5995)], cutoff: 5, exceptional: 80 },
  Zr: { name: "zirconium", reportAs: "ZrO2", unit: "%", toReport: 1.3508, oxides: [OX("zro2", 0.7403)], cutoff: 0.5, exceptional: 60 },
  Cr: { name: "chromium", reportAs: "Cr2O3", unit: "%", toReport: 1.4616, oxides: [OX("cr2o3", 0.6842)], cutoff: 5, exceptional: 65 },
  Fe: { name: "iron", reportAs: "Fe", unit: "%", toReport: 1, oxides: [OX("fe2o3", 0.6994), OX("feto3", 0.6994)], extraLocals: { Fe2O3t: 0.6994, Fe2O3v: 0.6994 }, cutoff: 20, exceptional: 72 },
  Mn: { name: "manganese", reportAs: "Mn", unit: "%", toReport: 1, oxides: [OX("mno", 0.7745), OX("mno2", 0.6319)], cutoff: 5, exceptional: 70 },
  P: { name: "phosphate", reportAs: "P2O5", unit: "%", toReport: 2.2914, oxides: [OX("p2o5", 0.4364)], cutoff: 3, exceptional: 45 },
  Th: { name: "thorium", reportAs: "Th", unit: "ppm", toReport: 1, oxides: [OX("tho2", 0.8788)], exceptional: 300000 },
  Y: { name: "yttrium", reportAs: "Y", unit: "ppm", toReport: 1, oxides: [OX("y2o3", 0.7874)], exceptional: 200000 },
  La: { name: "lanthanum", reportAs: "La", unit: "ppm", toReport: 1, oxides: [], exceptional: 300000 },
  Ce: { name: "cerium", reportAs: "Ce", unit: "ppm", toReport: 1, oxides: [], exceptional: 300000 },
  Nd: { name: "neodymium", reportAs: "Nd", unit: "ppm", toReport: 1, oxides: [], exceptional: 200000 },
  Pr: { name: "praseodymium", reportAs: "Pr", unit: "ppm", toReport: 1, oxides: [], exceptional: 100000 },
  Dy: { name: "dysprosium", reportAs: "Dy", unit: "ppm", toReport: 1, oxides: [], exceptional: 50000 },
  Be: { name: "beryllium", reportAs: "Be", unit: "ppm", toReport: 1, oxides: [], exceptional: 50000 },
  Bi: { name: "bismuth", reportAs: "Bi", unit: "ppm", toReport: 1, oxides: [], exceptional: 300000 },
  Sb: { name: "antimony", reportAs: "Sb", unit: "ppm", toReport: 1, oxides: [], exceptional: 500000 },
  As: { name: "arsenic", reportAs: "As", unit: "ppm", toReport: 1, oxides: [], exceptional: 500000 },
  C: { name: "graphite", reportAs: "C (graphitic)", unit: "%", toReport: 1, oxides: [], extraLocals: { Cgraph: 1 }, cutoff: 2, exceptional: 60 },
};
export const ALIASES: Record<string, string> = {
  gold: "Au", silver: "Ag", platinum: "Pt", palladium: "Pd", copper: "Cu", nickel: "Ni", cobalt: "Co", zinc: "Zn", lead: "Pb", tin: "Sn", tungsten: "W",
  molybdenum: "Mo", lithium: "Li", niobium: "Nb", tantalum: "Ta", uranium: "U", vanadium: "V", titanium: "Ti", zirconium: "Zr", chromium: "Cr", chromite: "Cr",
  iron: "Fe", manganese: "Mn", phosphate: "P", phosphorus: "P", thorium: "Th", yttrium: "Y", lanthanum: "La", cerium: "Ce", neodymium: "Nd",
  praseodymium: "Pr", dysprosium: "Dy", beryllium: "Be", bismuth: "Bi", antimony: "Sb", arsenic: "As", graphite: "C", carbon: "C",
  li2o: "Li", wo3: "W", u3o8: "U", v2o5: "V", nb2o5: "Nb", ta2o5: "Ta", tio2: "Ti", zro2: "Zr", cr2o3: "Cr", p2o5: "P", cgraph: "C",
};

export function resolveElement(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const k = ALIASES[s.toLowerCase()] ?? (s.charAt(0).toUpperCase() + s.slice(1).toLowerCase());
  return ELEMENTS[k] ? k : null;
}

export const r = (x: number, d = 2) => {
  if (!Number.isFinite(x)) return x;
  const a = Math.abs(x);
  const dd = a >= 100 ? 0 : a >= 10 ? 1 : a >= 1 ? d : a >= 0.1 ? 3 : 4;
  return Math.round(x * 10 ** dd) / 10 ** dd;
};
export const unitLabel = (d: ElDef) => (d.unit === "g/t" ? `g/t ${d.reportAs}` : d.unit === "%" ? `% ${d.reportAs}` : `ppm ${d.reportAs}`);
export const gxlLabel = (d: ElDef) => (d.unit === "g/t" ? `gram-metres (g/t ${d.reportAs} x m)` : `${d.unit === "%" ? "percent-metres" : "ppm-metres"} (${unitLabel(d)} x m)`);
// element ppm -> reporting units
export const fromPpm = (d: ElDef, ppm: number) => (ppm * d.toReport) / (d.unit === "%" ? 10000 : 1);
export const toPpm = (d: ElDef, rep: number) => (rep * (d.unit === "%" ? 10000 : 1)) / d.toReport;

export const PRICE_UNITS: Record<string, number> = { "$/g": 1, "$/oz": 31.1035, "$/kg": 1000, "$/lb": 453.592, "$/t": 1e6 }; // grams per unit

export type Seg = { from: number; to: number; g: number; g2: number; sampled: boolean; assayed: boolean };
export type Comp = { from: number; to: number; len: number; grade: number; grade2: number; eq: number; nSamples: number; dilutionM: number; unassayedM: number; maxSample: number; maxSample2: number };

/** OGWI compositing on one hole. `segs` are sorted, non-overlapping, with unsampled gaps already inserted as zero-grade segments. Grades in `eq` units. */
export function composites(segs: Seg[], gradeOf: (s: Seg) => number, cutoff: number, minWidth: number, maxDil: number): Comp[] {
  const out: Comp[] = [];
  const n = segs.length;
  const L = (s: Seg) => s.to - s.from;
  let i = 0;
  while (i < n) {
    if (!(segs[i].sampled && gradeOf(segs[i]) >= cutoff)) {
      i++;
      continue;
    }
    let end = i;
    let sum = gradeOf(segs[i]) * L(segs[i]);
    let len = L(segs[i]);
    for (;;) {
      let k = end + 1;
      let dil = 0;
      while (k < n && !(segs[k].sampled && gradeOf(segs[k]) >= cutoff)) {
        dil += L(segs[k]);
        k++;
      }
      if (k >= n || dil > maxDil + 1e-9) break;
      let s2 = sum, l2 = len;
      for (let j = end + 1; j <= k; j++) {
        s2 += gradeOf(segs[j]) * L(segs[j]);
        l2 += L(segs[j]);
      }
      if (s2 / l2 < cutoff) break;
      sum = s2;
      len = l2;
      end = k;
    }
    if (len >= minWidth - 1e-9) {
      const part = segs.slice(i, end + 1);
      const wsum = (f: (s: Seg) => number) => part.reduce((a, s) => a + f(s) * L(s), 0);
      out.push({
        from: segs[i].from,
        to: segs[end].to,
        len,
        grade: wsum((s) => s.g) / len,
        grade2: wsum((s) => s.g2) / len,
        eq: sum / len,
        nSamples: part.filter((s) => s.sampled).length,
        dilutionM: part.filter((s) => gradeOf(s) < cutoff).reduce((a, s) => a + L(s), 0),
        unassayedM: part.filter((s) => !s.assayed).reduce((a, s) => a + L(s), 0),
        maxSample: Math.max(...part.filter((s) => s.sampled).map((s) => s.g)),
        maxSample2: Math.max(...part.filter((s) => s.sampled).map((s) => s.g2)),
      });
    }
    i = end + 1;
  }
  return out;
}


/** One assay interval as loaded: grades in ELEMENT ppm (null = not assayed for that element), bdl = assayed but below detection. */
export type Interval = { from: number; to: number; g: number | null; g2?: number | null; bdl?: boolean; bdl2?: boolean };

/** Sorts a hole's intervals, skips intervals that overlap one already kept (re-assays, composites) and point samples, sets impossible grades
 *  (above maxPpm) to zero, and fills unsampled gaps with zero-grade segments, ready for composites(). */
export function buildSegments(intervals: Interval[], maxPpm: number): { segs: Seg[]; overlaps: number; impossible: number; pointSamples: number } {
  const rows = intervals.filter((x) => Number.isFinite(x.from) && Number.isFinite(x.to)).sort((a, b) => a.from - b.from || a.to - b.to);
  const segs: Seg[] = [];
  let lastTo = -Infinity, overlaps = 0, impossible = 0, pointSamples = 0;
  for (const s of rows) {
    if (!(s.to > s.from)) { pointSamples++; continue; }
    if (s.from < lastTo - 1e-6) { overlaps++; continue; }
    let g = s.g == null || s.g < 0 ? 0 : s.g;
    if (g > maxPpm) { impossible++; g = 0; }
    const g2 = s.g2 == null || s.g2 < 0 ? 0 : s.g2;
    if (Number.isFinite(lastTo) && s.from > lastTo + 1e-6) segs.push({ from: lastTo, to: s.from, g: 0, g2: 0, sampled: false, assayed: false });
    segs.push({ from: s.from, to: s.to, g, g2, sampled: true, assayed: s.g != null || Boolean(s.bdl) || s.g2 != null || Boolean(s.bdl2) });
    lastTo = s.to;
  }
  return { segs, overlaps, impossible, pointSamples };
}

export type CompositeOptions = { cutPpm: number; minWidth: number; maxDil: number; inclPpm?: number; ratio?: number };
export type HoleComposite = Comp & { incl: Comp | null };

/** Composites of one hole, each with its best 'including' part at the higher cut-off (if asked and shorter than the composite). Grades in ppm of the
 *  primary element; with a ratio, 'eq' is the primary-element equivalent (secondary ppm x ratio added). */
export function compositeHole(segs: Seg[], o: CompositeOptions): HoleComposite[] {
  const gradeOf = (s: Seg) => s.g + (o.ratio ? s.g2 * o.ratio : 0);
  return composites(segs, gradeOf, o.cutPpm, o.minWidth, o.maxDil).map((c) => {
    let incl: Comp | null = null;
    if (o.inclPpm !== undefined && o.inclPpm > o.cutPpm) {
      // Same minimum width (at most 1 m) and at most 1 m of dilution; only reported when it is a real part of the intercept (under 90 % of its length).
      const inner = composites(segs.filter((s) => s.from >= c.from - 1e-9 && s.to <= c.to + 1e-9), gradeOf, o.inclPpm, Math.min(o.minWidth, 1), Math.min(o.maxDil, 1));
      const best = inner.sort((a, b) => b.eq * b.len - a.eq * a.len)[0];
      if (best && best.len < 0.9 * c.len) incl = best;
    }
    return { ...c, incl };
  });
}

/** Ratio that turns secondary-element ppm into primary-element ppm of the same recovered value. Prices per unit of the metal; units are keys of PRICE_UNITS. */
export function equivalentRatio(p1: number, u1: string, rec1Pct: number, p2: number, u2: string, rec2Pct: number): number {
  return ((p2 / PRICE_UNITS[u2]) * (rec2Pct / 100)) / ((p1 / PRICE_UNITS[u1]) * (rec1Pct / 100));
}
