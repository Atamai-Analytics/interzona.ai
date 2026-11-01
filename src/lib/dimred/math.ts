// Maths for the Multivariate tools page (a browser rewrite of the old R Shiny apps "PrincipalComponentAnalysis" and
// "DimRedWithUMAPandtSNE"). Everything here runs in the browser: data processing mirrors the R apps' choices (plus
// detection-limit handling, row filters and a CLR log-ratio option), PCA matches prcomp(), t-SNE is an exact (not
// Barnes-Hut) implementation with Rtsne's defaults, and clustering is k-means or a Gaussian mixture fitted by EM, named
// as in R's mclust. Results will not match R's numbers exactly (different random streams; PCA signs may flip).

export type Cell = number | string | null;
/** lt[j] holds the rows whose value in column j was written "<x" (below the detection limit x). */
export type Table = { columns: string[]; rows: Cell[][]; numeric: boolean[]; lt: Set<number>[]; meta?: TableMeta };
/** Set for data loaded from the Interzona database: publisher credits, whether sample-level values are locked (GEUS), and whether
 *  below-detection values use the lowest detected value as a stand-in limit. */
export type TableMeta = { credits: string[]; restricted: boolean; bdlProxy: boolean };

// ---------- random numbers ----------

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(r: () => number): number {
  let u = 0;
  while (u === 0) u = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

// ---------- CSV ----------

const MISSING = new Set(["", "NA", "NaN", "N/A", "n/a", "-", "null", "NULL"]);
const LT = /^<\s*([-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?)$/;

export function parseCsv(text: string): Table {
  const records: string[][] = [];
  let field = "";
  let rec: string[] = [];
  let quoted = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { rec.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      rec.push(field); field = "";
      if (rec.length > 1 || rec[0] !== "") records.push(rec);
      rec = [];
    } else field += c;
  }
  if (field !== "" || rec.length > 0) { rec.push(field); records.push(rec); }
  if (records.length === 0) throw new Error("The file is empty.");

  const columns = records[0].map((c, i) => c.trim() || `V${i + 1}`);
  const raw = records.slice(1).filter((r) => r.some((v) => v.trim() !== ""));
  // A column is numeric when every value is a number, missing, or a "<x" detection-limit value.
  const numeric = columns.map((_, j) => {
    let seen = false;
    for (const r of raw) {
      const v = (r[j] ?? "").trim();
      if (MISSING.has(v)) continue;
      if (!Number.isFinite(Number(v)) && !LT.test(v)) return false;
      seen = true;
    }
    return seen;
  });
  const lt = columns.map(() => new Set<number>());
  const rows = raw.map((r, i) =>
    columns.map((_, j) => {
      const v = (r[j] ?? "").trim();
      if (MISSING.has(v)) return null;
      if (!numeric[j]) return v;
      const m = LT.exec(v);
      if (m) { lt[j].add(i); return Number(m[1]); }
      return Number(v);
    })
  );
  return { columns, rows, numeric, lt };
}

export function toCsv(columns: string[], rows: Cell[][]): string {
  const esc = (v: Cell) => {
    if (v === null || v === undefined) return "";
    const t = String(v);
    return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  return "﻿" + [columns, ...rows].map((r) => r.map(esc).join(",")).join("\r\n");
}

// ---------- processing ----------

export const FUNCTIONS = ["None", "CLR (centred log-ratio)", "log(x)", "log10(x)", "sqrt(x)", "abs(x)", "exp(x)", "ceiling(x)", "floor(x)", "trunc(x)", "sin(x)", "cos(x)", "tan(x)"] as const;
export const IMPUTE = ["None", "Remove all NA rows", "Impute with Mean", "Impute with Median", "Impute with 0"] as const;
export const SCALE = ["None", "Centre and scale", "Scale only", "Centre only"] as const;
export const BDL = ["Half the limit", "The limit", "Missing"] as const;

const FN: Record<string, (x: number) => number> = {
  "abs(x)": Math.abs, "ceiling(x)": Math.ceil, "cos(x)": Math.cos, "exp(x)": Math.exp, "floor(x)": Math.floor,
  "log(x)": Math.log, "log10(x)": Math.log10, "sin(x)": Math.sin, "sqrt(x)": Math.sqrt, "trunc(x)": Math.trunc, "tan(x)": Math.tan,
};

export type RowFilter = { col: string; min: number | null; max: number | null };

export type ProcessOptions = {
  dims: string[];
  classCol: string | null;
  limit: number | null;
  filters: RowFilter[];
  bdl: (typeof BDL)[number];
  impute: (typeof IMPUTE)[number];
  fn: (typeof FUNCTIONS)[number];
  scale: (typeof SCALE)[number];
  round: number | null;
};

export type Processed = {
  X: number[][]; // processed dimensions, one row per kept observation
  keep: number[]; // indices into the source rows
  classValues: Cell[]; // class value per kept row (null when no class)
  naCount: number; // missing values among the selected dimensions before imputation
  ltCount: number; // "<x" values among the selected dimensions
  filtered: number; // rows removed by the row filters
  warning: string | null;
};

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function processTable(t: Table, o: ProcessOptions): Processed {
  const idx = o.dims.map((d) => t.columns.indexOf(d));
  const ci = o.classCol ? t.columns.indexOf(o.classCol) : -1;
  let keep = t.rows.map((_, i) => i);
  if (o.limit && o.limit > 0) keep = keep.slice(0, o.limit);

  // Row filters are inclusive (the R app used strict < and >, which dropped values equal to the bounds).
  const before = keep.length;
  for (const f of o.filters) {
    const j = t.columns.indexOf(f.col);
    if (j < 0 || (f.min === null && f.max === null)) continue;
    keep = keep.filter((i) => {
      const v = t.rows[i][j];
      return typeof v === "number" && (f.min === null || v >= f.min) && (f.max === null || v <= f.max);
    });
  }
  const filtered = before - keep.length;

  let naCount = 0, ltCount = 0;
  for (const i of keep) for (const j of idx) { if (t.rows[i][j] === null) naCount++; else if (t.lt[j].has(i)) ltCount++; }
  const value = (i: number, j: number): number | null => {
    const v = t.rows[i][j] as number | null;
    if (v === null || !t.lt[j].has(i)) return v;
    return o.bdl === "Missing" ? null : o.bdl === "Half the limit" ? v / 2 : v;
  };
  if (o.bdl === "Missing") naCount += ltCount;

  // The R app ran na.omit() over every column; here only the selected dimensions and the class count.
  if (o.impute === "Remove all NA rows") keep = keep.filter((i) => idx.every((j) => value(i, j) !== null) && (ci < 0 || t.rows[i][ci] !== null));

  const cols = idx.map((j) => keep.map((i) => value(i, j)));
  if (o.impute === "Impute with Mean" || o.impute === "Impute with Median" || o.impute === "Impute with 0") {
    cols.forEach((c, k) => {
      const present = c.filter((v): v is number => v !== null);
      const fill = o.impute === "Impute with 0" ? 0 : present.length === 0 ? 0 : o.impute === "Impute with Mean" ? present.reduce((a, b) => a + b, 0) / present.length : median(present);
      cols[k] = c.map((v) => (v === null ? fill : v));
    });
  }

  let warning: string | null = null;
  let num = cols.map((c) => c.map((v) => (v === null ? NaN : v)));
  if (o.fn === "CLR (centred log-ratio)") {
    // CLR: log of each value minus the mean log of that row's selected values. Needs every value in the row to be positive.
    let bad = 0;
    for (let r = 0; r < keep.length; r++) {
      const logs = num.map((c) => Math.log(c[r]));
      if (logs.some((l) => !Number.isFinite(l))) { bad++; num.forEach((c) => (c[r] = NaN)); continue; }
      const g = logs.reduce((a, b) => a + b, 0) / logs.length;
      num.forEach((c, k) => (c[r] = logs[k] - g));
    }
    if (bad) warning = `CLR needs every selected value to be positive: ${bad.toLocaleString()} row${bad === 1 ? "" : "s"} with zero, negative or missing values cannot be used. Handle missing values first, or deselect the column.`;
    if (o.dims.length < 3) warning = (warning ? warning + " " : "") + "CLR is meant for three or more parts of a composition.";
  } else if (o.fn !== "None") {
    const f = FN[o.fn];
    num = num.map((c) => c.map((v) => f(v)));
    if (num.some((c) => c.some((v) => !Number.isFinite(v) && !Number.isNaN(v)))) warning = `${o.fn} produced infinite values (for example log of zero); those rows cannot be used.`;
  }

  if (o.scale !== "None") {
    num = num.map((c) => {
      const ok = c.filter(Number.isFinite);
      const n = ok.length;
      const centre = o.scale !== "Scale only";
      const doScale = o.scale !== "Centre only";
      const mu = centre && n ? ok.reduce((a, b) => a + b, 0) / n : 0;
      // R's scale(): divides by the sd when centred, otherwise by the root mean square (n - 1 denominator).
      const s = doScale && n > 1 ? Math.sqrt(ok.reduce((a, b) => a + (b - mu) ** 2, 0) / (n - 1)) : 1;
      return c.map((v) => (v - mu) / (s || 1));
    });
  }
  if (o.round !== null) {
    const p = 10 ** o.round;
    num = num.map((c) => c.map((v) => Math.round(v * p) / p));
  }

  const X = keep.map((_, r) => num.map((c) => c[r]));
  return { X, keep, classValues: keep.map((i) => (ci >= 0 ? t.rows[i][ci] : null)), naCount, ltCount, filtered, warning };
}

/** Rows of X that are complete (every value finite), so methods that cannot handle gaps can drop the rest. */
export function completeRows(X: number[][]): number[] {
  const out: number[] = [];
  X.forEach((r, i) => { if (r.every(Number.isFinite)) out.push(i); });
  return out;
}

export function summarise(names: string[], X: number[][]) {
  return names.map((name, j) => {
    const all = X.map((r) => r[j]);
    const v = all.filter(Number.isFinite);
    const n = v.length;
    const mean = n ? v.reduce((a, b) => a + b, 0) / n : NaN;
    const sd = n > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : NaN;
    return { name, mean, median: n ? median(v) : NaN, min: n ? Math.min(...v) : NaN, max: n ? Math.max(...v) : NaN, sd, hasNA: v.length < all.length };
  });
}

// ---------- correlation ----------

function ranks(v: number[]): number[] {
  const order = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(v.length);
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    for (let k = i; k <= j; k++) r[order[k][1]] = (i + j) / 2 + 1; // ties share the average rank
    i = j + 1;
  }
  return r;
}

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const da = a[i] - ma, db = b[i] - mb; sab += da * db; saa += da * da; sbb += db * db; }
  return sab / Math.sqrt(saa * sbb);
}

