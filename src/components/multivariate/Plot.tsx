"use client";

import { forwardRef, useImperativeHandle, useRef } from "react";
import type { Legend } from "@/lib/dimred/colours";
import { creditLine, downloadSvgPng, usePolicy } from "./ui";

// Scatter plot for the Multivariate tools page (UMAP/t-SNE/PCA scores and cluster plots, PCA biplots).
// Drawn on a white card, like the R apps' ggplot output, so the PNG download looks the same as the screen.

export type PlotProps = {
  title: string;
  xs: number[];
  ys: number[];
  colors: string[];
  legend: Legend;
  xLabel?: string;
  yLabel?: string;
  hidePoints?: boolean;
  centres?: { cluster: number; x: number; y: number }[];
  ellipses?: { points: [number, number][]; color: string }[];
  arrows?: { x: number; y: number; label: string }[]; // already in plot units
  xlim?: [number, number] | null;
  ylim?: [number, number] | null;
};

export type PlotHandle = { downloadPng: (filename: string) => void };

const W = 640, H0 = 460, M = { l: 52, r: 150, t: 36, b: 44 };

export function ticks(lo: number, hi: number, count = 6): number[] {
  const span = hi - lo || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9 * span; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}

export const fmtTick = (v: number) => (Math.abs(v) >= 1e4 || (Math.abs(v) < 1e-3 && v !== 0) ? v.toExponential(1) : String(Number(v.toPrecision(4))));

function range(vals: number[]): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (const v of vals) if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (!Number.isFinite(lo)) return [0, 1];
  const s = hi - lo || 1;
  return [lo - s * 0.04, hi + s * 0.04];
}

