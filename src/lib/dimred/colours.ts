// Colours for the Multivariate tools plots and map: ggplot-like categories, R's terrain.colors for numbers.
import type { Cell } from "./math";

export const PALETTE = ["#F8766D", "#00BA38", "#619CFF", "#C77CFF", "#E7861B", "#00BFC4", "#B79F00", "#FF61C3", "#7CAE00", "#00A9FF"];
export const TERRAIN = ["#00A600", "#63C600", "#E6E600", "#E9BD3A", "#ECB176", "#EFC2B3", "#F2F2F2"];

export const catColor = (i: number, n: number) => (n <= PALETTE.length ? PALETTE[i % PALETTE.length] : `hsl(${Math.round((15 + (360 * i) / n) % 360)}, 70%, 50%)`);

function hex(c: string) { return [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)); }

export function gradient(t: number, stops: string[] = TERRAIN): string {
  const p = Math.min(Math.max(t, 0), 1) * (stops.length - 1);
  const i = Math.min(Math.floor(p), stops.length - 2);
  const a = hex(stops[i]), b = hex(stops[i + 1]);
  return "rgb(" + a.map((v, k) => Math.round(v + (b[k] - v) * (p - i))).join(",") + ")";
}

export type Legend = { kind: "categories"; title: string; items: { label: string; color: string }[] } | { kind: "gradient"; title: string; min: number; max: number; colors: string[] } | null;

/** Colours for a column of values: a gradient for numbers (unless asFactor), otherwise one colour per category. */
export function colourBy(values: Cell[], title: string, asFactor: boolean): { colors: string[]; legend: Legend; levels: string[] } {
  const numeric = values.every((v) => v === null || typeof v === "number");
  if (numeric && !asFactor && values.some((v) => v !== null)) {
    const nums = values.filter((v): v is number => v !== null);
    let min = Infinity, max = -Infinity;
    for (const v of nums) { if (v < min) min = v; if (v > max) max = v; }
    return { colors: values.map((v) => (v === null ? "#999" : gradient((v - min) / (max - min || 1)))), legend: { kind: "gradient", title, min, max, colors: TERRAIN }, levels: [] };
  }
  const keys = values.map((v) => (v === null ? "NA" : String(v)));
  const levels = [...new Set(keys)].sort((a, b) => (numeric ? Number(a) - Number(b) : a.localeCompare(b)));
  const map = new Map(levels.map((l, i) => [l, catColor(i, levels.length)]));
  return { colors: keys.map((k) => map.get(k)!), legend: { kind: "categories", title, items: levels.map((l) => ({ label: l, color: map.get(l)! })) }, levels };
}