/** Correlation matrix over complete rows (R: cor(x, use = "complete.obs")). */
export function correlation(X: number[][], method: "Pearson" | "Spearman"): { r: number[][]; n: number } {
  const rows = completeRows(X).map((i) => X[i]);
  const d = X[0]?.length ?? 0;
  let cols = Array.from({ length: d }, (_, j) => rows.map((r) => r[j]));
  if (method === "Spearman") cols = cols.map(ranks);
  const r = Array.from({ length: d }, (_, i) => Array.from({ length: d }, (_, j) => (i === j ? 1 : NaN)));
  for (let i = 0; i < d; i++) for (let j = i + 1; j < d; j++) r[i][j] = r[j][i] = pearson(cols[i], cols[j]);
  return { r, n: rows.length };
}

// ---------- PCA ----------

// Jacobi eigen-decomposition of a symmetric matrix; returns eigenvectors as columns, sorted by eigenvalue (largest first).
function eigSym(A: number[][]): { values: number[]; vectors: number[][] } {
  const n = A.length;
  const a = A.map((r) => [...r]);
  const v: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] ** 2;
    if (off < 1e-20) break;
    for (let p = 0; p < n; p++)
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-300) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const tt = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(tt * tt + 1), s = tt * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p], vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq;
        }
      }
  }
  const order = a.map((r, i) => [r[i], i]).sort((x, y) => y[0] - x[0]);
  return { values: order.map((o) => o[0]), vectors: v.map((row) => order.map((o) => row[o[1]])) };
}

