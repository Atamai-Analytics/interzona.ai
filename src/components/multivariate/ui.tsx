"use client";

// Small form controls, the data grid and the data policy (credits and the GEUS lock) shared by the Multivariate tools tabs.
import { createContext, useContext } from "react";
import { csvWithCredits } from "@/lib/csv";
import { toCsv, type Cell } from "@/lib/dimred/math";

/** Who to credit for the loaded data, and whether its sample-level values are locked (Greenland/GEUS: plots and statistics only). */
export type DataPolicy = { credits: string[]; restricted: boolean };
export const PolicyContext = createContext<DataPolicy>({ credits: [], restricted: false });
export const usePolicy = () => useContext(PolicyContext);
export const LOCKED_NOTE = "Switched off for this selection: it includes Greenland (GEUS) samples, which can be analysed and plotted but not listed or downloaded until GEUS agrees.";

/** CSV download; database extracts carry the publishers' credits, as their licences require. */
export function downloadCsv(name: string, columns: string[], rows: Cell[][], credits: string[]) {
  downloadText(name, credits.length ? csvWithCredits(columns, rows, credits) : toCsv(columns, rows));
}

/** Small credit line for charts drawn from database extracts (also printed into their PNGs). */
export const creditLine = (credits: string[]) => (credits.length ? `Data: ${credits.join("; ")}` : "");

export const card = "rounded-lg border border-gray-800 bg-gray-900/60 p-4";
export const label = "block text-xs text-gray-400 mb-1";
export const input = "w-full rounded border border-gray-700 bg-gray-950 px-2 py-1 text-sm text-gray-100 focus:border-emerald-500 focus:outline-none";
export const btn = "rounded px-3 py-1.5 text-sm font-medium disabled:opacity-40";
export const btnGreen = `${btn} bg-emerald-600 text-white hover:bg-emerald-500`;
export const btnRun = `${btn} bg-orange-600 text-white hover:bg-orange-500`;
export const heading = "text-sm font-semibold text-emerald-400";

export function Num({ name, value, set, step, min, max }: { name: string; value: number; set: (v: number) => void; step?: number; min?: number; max?: number }) {
  return (
    <label className="block">
      <span className={label}>{name}</span>
      <input type="number" className={input} value={Number.isFinite(value) ? value : ""} step={step ?? "any"} min={min} max={max} onChange={(e) => set(e.target.value === "" ? NaN : Number(e.target.value))} />
    </label>
  );
}

export function Check({ name, value, set }: { name: string; value: boolean; set: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm text-gray-200">
      <input type="checkbox" checked={value} onChange={(e) => set(e.target.checked)} className="accent-emerald-500" />
      {name}
    </label>
  );
}

export function Select<T extends string>({ name, value, set, options, labels }: { name: string; value: T; set: (v: T) => void; options: readonly T[]; labels?: Record<string, string> }) {
  return (
    <label className="block">
      {name && <span className={label}>{name}</span>}
      <select className={input} value={value} onChange={(e) => set(e.target.value as T)}>
        {options.map((o) => <option key={o} value={o}>{labels?.[o] ?? o}</option>)}
      </select>
    </label>
  );
}

export function Notice({ children, tone = "info" }: { children: React.ReactNode; tone?: "info" | "warn" | "error" }) {
  const cls = tone === "error" ? "border-red-900 bg-red-950/50 text-red-300" : tone === "warn" ? "border-amber-900 bg-amber-950/40 text-amber-200" : "border-gray-800 bg-gray-950 text-gray-300";
  return <p className={`rounded border p-3 text-sm ${cls}`}>{children}</p>;
}

export function downloadText(name: string, text: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Saves an on-screen SVG as a PNG at twice its size, on a white background. */
export function downloadSvgPng(svg: SVGSVGElement | null, filename: string) {
  if (!svg) return;
  const vb = svg.viewBox.baseVal;
  const w = vb?.width || svg.clientWidth, h = vb?.height || svg.clientHeight;
  const xml = new XMLSerializer().serializeToString(svg);
  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement("canvas");
    canvas.width = w * 2;
    canvas.height = h * 2;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((b) => {
      if (!b) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(b);
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }, "image/png");
  };
  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(xml);
}

export const fmtNum = (v: number) => (Number.isFinite(v) ? String(Number(v.toPrecision(6))) : "NA");
const fmtCell = (v: Cell) => (v === null ? <span className="text-gray-600">NA</span> : typeof v === "number" ? fmtNum(v) : v);

/** Row-by-row table. `raw` tables show sample values, so they are hidden while the data policy locks them. */
export function DataGrid({ columns, rows, max = 200, raw = true }: { columns: string[]; rows: Cell[][]; max?: number; raw?: boolean }) {
  const { restricted } = usePolicy();
  if (raw && restricted) return <Notice tone="warn">Sample table hidden. {LOCKED_NOTE}</Notice>;
  return (
    <div>
      <div className="max-h-[420px] overflow-auto rounded border border-gray-800">
        <table className="min-w-full text-xs">
          <thead className="sticky top-0 bg-gray-900">
            <tr>{columns.map((c) => <th key={c} className="whitespace-nowrap px-2 py-1.5 text-left font-semibold text-gray-300">{c}</th>)}</tr>
          </thead>
          <tbody>
            {rows.slice(0, max).map((r, i) => (
              <tr key={i} className="border-t border-gray-800/70">
                {r.map((v, j) => <td key={j} className="whitespace-nowrap px-2 py-1 text-gray-200">{fmtCell(v)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-1 text-xs text-gray-500">{rows.length > max ? `Showing the first ${max} of ${rows.length.toLocaleString()} rows; downloads include every row.` : `${rows.length.toLocaleString()} rows.`}</p>
    </div>
  );
}
