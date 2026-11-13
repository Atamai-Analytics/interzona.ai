"use client";

import { forwardRef } from "react";
import { gammaAt, type Lag, type VariogramModel } from "@/lib/geostat/engine";

// SVG charts for the Geostatistics page: experimental variogram with the model, cross-validation scatter, and a histogram of the values.

const W = 520, H = 300, M = { l: 56, r: 14, t: 14, b: 42 };
const fmt = (v: number) => (Math.abs(v) >= 100 || v === 0 ? String(Math.round(v)) : String(Number(v.toPrecision(2))));

function ticks(lo: number, hi: number, n = 5): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return [lo];
  const step0 = (hi - lo) / n;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) ?? step0;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Number(v.toPrecision(10)));
  return out;
}

function Axes({ x0, x1, y0, y1, xLabel, yLabel }: { x0: number; x1: number; y0: number; y1: number; xLabel: string; yLabel: string }) {
  const sx = (v: number) => M.l + ((v - x0) / (x1 - x0 || 1)) * (W - M.l - M.r);
  const sy = (v: number) => H - M.b - ((v - y0) / (y1 - y0 || 1)) * (H - M.t - M.b);
  return (
    <g fontSize="11" fill="#9ca3af">
      <line x1={M.l} y1={H - M.b} x2={W - M.r} y2={H - M.b} stroke="#4b5563" />
      <line x1={M.l} y1={M.t} x2={M.l} y2={H - M.b} stroke="#4b5563" />
      {ticks(x0, x1).map((v) => (
        <g key={`x${v}`}>
          <line x1={sx(v)} x2={sx(v)} y1={H - M.b} y2={H - M.b + 4} stroke="#4b5563" />
          <text x={sx(v)} y={H - M.b + 16} textAnchor="middle">{fmt(v)}</text>
        </g>
      ))}
      {ticks(y0, y1).map((v) => (
        <g key={`y${v}`}>
          <line x1={M.l - 4} x2={M.l} y1={sy(v)} y2={sy(v)} stroke="#4b5563" />
          <line x1={M.l} x2={W - M.r} y1={sy(v)} y2={sy(v)} stroke="#374151" strokeDasharray="2 4" />
          <text x={M.l - 7} y={sy(v) + 4} textAnchor="end">{fmt(v)}</text>
        </g>
      ))}
      <text x={(M.l + W - M.r) / 2} y={H - 6} textAnchor="middle" fill="#d1d5db">{xLabel}</text>
      <text transform={`translate(14 ${(M.t + H - M.b) / 2}) rotate(-90)`} textAnchor="middle" fill="#d1d5db">{yLabel}</text>
    </g>
  );
}

export const VariogramChart = forwardRef<SVGSVGElement, { lags: Lag[]; model: VariogramModel; maxLag: number; variance: number; yLabel: string }>(
  function VariogramChart({ lags, model, maxLag, variance, yLabel }, ref) {
    const yMax = Math.max(variance, model.nugget + model.sill, ...lags.map((l) => l.gamma)) * 1.12;
    const sx = (v: number) => M.l + (v / maxLag) * (W - M.l - M.r);
    const sy = (v: number) => H - M.b - (v / yMax) * (H - M.t - M.b);
    const maxPairs = Math.max(1, ...lags.map((l) => l.pairs));
    const curve = Array.from({ length: 121 }, (_, i) => (i / 120) * maxLag).map((h, i) => `${i ? "L" : "M"}${sx(h).toFixed(1)},${sy(h === 0 ? model.nugget : gammaAt(model, h)).toFixed(1)}`).join(" ");
    return (
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Experimental semivariogram and fitted model">
        <rect x="0" y="0" width={W} height={H} fill="#111827" />
        <Axes x0={0} x1={maxLag} y0={0} y1={yMax} xLabel="Separation distance (km)" yLabel={yLabel} />
        <line x1={M.l} x2={W - M.r} y1={sy(variance)} y2={sy(variance)} stroke="#6b7280" strokeDasharray="5 4" />
        <text x={W - M.r - 4} y={sy(variance) - 4} fontSize="10" fill="#9ca3af" textAnchor="end">sample variance</text>
        {lags.map((l, i) => (
          <circle key={i} cx={sx(l.h)} cy={sy(l.gamma)} r={2.5 + 4 * Math.sqrt(l.pairs / maxPairs)} fill="#38bdf8" fillOpacity="0.85">
            <title>{`${l.h.toFixed(2)} km: semivariance ${l.gamma.toPrecision(3)} from ${l.pairs.toLocaleString()} pairs`}</title>
          </circle>
        ))}
        <path d={curve} fill="none" stroke="#f97316" strokeWidth="2" />
        {model.range < maxLag && <line x1={sx(model.range)} x2={sx(model.range)} y1={M.t} y2={H - M.b} stroke="#f97316" strokeOpacity="0.4" strokeDasharray="3 3" />}
      </svg>
    );
  }
);