export type PcaResult = {
  scores: number[][]; // n x k
  loadings: number[][]; // d x k (R's rotation)
  sdev: number[];
  explained: number[]; // proportion of variance per component
};

/** Same as R's prcomp(X, center, scale.). Component signs are made deterministic (largest loading positive) but may differ from R's. */
export function pcaFull(X: number[][], centre: boolean, scale: boolean): PcaResult {
  const n = X.length, d = X[0].length;
  if (n < 2) throw new Error("PCA needs at least two complete rows.");
  const mu = Array(d).fill(0), sd = Array(d).fill(1);
  if (centre) for (let j = 0; j < d; j++) mu[j] = X.reduce((a, r) => a + r[j], 0) / n;
  if (scale)
    for (let j = 0; j < d; j++) {
      // prcomp scales by the sd of the (possibly centred) column; uncentred uses the root mean square.
      const s = Math.sqrt(X.reduce((a, r) => a + (r[j] - mu[j]) ** 2, 0) / (n - 1));
      if (!(s > 0)) throw new Error(`Column ${j + 1} is constant, so it cannot be scaled. Deselect it or turn off Scale.`);
      sd[j] = s;
    }
  const Z = X.map((r) => r.map((v, j) => (v - mu[j]) / sd[j]));
  const C = Array.from({ length: d }, () => Array(d).fill(0));
  for (const r of Z) for (let i = 0; i < d; i++) for (let j = i; j < d; j++) C[i][j] += r[i] * r[j];
  for (let i = 0; i < d; i++) for (let j = 0; j <= i; j++) C[i][j] = C[j][i] = C[j][i] / (n - 1);
  const { values, vectors } = eigSym(C);
  const k = Math.min(d, n - 1);
  for (let c = 0; c < k; c++) {
    let big = 0;
    for (let j = 0; j < d; j++) if (Math.abs(vectors[j][c]) > Math.abs(vectors[big][c])) big = j;
    if (vectors[big][c] < 0) for (let j = 0; j < d; j++) vectors[j][c] = -vectors[j][c];
  }
  const loadings = vectors.map((row) => row.slice(0, k));
  const scores = Z.map((r) => Array.from({ length: k }, (_, c) => r.reduce((a, v, j) => a + v * loadings[j][c], 0)));
  const vals = values.slice(0, k).map((v) => Math.max(v, 0));
  const total = values.reduce((a, v) => a + Math.max(v, 0), 0) || 1;
  return { scores, loadings, sdev: vals.map(Math.sqrt), explained: vals.map((v) => v / total) };
}

