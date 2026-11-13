// Geostatistics engine for the /tools/geostatistics page: experimental variogram, model fitting (spherical / exponential), ordinary kriging and
// inverse-distance weighting with a moving neighbourhood (k nearest samples), and leave-one-out cross-validation. Pure TypeScript with no
// browser or server dependencies, so it runs in the browser (interactive variogram changes need no round trip) and in tests.
//
// Coordinates: samples come in longitude/latitude; distances are computed in kilometres on a local equirectangular projection centred on the
// data (adequate for areas up to a few hundred kilometres across; the page caps the area). The output grid is regular in longitude/latitude
// (EPSG:4326), so it can be written straight to a GeoTIFF.

export type ModelType = "spherical" | "exponential";
export type VariogramModel = { type: ModelType; nugget: number; sill: number; range: number }; // sill = partial sill (total sill = nugget + sill); range in km
export type Lag = { h: number; gamma: number; pairs: number };
export type Pt = { x: number; y: number; z: number };

export const MODEL_TYPES: readonly ModelType[] = ["spherical", "exponential"];

/** Local projection: kilometres east and north of the centre of the data. */
export function makeProjection(lon0: number, lat0: number) {
  const kx = 111.32 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110.574;
  return {
    fwd: (lon: number, lat: number): [number, number] => [(lon - lon0) * kx, (lat - lat0) * ky],
    kx,
    ky,
  };
}

/** Semivariance of the model at distance h (km). gamma(0) = 0; the nugget applies for any h > 0. Exponential uses the practical range (95% of sill). */
export function gammaAt(m: VariogramModel, h: number): number {
  if (h <= 0) return 0;
  return m.nugget + m.sill * shape(m.type, h / Math.max(m.range, 1e-9));
}

function shape(type: ModelType, r: number): number {
  if (type === "spherical") return r >= 1 ? 1 : 1.5 * r - 0.5 * r * r * r;
  return 1 - Math.exp(-3 * r);
}

/** Omnidirectional experimental (Matheron) semivariogram with nLags equal-width bins up to maxLag km. O(n^2): callers cap n. */
export function experimentalVariogram(pts: Pt[], maxLag: number, nLags: number): Lag[] {
  const w = maxLag / nLags;
  const sum = new Float64Array(nLags), cnt = new Float64Array(nLags), hs = new Float64Array(nLags);
  const n = pts.length;
  const max2 = maxLag * maxLag;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    for (let j = i + 1; j < n; j++) {
      const b = pts[j];
      const dx = a.x - b.x, dy = a.y - b.y;
      const d2 = dx * dx + dy * dy;
      if (d2 >= max2 || d2 === 0) continue;
      const d = Math.sqrt(d2);
      const k = Math.min(nLags - 1, Math.floor(d / w));
      const dz = a.z - b.z;
      sum[k] += dz * dz;
      cnt[k] += 1;
      hs[k] += d;
    }
  }
  const out: Lag[] = [];
  for (let k = 0; k < nLags; k++) if (cnt[k] > 0) out.push({ h: hs[k] / cnt[k], gamma: sum[k] / (2 * cnt[k]), pairs: cnt[k] });
  return out;
}

/** Weighted least-squares fit (Cressie weights N(h)/gamma_model(h)^2, iterated) over a grid of ranges; nugget and partial sill solved linearly, both >= 0. */
export function fitModel(lags: Lag[], type: ModelType, maxLag: number, variance: number): { model: VariogramModel; wss: number } {
  const usable = lags.filter((l) => l.pairs >= 10);
  const L = usable.length >= 3 ? usable : lags;
  let best: { model: VariogramModel; wss: number } = { model: { type, nugget: 0, sill: Math.max(variance, 1e-9), range: maxLag / 2 }, wss: Infinity };
  if (L.length < 2) return best;
  const ranges: number[] = [];
  for (let i = 0; i < 60; i++) ranges.push(maxLag * 0.03 * Math.pow(1.5 / 0.03, i / 59)); // 3% to 150% of the maximum lag, log spaced
  for (const a of ranges) {
    const f = L.map((l) => shape(type, l.h / a));
    let wts = L.map((l) => l.pairs / Math.max(l.gamma, 1e-12) ** 2); // first pass: weights from the experimental values
    let fit = { c0: 0, c: 0 };
    for (let iter = 0; iter < 2; iter++) {
      fit = nnls2(f, L.map((l) => l.gamma), wts);
      const fc = fit;
      wts = L.map((l, i) => l.pairs / Math.max(fc.c0 + fc.c * f[i], 1e-12) ** 2);
    }
    const wss = L.reduce((s, l, i) => s + wts[i] * (l.gamma - fit.c0 - fit.c * f[i]) ** 2, 0) / L.reduce((s, _, i) => s + wts[i], 0) / Math.max(variance, 1e-12) ** 2;
    if (fit.c > 0 && wss < best.wss) best = { model: { type, nugget: fit.c0, sill: fit.c, range: a }, wss };
  }
  return best;
}