export function CvChart({ pairs, label }: { pairs: { obs: number; pred: number }[]; label: string }) {
  const all = pairs.flatMap((p) => [p.obs, p.pred]);
  if (!all.length) return null;
  let lo = Math.min(...all), hi = Math.max(...all);
  const pad = (hi - lo) * 0.05 || 1;
  lo -= pad; hi += pad;
  const sx = (v: number) => M.l + ((v - lo) / (hi - lo)) * (W - M.l - M.r);
  const sy = (v: number) => H - M.b - ((v - lo) / (hi - lo)) * (H - M.t - M.b);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Cross-validation: observed versus predicted">
      <rect x="0" y="0" width={W} height={H} fill="#111827" />
      <Axes x0={lo} x1={hi} y0={lo} y1={hi} xLabel={`Observed (${label})`} yLabel={`Predicted (${label})`} />
      <line x1={sx(lo)} y1={sy(lo)} x2={sx(hi)} y2={sy(hi)} stroke="#f97316" strokeDasharray="4 3" />
      {pairs.map((p, i) => <circle key={i} cx={sx(p.obs)} cy={sy(p.pred)} r="1.8" fill="#38bdf8" fillOpacity="0.55" />)}
    </svg>
  );
}

export function Histogram({ values, label, bdlCut }: { values: number[]; label: string; bdlCut?: number }) {
  if (values.length < 2) return null;
  const lo = Math.min(...values), hi = Math.max(...values);
  const nb = 30, w = (hi - lo) / nb || 1;
  const counts = new Array(nb).fill(0);
  for (const v of values) counts[Math.min(nb - 1, Math.floor((v - lo) / w))]++;
  const cMax = Math.max(...counts);
  const sx = (v: number) => M.l + ((v - lo) / (hi - lo || 1)) * (W - M.l - M.r);
  const sy = (c: number) => H - M.b - (c / cMax) * (H - M.t - M.b);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Histogram of the values">
      <rect x="0" y="0" width={W} height={H} fill="#111827" />
      <Axes x0={lo} x1={hi} y0={0} y1={cMax} xLabel={label} yLabel="Samples" />
      {counts.map((c, i) => (
        <rect key={i} x={sx(lo + i * w) + 0.5} width={Math.max(0.5, sx(lo + (i + 1) * w) - sx(lo + i * w) - 1)} y={sy(c)} height={H - M.b - sy(c)} fill="#34d399" fillOpacity="0.8" />
      ))}
      {bdlCut !== undefined && Number.isFinite(bdlCut) && bdlCut >= lo && bdlCut <= hi && (
        <g>
          <line x1={sx(bdlCut)} x2={sx(bdlCut)} y1={M.t} y2={H - M.b} stroke="#fbbf24" strokeDasharray="3 3" />
          <text x={sx(bdlCut) + 4} y={M.t + 10} fontSize="10" fill="#fbbf24">substituted below-detection values</text>
        </g>
      )}
    </svg>
  );
}