/** Scores on the first k components only (for t-SNE's initial reduction). */
export function pca(X: number[][], k: number, centre: boolean, scale: boolean): number[][] {
  const p = pcaFull(X, centre, scale);
  return p.scores.map((r) => r.slice(0, Math.min(k, r.length)));
}

/** 95% normal-theory ellipse around a group of 2-D points (like ggplot's stat_ellipse(type = "norm")). */
export function ellipse(xs: number[], ys: number[], level = 0.95): [number, number][] | null {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
  sxx /= n - 1; sxy /= n - 1; syy /= n - 1;
  const tr = sxx + syy, det = sxx * syy - sxy * sxy;
  const disc = Math.sqrt(Math.max((tr * tr) / 4 - det, 0));
  const l1 = tr / 2 + disc, l2 = Math.max(tr / 2 - disc, 0);
  const angle = Math.abs(sxy) < 1e-15 ? (sxx >= syy ? 0 : Math.PI / 2) : Math.atan2(l1 - sxx, sxy);
  const c = Math.sqrt(-2 * Math.log(1 - level)); // chi-square quantile with 2 df, square-rooted
  const out: [number, number][] = [];
  for (let k = 0; k <= 60; k++) {
    const t = (2 * Math.PI * k) / 60;
    const a = c * Math.sqrt(l1) * Math.cos(t), b = c * Math.sqrt(l2) * Math.sin(t);
    out.push([mx + a * Math.cos(angle) - b * Math.sin(angle), my + a * Math.sin(angle) + b * Math.cos(angle)]);
  }
  return out;
}