export const ScatterPlot = forwardRef<PlotHandle, PlotProps>(function ScatterPlot(props, ref) {
  const { title, xs, ys, colors, legend, xLabel = "X", yLabel = "Y", hidePoints, centres, ellipses, arrows, xlim, ylim } = props;
  const svgRef = useRef<SVGSVGElement>(null);
  useImperativeHandle(ref, () => ({ downloadPng: (f: string) => downloadSvgPng(svgRef.current, f) }));
  const credit = creditLine(usePolicy().credits);
  const H = H0 + (credit ? 16 : 0);

  // Axis ranges cover the points plus any ellipses and arrows, unless fixed by the user.
  const allX = [...xs, ...(ellipses ?? []).flatMap((e) => e.points.map((p) => p[0])), ...(arrows ?? []).flatMap((a) => [a.x, 0])];
  const allY = [...ys, ...(ellipses ?? []).flatMap((e) => e.points.map((p) => p[1])), ...(arrows ?? []).flatMap((a) => [a.y, 0])];
  const [x0, x1] = xlim ?? range(allX);
  const [y0, y1] = ylim ?? range(allY);
  const pw = W - M.l - M.r, ph = H0 - M.t - M.b;
  const sx = (v: number) => M.l + ((v - x0) / (x1 - x0 || 1)) * pw;
  const sy = (v: number) => M.t + ph - ((v - y0) / (y1 - y0 || 1)) * ph;
  const r = xs.length > 2000 ? 1.6 : xs.length > 500 ? 2.2 : 3;
  const id = "c" + Math.abs([...title].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7));

  return (
    <svg ref={svgRef} xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 ${W} ${H}`} width="100%" style={{ background: "#fff", fontFamily: "Arial, Helvetica, sans-serif", display: "block" }} role="img" aria-label={title}>
      <rect x={0} y={0} width={W} height={H} fill="#fff" />
      <text x={M.l} y={22} fontSize={15} fontWeight={600} fill="#111">{title}</text>
      <rect x={M.l} y={M.t} width={pw} height={ph} fill="#f4f4f5" />
      {ticks(x0, x1).map((t) => (
        <g key={"x" + t}>
          <line x1={sx(t)} x2={sx(t)} y1={M.t} y2={M.t + ph} stroke="#fff" />
          <text x={sx(t)} y={M.t + ph + 15} fontSize={10} textAnchor="middle" fill="#444">{fmtTick(t)}</text>
        </g>
      ))}
      {ticks(y0, y1).map((t) => (
        <g key={"y" + t}>
          <line x1={M.l} x2={M.l + pw} y1={sy(t)} y2={sy(t)} stroke="#fff" />
          <text x={M.l - 6} y={sy(t) + 3} fontSize={10} textAnchor="end" fill="#444">{fmtTick(t)}</text>
        </g>
      ))}
      <text x={M.l + pw / 2} y={H0 - 8} fontSize={12} textAnchor="middle" fill="#222">{xLabel}</text>
      {credit && <text x={8} y={H - 5} fontSize={9} fill="#666">{credit.length > 150 ? credit.slice(0, 149) + "…" : credit}</text>}
      <text x={14} y={M.t + ph / 2} fontSize={12} textAnchor="middle" fill="#222" transform={`rotate(-90 14 ${M.t + ph / 2})`}>{yLabel}</text>
      <clipPath id={id}><rect x={M.l} y={M.t} width={pw} height={ph} /></clipPath>
      <g clipPath={`url(#${id})`}>
        {!hidePoints && xs.map((x, i) => <circle key={i} cx={sx(x)} cy={sy(ys[i])} r={r} fill={colors[i]} fillOpacity={0.85} />)}
        {ellipses?.map((e, i) => <polygon key={i} points={e.points.map((p) => `${sx(p[0])},${sy(p[1])}`).join(" ")} fill="none" stroke={e.color} strokeWidth={2} />)}
        {arrows && (
          <>
            <defs>
              <marker id={id + "-a"} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" fill="#7f1d1d" />
              </marker>
            </defs>
            {arrows.map((a) => (
              <g key={a.label}>
                <line x1={sx(0)} y1={sy(0)} x2={sx(a.x)} y2={sy(a.y)} stroke="#7f1d1d" strokeWidth={1.4} markerEnd={`url(#${id}-a)`} />
                <text x={sx(a.x * 1.08)} y={sy(a.y * 1.08)} fontSize={11} fontWeight={600} fill="#7f1d1d" textAnchor="middle" dominantBaseline="middle" stroke="#fff" strokeWidth={3} paintOrder="stroke">{a.label}</text>
              </g>
            ))}
          </>
        )}
        {centres?.map((c) => (
          <g key={c.cluster}>
            <circle cx={sx(c.x)} cy={sy(c.y)} r={3.5} fill="#000" />
            <text x={sx(c.x) + 4} y={sy(c.y) - 4} fontSize={17} fontWeight={600} fill="#000" stroke="#fff" strokeWidth={3} paintOrder="stroke">{c.cluster}</text>
          </g>
        ))}
      </g>
      {legend && (
        <g transform={`translate(${M.l + pw + 16}, ${M.t})`}>
          <text x={0} y={4} fontSize={12} fontWeight={600} fill="#222">{legend.title.length > 18 ? legend.title.slice(0, 17) + "…" : legend.title}</text>
          {legend.kind === "categories" ? (
            <>
              {legend.items.slice(0, 22).map((it, i) => (
                <g key={i} transform={`translate(0, ${20 + i * 17})`}>
                  <circle cx={5} cy={0} r={4.5} fill={it.color} />
                  <text x={15} y={4} fontSize={11} fill="#333">{it.label.length > 16 ? it.label.slice(0, 15) + "…" : it.label}</text>
                </g>
              ))}
              {legend.items.length > 22 && <text x={0} y={20 + 22 * 17} fontSize={11} fill="#666">+{legend.items.length - 22} more</text>}
            </>
          ) : (
            <>
              <defs>
                <linearGradient id={id + "-g"} x1="0" x2="0" y1="1" y2="0">
                  {legend.colors.map((c, i) => <stop key={i} offset={i / (legend.colors.length - 1)} stopColor={c} />)}
                </linearGradient>
              </defs>
              <rect x={0} y={14} width={16} height={140} fill={`url(#${id}-g)`} />
              <text x={22} y={22} fontSize={10} fill="#333">{fmtTick(legend.max)}</text>
              <text x={22} y={154} fontSize={10} fill="#333">{fmtTick(legend.min)}</text>
            </>
          )}
        </g>
      )}
    </svg>
  );
});
