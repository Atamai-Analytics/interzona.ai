"use client";

import { forwardRef, useImperativeHandle, useRef } from "react";
import { gradient } from "@/lib/dimred/colours";
import { fmtTick, type PlotHandle } from "./Plot";
import { creditLine, downloadSvgPng, usePolicy } from "./ui";

// Scree plot, correlation heatmap and scatter-plot matrix for the Multivariate tools page.

const svgStyle = { background: "#fff", fontFamily: "Arial, Helvetica, sans-serif", display: "block" } as const;
const DIVERGING = ["#2166ac", "#67a9cf", "#d1e5f0", "#f7f7f7", "#fddbc7", "#ef8a62", "#b2182b"]; // blue (-1) to red (+1)
export const corrColor = (r: number) => (Number.isFinite(r) ? gradient((r + 1) / 2, DIVERGING) : "#ddd");

export const Scree = forwardRef<PlotHandle, { explained: number[]; max?: number }>(function Scree({ explained, max = 10 }, ref) {
  const svgRef = useRef<SVGSVGElement>(null);
  useImperativeHandle(ref, () => ({ downloadPng: (f: string) => downloadSvgPng(svgRef.current, f) }));
  const credit = creditLine(usePolicy().credits);
  const ex = explained.slice(0, max).map((v) => v * 100);
  let c = 0;
  const cum = ex.map((v) => (c += v));
  const W = 420, H = 320, M = { l: 44, r: 16, t: 36, b: 40 };
  const pw = W - M.l - M.r, ph = H - M.t - M.b;
  const bw = pw / ex.length;
  const sy = (v: number) => M.t + ph - (v / 100) * ph;
  return (
    <svg ref={svgRef} xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 ${W} ${H + (credit ? 16 : 0)}`} width="100%" style={svgStyle} role="img" aria-label="Scree plot">
      <rect width={W} height={H + 16} fill="#fff" />
      {credit && <text x={8} y={H + 11} fontSize={9} fill="#666">{credit.length > 150 ? credit.slice(0, 149) + "…" : credit}</text>}
      <text x={M.l} y={22} fontSize={14} fontWeight={600} fill="#111">Scree plot</text>
      {[0, 25, 50, 75, 100].map((t) => (
        <g key={t}>
          <line x1={M.l} x2={M.l + pw} y1={sy(t)} y2={sy(t)} stroke="#e5e7eb" />
          <text x={M.l - 6} y={sy(t) + 3} fontSize={10} textAnchor="end" fill="#444">{t}%</text>
        </g>
      ))}
      {ex.map((v, i) => (
        <g key={i}>
          <rect x={M.l + i * bw + bw * 0.15} y={sy(v)} width={bw * 0.7} height={ph - (sy(v) - M.t)} fill="#cd950c" />
          <text x={M.l + i * bw + bw / 2} y={sy(v) - 4} fontSize={9} textAnchor="middle" fill="#333">{v.toFixed(1)}</text>
          <text x={M.l + i * bw + bw / 2} y={M.t + ph + 14} fontSize={10} textAnchor="middle" fill="#444">{i + 1}</text>
        </g>
      ))}
      <polyline points={cum.map((v, i) => `${M.l + i * bw + bw / 2},${sy(v)}`).join(" ")} fill="none" stroke="#8a2be2" strokeWidth={2} />
      {cum.map((v, i) => <circle key={i} cx={M.l + i * bw + bw / 2} cy={sy(v)} r={3} fill="#8a2be2" />)}
      <text x={M.l + pw / 2} y={H - 6} fontSize={11} textAnchor="middle" fill="#222">Component (bars: % of variance; line: cumulative %)</text>
    </svg>
  );
});

export const CorrHeatmap = forwardRef<PlotHandle, { names: string[]; r: number[][]; title: string }>(function CorrHeatmap({ names, r, title }, ref) {
  const svgRef = useRef<SVGSVGElement>(null);
  useImperativeHandle(ref, () => ({ downloadPng: (f: string) => downloadSvgPng(svgRef.current, f) }));
  const credit = creditLine(usePolicy().credits);
  const d = names.length;
  const cell = Math.max(18, Math.min(56, Math.floor(560 / Math.max(d, 1))));
  const labelW = Math.min(120, 8 + 6.5 * Math.max(...names.map((n) => n.length)));
  const W = labelW + d * cell + 90, H = 40 + labelW + d * cell;
  const top = 40 + labelW;
  return (
    <svg ref={svgRef} xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 ${W} ${H + (credit ? 16 : 0)}`} width="100%" style={{ ...svgStyle, maxWidth: W * 1.4 }} role="img" aria-label={title}>
      <rect width={W} height={H + 16} fill="#fff" />
      {credit && <text x={8} y={H + 11} fontSize={9} fill="#666">{credit.length > 150 ? credit.slice(0, 149) + "…" : credit}</text>}
      <text x={8} y={22} fontSize={14} fontWeight={600} fill="#111">{title}</text>
      {names.map((n, j) => (
        <text key={"c" + n} x={labelW + j * cell + cell / 2} y={top - 6} fontSize={11} fill="#333" transform={`rotate(-50 ${labelW + j * cell + cell / 2} ${top - 6})`}>{n.length > 16 ? n.slice(0, 15) + "…" : n}</text>
      ))}
      {names.map((n, i) => (
        <g key={"r" + n}>
          <text x={labelW - 6} y={top + i * cell + cell / 2 + 4} fontSize={11} textAnchor="end" fill="#333">{n.length > 16 ? n.slice(0, 15) + "…" : n}</text>
          {names.map((_, j) =>
            j > i ? null : (
              <g key={j}>
                <rect x={labelW + j * cell} y={top + i * cell} width={cell - 1} height={cell - 1} fill={corrColor(r[i][j])} />
                {cell >= 26 && <text x={labelW + j * cell + cell / 2} y={top + i * cell + cell / 2 + 4} fontSize={Math.min(12, cell / 3)} textAnchor="middle" fill={Math.abs(r[i][j]) > 0.6 ? "#fff" : "#222"}>{Number.isFinite(r[i][j]) ? r[i][j].toFixed(2) : "NA"}</text>}
              </g>
            )
          )}
        </g>
      ))}
      <defs>
        <linearGradient id="corr-g" x1="0" x2="0" y1="1" y2="0">{DIVERGING.map((c, i) => <stop key={i} offset={i / (DIVERGING.length - 1)} stopColor={c} />)}</linearGradient>
      </defs>
      <g transform={`translate(${labelW + d * cell + 20}, ${top})`}>
        <rect width={14} height={Math.min(160, d * cell)} fill="url(#corr-g)" />
        <text x={20} y={9} fontSize={10} fill="#333">+1</text>
        <text x={20} y={Math.min(160, d * cell) / 2 + 3} fontSize={10} fill="#333">0</text>
        <text x={20} y={Math.min(160, d * cell)} fontSize={10} fill="#333">−1</text>
      </g>
    </svg>
  );
});