// ---------- t-SNE (exact, Rtsne's defaults) ----------

export type TsneParams = {
  perplexity: number;
  initialDims: number;
  pca: boolean;
  pcaCenter: boolean;
  pcaScale: boolean;
  normalise: boolean;
  maxIter: number;
  momentum: number;
  finalMomentum: number;
  exaggeration: number;
};

export function tsne(X0: number[][], p: TsneParams, seed: number, progress: (iter: number) => void): number[][] {
  const n = X0.length;
  if (3 * p.perplexity >= n - 1) throw new Error(`Perplexity is too large for ${n} rows: 3 × perplexity must be less than ${n - 1}. Lower it to ${Math.max(1, Math.floor((n - 2) / 3))} or less.`);
  let X = p.pca ? pca(X0, p.initialDims, p.pcaCenter, p.pcaScale) : X0.map((r) => [...r]);
  if (p.normalise) {
    // Rtsne::normalize_input: centre each column, then divide everything by the largest absolute value.
    const d = X[0].length;
    const mu = Array.from({ length: d }, (_, j) => X.reduce((a, r) => a + r[j], 0) / n);
    X = X.map((r) => r.map((v, j) => v - mu[j]));
    const m = Math.max(...X.map((r) => Math.max(...r.map(Math.abs)))) || 1;
    X = X.map((r) => r.map((v) => v / m));
  }

  const half = (n * (n - 1)) / 2;
  const at = (i: number, j: number) => (i < j ? i * n - (i * (i + 1)) / 2 + (j - i - 1) : j * n - (j * (j + 1)) / 2 + (i - j - 1));
  const P = new Float32Array(half);
  const D = new Float64Array(n);
  const row = new Float64Array(n);
  const logU = Math.log(p.perplexity);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let s = 0;
      for (let k = 0; k < X[i].length; k++) s += (X[i][k] - X[j][k]) ** 2;
      D[j] = s;
    }
    let beta = 1, lo = -Infinity, hi = Infinity, sum = 0;
    for (let it = 0; it < 200; it++) {
      sum = 0;
      let H = 0;
      for (let j = 0; j < n; j++) {
        row[j] = j === i ? 0 : Math.exp(-beta * D[j]);
        sum += row[j];
      }
      sum = sum || 1e-300;
      for (let j = 0; j < n; j++) H += beta * D[j] * row[j];
      H = H / sum + Math.log(sum);
      const diff = H - logU;
      if (Math.abs(diff) < 1e-5) break;
      if (diff > 0) { lo = beta; beta = hi === Infinity ? beta * 2 : (beta + hi) / 2; }
      else { hi = beta; beta = lo === -Infinity ? beta / 2 : (beta + lo) / 2; }
    }
    for (let j = 0; j < n; j++) if (j !== i) P[at(i, j)] += row[j] / sum;
  }
  let total = 0;
  for (let k = 0; k < half; k++) total += P[k];
  for (let k = 0; k < half; k++) P[k] = Math.max(P[k] / total, 1e-12);

  const r = rng(seed);
  const Y = new Float64Array(2 * n);
  for (let k = 0; k < 2 * n; k++) Y[k] = gauss(r) * 1e-4;
  const upd = new Float64Array(2 * n), gains = new Float64Array(2 * n).fill(1), grad = new Float64Array(2 * n);
  const Q = new Float32Array(half);
  const eta = 200, stopLying = 250, momSwitch = 250;

  for (let iter = 0; iter < p.maxIter; iter++) {
    const ex = iter < stopLying ? p.exaggeration : 1;
    const mom = iter < momSwitch ? p.momentum : p.finalMomentum;
    let Z = 0, k = 0;
    for (let i = 0; i < n; i++) {
      const yi0 = Y[2 * i], yi1 = Y[2 * i + 1];
      for (let j = i + 1; j < n; j++, k++) {
        const d0 = yi0 - Y[2 * j], d1 = yi1 - Y[2 * j + 1];
        const q = 1 / (1 + d0 * d0 + d1 * d1);
        Q[k] = q;
        Z += 2 * q;
      }
    }
    grad.fill(0);
    k = 0;
    for (let i = 0; i < n; i++) {
      const yi0 = Y[2 * i], yi1 = Y[2 * i + 1];
      let g0 = 0, g1 = 0;
      for (let j = i + 1; j < n; j++, k++) {
        const q = Q[k];
        const m = (ex * P[k] - q / Z) * q;
        const f0 = m * (yi0 - Y[2 * j]), f1 = m * (yi1 - Y[2 * j + 1]);
        g0 += f0; g1 += f1;
        grad[2 * j] -= f0; grad[2 * j + 1] -= f1;
      }
      grad[2 * i] += g0; grad[2 * i + 1] += g1;
    }
    let m0 = 0, m1 = 0;
    for (let c = 0; c < 2 * n; c++) {
      const g = 4 * grad[c];
      gains[c] = Math.sign(g) !== Math.sign(upd[c]) ? gains[c] + 0.2 : Math.max(gains[c] * 0.8, 0.01);
      upd[c] = mom * upd[c] - eta * gains[c] * g;
      Y[c] += upd[c];
    }
    for (let i = 0; i < n; i++) { m0 += Y[2 * i]; m1 += Y[2 * i + 1]; }
    m0 /= n; m1 /= n;
    for (let i = 0; i < n; i++) { Y[2 * i] -= m0; Y[2 * i + 1] -= m1; }
    if (iter % 20 === 0) progress(iter);
  }
  return Array.from({ length: n }, (_, i) => [Y[2 * i], Y[2 * i + 1]]);
}