/** Minimise sum w (y - c0 - c f)^2 with c0, c >= 0. */
function nnls2(f: number[], y: number[], w: number[]): { c0: number; c: number } {
  let sw = 0, sf = 0, sy = 0, sff = 0, sfy = 0;
  for (let i = 0; i < f.length; i++) {
    sw += w[i]; sf += w[i] * f[i]; sy += w[i] * y[i]; sff += w[i] * f[i] * f[i]; sfy += w[i] * f[i] * y[i];
  }
  const det = sw * sff - sf * sf;
  let c0 = det !== 0 ? (sy * sff - sf * sfy) / det : 0;
  let c = det !== 0 ? (sw * sfy - sf * sy) / det : 0;
  if (c0 >= 0 && c >= 0) return { c0, c };
  // Boundary solutions: c0 = 0 or c = 0.
  const cOnly = sff > 0 ? Math.max(0, sfy / sff) : 0;
  const c0Only = sw > 0 ? Math.max(0, sy / sw) : 0;
  const e1 = f.reduce((s, fi, i) => s + w[i] * (y[i] - cOnly * fi) ** 2, 0);
  const e2 = f.reduce((s, _, i) => s + w[i] * (y[i] - c0Only) ** 2, 0);
  if (e1 <= e2) { c0 = 0; c = cOnly; } else { c0 = c0Only; c = 0; }
  return { c0, c };
}

/** Best of the spherical and exponential fits. */
export function autoFit(lags: Lag[], maxLag: number, variance: number): VariogramModel {
  const fits = MODEL_TYPES.map((t) => fitModel(lags, t, maxLag, variance));
  fits.sort((a, b) => a.wss - b.wss);
  return fits[0].model;
}

// ---------- k-nearest-neighbour search (2-d tree) ----------

export class KdTree {
  private idx: Int32Array;
  private xs: Float64Array;
  private ys: Float64Array;
  constructor(pts: { x: number; y: number }[]) {
    this.xs = Float64Array.from(pts, (p) => p.x);
    this.ys = Float64Array.from(pts, (p) => p.y);
    this.idx = Int32Array.from(pts, (_, i) => i);
    this.build(0, pts.length, 0);
  }
  private build(lo: number, hi: number, depth: number) {
    if (hi - lo <= 1) return;
    const mid = (lo + hi) >> 1;
    const c = depth % 2 === 0 ? this.xs : this.ys;
    this.select(lo, hi - 1, mid, c);
    this.build(lo, mid, depth + 1);
    this.build(mid + 1, hi, depth + 1);
  }
  // Quickselect on idx[lo..hi] by coordinate c so idx[k] is the median.
  private select(lo: number, hi: number, k: number, c: Float64Array) {
    const a = this.idx;
    while (hi > lo) {
      const pv = c[a[(lo + hi) >> 1]];
      let i = lo, j = hi;
      while (i <= j) {
        while (c[a[i]] < pv) i++;
        while (c[a[j]] > pv) j--;
        if (i <= j) { const t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; }
      }
      if (k <= j) hi = j; else if (k >= i) lo = i; else return;
    }
  }
  /** Indexes and distances of the k nearest points to (x, y), nearest first, skipping index `skip` (for cross-validation). */
  nearest(x: number, y: number, k: number, skip = -1): { i: number[]; d: number[] } {
    const bi: number[] = [], bd: number[] = []; // sorted by distance^2 ascending
    const visit = (lo: number, hi: number, depth: number) => {
      if (hi <= lo) return;
      const mid = (lo + hi) >> 1;
      const p = this.idx[mid];
      const dx = x - this.xs[p], dy = y - this.ys[p];
      const d2 = dx * dx + dy * dy;
      if (p !== skip && (bd.length < k || d2 < bd[bd.length - 1])) {
        let pos = bd.length;
        while (pos > 0 && bd[pos - 1] > d2) pos--;
        bd.splice(pos, 0, d2);
        bi.splice(pos, 0, p);
        if (bd.length > k) { bd.pop(); bi.pop(); }
      }
      const diff = depth % 2 === 0 ? dx : dy;
      const [first, second] = diff < 0 ? [[lo, mid], [mid + 1, hi]] : [[mid + 1, hi], [lo, mid]];
      visit(first[0], first[1], depth + 1);
      if (bd.length < k || diff * diff < bd[bd.length - 1]) visit(second[0], second[1], depth + 1);
    };
    visit(0, this.idx.length, 0);
    return { i: bi, d: bd.map(Math.sqrt) };
  }
}

