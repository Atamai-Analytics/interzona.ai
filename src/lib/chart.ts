import type { Dataset } from "./types";

type Chart = NonNullable<Dataset["chart"]>;

export const SERIES_COLORS = ["#60a5fa", "#f59e0b", "#34d399", "#f472b6"];
const PRINT_COLORS = ["#1d4ed8", "#b45309", "#047857", "#be185d"];

export const W = 640;
export const H = 260;
const L = 56, R = 12, T = 12, B = 28;

export const fmtValue = (v: number) =>
  Math.abs(v) >= 1000 ? v.toLocaleString("en-US", { maximumFractionDigits: 0 }) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);

/** Scales, ticks and line paths shared by the on-screen chart and the printable one. */
export function chartLayout(chart: Chart) {
  const pts = chart.series.map((s) => s.points.map(([d, v]) => ({ t: Date.parse(d), v })));
  const all = pts.flat();
  if (all.length < 2) return null;
  const t0 = Math.min(...all.map((p) => p.t));
  const t1 = Math.max(...all.map((p) => p.t));
  let v0 = Math.min(...all.map((p) => p.v));
  let v1 = Math.max(...all.map((p) => p.v));
  if (v0 > 0 && v0 / v1 > 0.5) v0 = Math.max(0, v0 - (v1 - v0) * 0.1);
  else v0 = Math.min(0, v0);
  // Round axis limits to a "nice" step so tick labels read cleanly.
  const rawStep = Math.max(1e-9, (v1 - v0) / 4);
  const mag = 10 ** Math.floor(Math.log10(rawStep));
  const niceStep = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((st) => st >= rawStep) ?? rawStep;
  v0 = Math.floor(v0 / niceStep) * niceStep;
  v1 = Math.ceil(v1 / niceStep) * niceStep;
  const x = (t: number) => L + ((t - t0) / Math.max(1, t1 - t0)) * (W - L - R);
  const y = (v: number) => T + (1 - (v - v0) / Math.max(1e-9, v1 - v0)) * (H - T - B);
  const yTicks: number[] = [];
  for (let tv = v0; tv <= v1 + niceStep / 2; tv += niceStep) yTicks.push(tv);
  const y0 = new Date(t0).getUTCFullYear();
  const y1 = new Date(t1).getUTCFullYear();
  const step = Math.max(1, Math.ceil((y1 - y0) / 7));
  const xTicks: number[] = [];
  for (let yr = Math.ceil(y0 / step) * step; yr <= y1; yr += step) xTicks.push(Date.UTC(yr, 0, 1));
  const paths = pts.map((sp) => sp.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" "));
  return { pts, x, y, yTicks, xTicks, paths, plot: { L, R, T, B } };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A static, light-themed SVG of the chart for printing and export. */
export function chartSvgString(chart: Chart, title: string): string {
  const lay = chartLayout(chart);
  if (!lay) return "";
  const grid = lay.yTicks
    .map((tv) => `<line x1="${L}" x2="${W - R}" y1="${lay.y(tv)}" y2="${lay.y(tv)}" stroke="#d1d5db" stroke-width="0.5"/><text x="${L - 6}" y="${lay.y(tv) + 3}" text-anchor="end" font-size="10" fill="#4b5563">${fmtValue(tv)}</text>`)
    .join("");
  const xl = lay.xTicks.map((tt) => `<text x="${lay.x(tt)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="#4b5563">${new Date(tt).getUTCFullYear()}</text>`).join("");
  const lines = lay.paths.map((d, i) => `<path d="${d}" fill="none" stroke="${PRINT_COLORS[i % PRINT_COLORS.length]}" stroke-width="1.6"/>`).join("");
  const legend = chart.series
    .map((s, i) => `<span style="color:${PRINT_COLORS[i % PRINT_COLORS.length]}">●</span> ${esc(s.name)}`)
    .join(" &nbsp; ");
  return `<div style="margin:8px 0"><div style="font-size:12px;color:#374151">${esc(title)} <span style="color:#6b7280">· ${esc(chart.unit)}</span></div><svg viewBox="0 0 ${W} ${H}" style="width:100%;max-width:640px;border:1px solid #d1d5db;border-radius:4px;background:#fff">${grid}${xl}${lines}</svg><div style="font-size:11px;color:#374151">${legend}</div></div>`;
}