// ---------- clustering (any number of dimensions) ----------

const sq = (a: number[], b: number[]) => { let s = 0; for (let k = 0; k < a.length; k++) s += (a[k] - b[k]) ** 2; return s; };

export function kmeans(P: number[][], k: number, iterMax: number, nstart: number, seed: number): number[] {
  const n = P.length, d = P[0].length;
  if (k < 1 || k > n) throw new Error(`Number of clusters must be between 1 and ${n}.`);
  const r = rng(seed + 1);
  let best: number[] = [], bestSS = Infinity;
  for (let s = 0; s < Math.max(1, nstart); s++) {
    // Same start as R's kmeans(): k distinct rows chosen at random.
    const pick = new Set<number>();
    while (pick.size < k) pick.add(Math.floor(r() * n));
    let C = [...pick].map((i) => [...P[i]]);
    const lab = new Array(n).fill(-1);
    for (let it = 0; it < iterMax; it++) {
      let changed = false;
      for (let i = 0; i < n; i++) {
        let bj = 0, bd = Infinity;
        for (let j = 0; j < k; j++) { const dd = sq(P[i], C[j]); if (dd < bd) { bd = dd; bj = j; } }
        if (lab[i] !== bj) { lab[i] = bj; changed = true; }
      }
      const sum = Array.from({ length: k }, () => new Array(d + 1).fill(0));
      for (let i = 0; i < n; i++) { for (let q = 0; q < d; q++) sum[lab[i]][q] += P[i][q]; sum[lab[i]][d]++; }
      C = sum.map((c, j) => (c[d] ? c.slice(0, d).map((v) => v / c[d]) : C[j]));
      if (!changed) break;
    }
    let ss = 0;
    for (let i = 0; i < n; i++) ss += sq(P[i], C[lab[i]]);
    if (ss < bestSS) { bestSS = ss; best = [...lab]; }
  }
  return relabelBySize(best);
}