// ---------- estimation ----------

export type Estimate = { z: number; sd: number }; // sd = kriging standard deviation (NaN for IDW)

/** Solve A x = b in place (Gaussian elimination, partial pivoting). Returns null when singular. */
function solve(A: Float64Array, b: Float64Array, n: number): Float64Array | null {
  for (let c = 0; c < n; c++) {
    let p = c, best = Math.abs(A[c * n + c]);
    for (let r = c + 1; r < n; r++) { const v = Math.abs(A[r * n + c]); if (v > best) { best = v; p = r; } }
    if (best < 1e-12) return null;
    if (p !== c) {
      for (let k = 0; k < n; k++) { const t = A[c * n + k]; A[c * n + k] = A[p * n + k]; A[p * n + k] = t; }
      const t = b[c]; b[c] = b[p]; b[p] = t;
    }
    for (let r = c + 1; r < n; r++) {
      const f = A[r * n + c] / A[c * n + c];
      if (f === 0) continue;
      for (let k = c; k < n; k++) A[r * n + k] -= f * A[c * n + k];
      b[r] -= f * b[c];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r * n + k] * x[k];
    x[r] = s / A[r * n + r];
  }
  return x;
}

/** Ordinary kriging at (x, y) from the given neighbours (semivariogram form, Lagrange multiplier for the unbiasedness constraint). */
export function krigeAt(pts: Pt[], nb: { i: number[]; d: number[] }, m: VariogramModel): Estimate {
  const k = nb.i.length;
  if (k === 0) return { z: NaN, sd: NaN };
  if (nb.d[0] < 1e-9) return { z: pts[nb.i[0]].z, sd: 0 }; // on a sample: exact interpolator
  if (k === 1) return { z: pts[nb.i[0]].z, sd: Math.sqrt(gammaAt(m, nb.d[0])) };
  const n = k + 1;
  const A = new Float64Array(n * n), b = new Float64Array(n);
  for (let r = 0; r < k; r++) {
    const pr = pts[nb.i[r]];
    for (let c = r + 1; c < k; c++) {
      const pc = pts[nb.i[c]];
      const g = gammaAt(m, Math.hypot(pr.x - pc.x, pr.y - pc.y));
      A[r * n + c] = g;
      A[c * n + r] = g;
    }
    A[r * n + k] = 1;
    A[k * n + r] = 1;
    b[r] = gammaAt(m, nb.d[r]);
  }
  b[k] = 1;
  const b0 = Float64Array.from(b);
  const w = solve(A, b, n);
  if (!w) return idwAt(pts, nb, 2);
  let z = 0, v = w[k];
  for (let r = 0; r < k; r++) { z += w[r] * pts[nb.i[r]].z; v += w[r] * b0[r]; }
  return { z, sd: Math.sqrt(Math.max(v, 0)) };
}

export function idwAt(pts: Pt[], nb: { i: number[]; d: number[] }, power: number): Estimate {
  if (nb.i.length === 0) return { z: NaN, sd: NaN };
  if (nb.d[0] < 1e-9) return { z: pts[nb.i[0]].z, sd: NaN };
  let sw = 0, sz = 0;
  for (let r = 0; r < nb.i.length; r++) {
    const wt = 1 / Math.pow(nb.d[r], power);
    sw += wt;
    sz += wt * pts[nb.i[r]].z;
  }
  return { z: sz / sw, sd: NaN };
}

export type Method = { kind: "kriging"; model: VariogramModel; k: number } | { kind: "idw"; power: number; k: number };

export type Grid = {
  west: number; south: number; east: number; north: number;
  nx: number; ny: number; dlon: number; dlat: number;
  z: Float32Array; // row 0 = northernmost row (GeoTIFF order); NaN = masked
  sd: Float32Array; // kriging standard deviation; NaN for IDW or masked
};