/** Pairs plot: scatter plots below the diagonal, correlations (text sized by strength) above it, like R's pairs(upper.panel = panel.cor). */
export const ScatterMatrix = forwardRef<PlotHandle, { names: string[]; cols: number[][]; r: number[][]; colors: string[] }>(function ScatterMatrix({ names, cols, r, colors }, ref) {
  const svgRef = useRef<SVGSVGElement>(null);
  useImperativeHandle(ref, () => ({ downloadPng: (f: string) => downloadSvgPng(svgRef.current, f) }));
  const credit = creditLine(usePolicy().credits);
  const d = names.length;
  const cell = Math.max(70, Math.floor(640 / d));
  const W = d * cell + 20, H = d * cell + 20;
  const ranges = cols.map((c) => {
    let lo = Infinity, hi = -Infinity;
    for (const v of c) { if (v < lo) lo = v; if (v > hi) hi = v; }
    return [lo, hi === lo ? lo + 1 : hi];
  });
  const n = cols[0]?.length ?? 0;
  const pr = n > 1500 ? 0.9 : n > 400 ? 1.3 : 1.8;
  return (
    <svg ref={svgRef} xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 ${W} ${H + (credit ? 16 : 0)}`} width="100%" style={svgStyle} role="img" aria-label="Scatter-plot matrix">
      <rect width={W} height={H + 16} fill="#fff" />
      {credit && <text x={8} y={H + 11} fontSize={9} fill="#666">{credit.length > 150 ? credit.slice(0, 149) + "…" : credit}</text>}
      {names.map((ni, i) =>
        names.map((_, j) => {
          const x = 10 + j * cell, y = 10 + i * cell;
          const inner = cell - 6;
          return (
            <g key={i + "-" + j} transform={`translate(${x}, ${y})`}>
              <rect width={inner} height={inner} fill={i === j ? "#f4f4f5" : "#fff"} stroke="#999" />
              {i === j && (
                <>
                  <text x={inner / 2} y={inner / 2} fontSize={Math.min(14, inner / 6)} fontWeight={600} textAnchor="middle" fill="#111">{ni.length > 12 ? ni.slice(0, 11) + "…" : ni}</text>
                  <text x={4} y={inner - 4} fontSize={8} fill="#666">{fmtTick(ranges[i][0])}–{fmtTick(ranges[i][1])}</text>
                </>
              )}
              {i > j &&
                cols[j].map((v, k) => (
                  <circle key={k} cx={3 + ((v - ranges[j][0]) / (ranges[j][1] - ranges[j][0])) * (inner - 6)} cy={inner - 3 - ((cols[i][k] - ranges[i][0]) / (ranges[i][1] - ranges[i][0])) * (inner - 6)} r={pr} fill={colors[k]} fillOpacity={0.7} />
                ))}
              {i < j && (
                <text x={inner / 2} y={inner / 2 + 5} textAnchor="middle" fontWeight={600} fill={corrColor(r[i][j])} stroke="#555" strokeWidth={0.3} fontSize={Math.max(10, (inner / 3.2) * Math.max(0.35, Math.abs(r[i][j]) || 0))}>
                  {Number.isFinite(r[i][j]) ? r[i][j].toFixed(2) : "NA"}
                </text>
              )}
            </g>
          );
        })
      )}
    </svg>
  );
});