// Gaussian mixture models, named as in R's mclust (the six with closed-form M steps).
export const GMM_MODELS = ["EII", "VII", "EEI", "VVI", "EEE", "VVV"] as const;
export type GmmModel = (typeof GMM_MODELS)[number];
export const GMM_LABELS: Record<GmmModel, string> = {
  EII: "EII: spherical, equal volume",
  VII: "VII: spherical, varying volume",
  EEI: "EEI: diagonal, equal",
  VVI: "VVI: diagonal, varying",
  EEE: "EEE: ellipsoidal, equal",
  VVV: "VVV: ellipsoidal, varying",
};
const COV_PARAMS: Record<GmmModel, (g: number, d: number) => number> = {
  EII: () => 1, VII: (g) => g, EEI: (_, d) => d, VVI: (g, d) => g * d, EEE: (_, d) => (d * (d + 1)) / 2, VVV: (g, d) => (g * d * (d + 1)) / 2,
};

/** Lower Cholesky factor, or null if the matrix is not positive definite. */
function cholesky(A: number[][]): number[][] | null {
  const d = A.length;
  const L = Array.from({ length: d }, () => new Array(d).fill(0));
  for (let i = 0; i < d; i++)
    for (let j = 0; j <= i; j++) {
      let s = A[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      if (i === j) { if (!(s > 1e-12)) return null; L[i][i] = Math.sqrt(s); }
      else L[i][j] = s / L[j][j];
    }
  return L;
}

function fitGmm(P: number[][], G: number, model: GmmModel, seed: number): { labels: number[]; bic: number } | null {
  const n = P.length, d = P[0].length;
  if (G > n) return null;
  const init = G === 1 ? new Array(n).fill(0) : kmeans(P, G, 50, 5, seed).map((l) => l - 1);
  let R: number[][] = P.map((_, i) => Array.from({ length: G }, (_, g) => (init[i] === g ? 1 : 0)));
  let ll = -Infinity;
  const diagOnly = (M: number[][]) => M.map((r, i) => r.map((v, j) => (i === j ? v : 0)));
  const spherical = (M: number[][]) => { const l = M.reduce((a, r, i) => a + r[i], 0) / d; return M.map((r, i) => r.map((_, j) => (i === j ? l : 0))); };
  for (let it = 0; it < 500; it++) {
    // M step
    const nk = Array(G).fill(0), mu = Array.from({ length: G }, () => new Array(d).fill(0));
    for (let i = 0; i < n; i++) for (let g = 0; g < G; g++) { nk[g] += R[i][g]; for (let q = 0; q < d; q++) mu[g][q] += R[i][g] * P[i][q]; }
    if (nk.some((v) => v < 1e-6)) return null;
    for (let g = 0; g < G; g++) for (let q = 0; q < d; q++) mu[g][q] /= nk[g];
    const S = Array.from({ length: G }, () => Array.from({ length: d }, () => new Array(d).fill(0)));
    for (let i = 0; i < n; i++)
      for (let g = 0; g < G; g++) {
        const w = R[i][g];
        if (w < 1e-12) continue;
        for (let a = 0; a < d; a++) { const da = P[i][a] - mu[g][a]; for (let b = 0; b <= a; b++) S[g][a][b] += w * da * (P[i][b] - mu[g][b]); }
      }
    for (const s of S) for (let a = 0; a < d; a++) for (let b = 0; b < a; b++) s[b][a] = s[a][b];
    const W = Array.from({ length: d }, (_, a) => Array.from({ length: d }, (_, b) => S.reduce((t, s) => t + s[a][b], 0) / n));
    const cov = S.map((s, g) => {
      const own = s.map((r) => r.map((v) => v / nk[g]));
      switch (model) {
        case "VVV": return own;
        case "VVI": return diagOnly(own);
        case "VII": return spherical(own);
        case "EEE": return W;
        case "EEI": return diagOnly(W);
        case "EII": return spherical(W);
      }
    });
    const chol = cov.map(cholesky);
    if (chol.some((c) => c === null)) return null;
    const Ls = chol as number[][][];
    const logdet = Ls.map((L) => 2 * L.reduce((a, r, i) => a + Math.log(r[i]), 0));
    const pi = nk.map((v) => v / n);
    // E step
    let newLL = 0;
    const logs = new Array(G).fill(0), z = new Array(d).fill(0);
    const out: number[][] = [];
    for (let i = 0; i < n; i++) {
      let mx = -Infinity;
      for (let g = 0; g < G; g++) {
        const L = Ls[g];
        let m = 0;
        for (let a = 0; a < d; a++) {
          let s = P[i][a] - mu[g][a];
          for (let b = 0; b < a; b++) s -= L[a][b] * z[b];
          z[a] = s / L[a][a];
          m += z[a] * z[a];
        }
        logs[g] = Math.log(pi[g]) - (d / 2) * Math.log(2 * Math.PI) - 0.5 * logdet[g] - 0.5 * m;
        if (logs[g] > mx) mx = logs[g];
      }
      let s = 0;
      for (let g = 0; g < G; g++) s += Math.exp(logs[g] - mx);
      newLL += mx + Math.log(s);
      out.push(logs.map((l) => Math.exp(l - mx) / s));
    }
    R = out;
    if (Math.abs(newLL - ll) < 1e-8 * Math.abs(newLL)) { ll = newLL; break; }
    ll = newLL;
  }
  const params = G * d + (G - 1) + COV_PARAMS[model](G, d);
  const labels = R.map((r) => r.indexOf(Math.max(...r)));
  // mclust's convention: BIC = 2 log-likelihood - parameters × log(n); higher is better.
  return { labels, bic: 2 * ll - params * Math.log(n) };
}

export function gmm(P: number[][], G: number | "auto", models: GmmModel[] | "all", seed: number): { labels: number[]; G: number; model: GmmModel; bic: number } {
  const ms = models === "all" || models.length === 0 ? [...GMM_MODELS] : models;
  const gs = G === "auto" ? [1, 2, 3, 4, 5, 6, 7, 8, 9] : [G];
  let best: { labels: number[]; G: number; model: GmmModel; bic: number } | null = null;
  for (const g of gs)
    for (const m of ms) {
      const f = fitGmm(P, g, m, seed);
      if (f && (!best || f.bic > best.bic)) best = { labels: f.labels, G: g, model: m, bic: f.bic };
    }
  if (!best) throw new Error("No Gaussian mixture could be fitted with those settings (a cluster collapsed). Try fewer clusters or another model.");
  return { ...best, labels: relabelBySize(best.labels) };
}

// Number clusters 1..k, largest first, so labels are stable from run to run.
function relabelBySize(lab: number[]): number[] {
  const counts = new Map<number, number>();
  lab.forEach((l) => counts.set(l, (counts.get(l) ?? 0) + 1));
  const order = [...counts.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
  const map = new Map(order.map((l, i) => [l, i + 1]));
  return lab.map((l) => map.get(l)!);
}

export function centroids(P: number[][], labels: number[]): { cluster: number; x: number; y: number }[] {
  const acc = new Map<number, [number, number, number]>();
  P.forEach((p, i) => {
    const a = acc.get(labels[i]) ?? [0, 0, 0];
    a[0] += p[0]; a[1] += p[1]; a[2]++;
    acc.set(labels[i], a);
  });
  return [...acc.entries()].sort((a, b) => a[0] - b[0]).map(([cluster, a]) => ({ cluster, x: a[0] / a[2], y: a[1] / a[2] }));
}