/** Estimate on a regular lon/lat grid (cell centres). Cells farther than maskKm from the nearest sample are left empty (NaN). */
export function interpolateGrid(
  pts: Pt[], tree: KdTree, proj: ReturnType<typeof makeProjection>, method: Method,
  box: { west: number; south: number; east: number; north: number }, nx: number, ny: number, maskKm: number
): Grid {
  const dlon = (box.east - box.west) / nx, dlat = (box.north - box.south) / ny;
  const z = new Float32Array(nx * ny).fill(NaN), sd = new Float32Array(nx * ny).fill(NaN);
  for (let r = 0; r < ny; r++) {
    const lat = box.north - (r + 0.5) * dlat;
    for (let c = 0; c < nx; c++) {
      const lon = box.west + (c + 0.5) * dlon;
      const [x, y] = proj.fwd(lon, lat);
      const nb = tree.nearest(x, y, method.k);
      if (nb.d.length === 0 || nb.d[0] > maskKm) continue;
      const e = method.kind === "kriging" ? krigeAt(pts, nb, method.model) : idwAt(pts, nb, method.power);
      z[r * nx + c] = e.z;
      sd[r * nx + c] = e.sd;
    }
  }
  return { ...box, nx, ny, dlon, dlat, z, sd };
}

export type CvStats = {
  n: number;
  meanError: number; // mean of (predicted - observed), transformed units
  rmse: number;
  corr: number; // Pearson correlation observed vs predicted
  msse: number | null; // mean squared standardised error (kriging only; about 1 when the model's error is honest)
  mse: number | null; // mean standardised error (kriging only; about 0)
  pairs: { obs: number; pred: number }[]; // for the scatter plot (capped)
};

/** Leave-one-out cross-validation on up to maxN samples (evenly spread through the list, which is already in random order). */
export function crossValidate(pts: Pt[], tree: KdTree, method: Method, maxN = 2000): CvStats {
  const step = Math.max(1, Math.floor(pts.length / maxN));
  const obs: number[] = [], pred: number[] = [], std: number[] = [];
  for (let i = 0; i < pts.length; i += step) {
    const p = pts[i];
    // Exclude every sample at the same place too, otherwise duplicates make the test trivially perfect.
    let nb = tree.nearest(p.x, p.y, method.k + 4, i);
    const keep = nb.d.map((d, j) => j).filter((j) => nb.d[j] > 1e-9).slice(0, method.k);
    nb = { i: keep.map((j) => nb.i[j]), d: keep.map((j) => nb.d[j]) };
    const e = method.kind === "kriging" ? krigeAt(pts, nb, method.model) : idwAt(pts, nb, method.power);
    if (!Number.isFinite(e.z)) continue;
    obs.push(p.z);
    pred.push(e.z);
    if (Number.isFinite(e.sd) && e.sd > 0) std.push((e.z - p.z) / e.sd);
  }
  const n = obs.length;
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / Math.max(a.length, 1);
  const err = pred.map((v, i) => v - obs[i]);
  const mo = mean(obs), mp = mean(pred);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (obs[i] - mo) * (pred[i] - mp); sxx += (obs[i] - mo) ** 2; syy += (pred[i] - mp) ** 2; }
  const pstep = Math.max(1, Math.floor(n / 1500));
  return {
    n,
    meanError: mean(err),
    rmse: Math.sqrt(mean(err.map((e) => e * e))),
    corr: sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN,
    msse: method.kind === "kriging" && std.length ? mean(std.map((s) => s * s)) : null,
    mse: method.kind === "kriging" && std.length ? mean(std) : null,
    pairs: obs.filter((_, i) => i % pstep === 0).map((o, j) => ({ obs: o, pred: pred[j * pstep] })),
  };
}

// ---------- helpers ----------

export function quantile(sorted: ArrayLike<number>, q: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  const pos = (n - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Median distance from each sample to its nearest neighbour (km): the typical sample spacing. */
export function medianSpacing(pts: Pt[], tree: KdTree): number {
  const step = Math.max(1, Math.floor(pts.length / 2000));
  const d: number[] = [];
  for (let i = 0; i < pts.length; i += step) {
    const nb = tree.nearest(pts[i].x, pts[i].y, 1, i);
    if (nb.d.length && nb.d[0] > 0) d.push(nb.d[0]);
  }
  d.sort((a, b) => a - b);
  return quantile(d, 0.5);
}

/** Average samples that share a location (field duplicates, repeat analyses): kriging needs distinct points. */
export function mergeColocated<T extends { lon: number; lat: number; t: number }>(rows: T[]): { lon: number; lat: number; t: number; members: number }[] {
  const m = new Map<string, { lon: number; lat: number; s: number; n: number }>();
  for (const r of rows) {
    const key = `${r.lon.toFixed(5)},${r.lat.toFixed(5)}`;
    const g = m.get(key) ?? { lon: r.lon, lat: r.lat, s: 0, n: 0 };
    g.s += r.t;
    g.n += 1;
    m.set(key, g);
  }
  return [...m.values()].map((g) => ({ lon: g.lon, lat: g.lat, t: g.s / g.n, members: g.n }));
}
