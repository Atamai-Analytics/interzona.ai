"use client";

import { forwardRef, useState } from "react";
import { fromPpm, r, unitLabel, type ElDef, type HoleComposite, type Seg } from "@/lib/composite";

// Downhole strip log for one hole: assay bars against depth (linear or log grade axis), the cut-off as a dashed line, unsampled core hatched,
// and the composites as bands beside the bars with their 'including' parts darker. Depth increases downwards.

type Props = {
  hole: string;
  segs: Seg[];
  comps: HoleComposite[];
  d: ElDef;
  cutPpm: number;
  ratio?: number;
  eqLabel?: string;
  credit?: string;
};

const W = 460, TOP = 34, BOTTOM = 26, AX = 52, BARW = 230, GAP = 14, BANDW = 150;

export const StripLog = forwardRef<SVGSVGElement, Props>(function StripLog({ hole, segs, comps, d, cutPpm, ratio, eqLabel, credit }, ref) {
  const [logScale, setLogScale] = useState(true);
  const [zoom, setZoom] = useState<"hole" | "intercepts">("hole");
  const grade = (s: Seg) => fromPpm(d, s.g + (ratio ? s.g2 * ratio : 0));
  const sampled = segs.filter((s) => s.sampled);
  if (!sampled.length) return <p className="text-sm text-gray-400">No assay intervals for this hole.</p>;
  let d0 = Math.min(...segs.map((s) => s.from)), d1 = Math.max(...segs.map((s) => s.to));
  if (zoom === "intercepts" && comps.length) {
    const pad = 5;
    d0 = Math.max(d0, Math.min(...comps.map((c) => c.from)) - pad);
    d1 = Math.min(d1, Math.max(...comps.map((c) => c.to)) + pad);
  }
  const span = Math.max(d1 - d0, 1);
  const H = Math.min(900, Math.max(380, span * 3 + TOP + BOTTOM));
  const y = (m: number) => TOP + ((m - d0) / span) * (H - TOP - BOTTOM);
  const cut = fromPpm(d, cutPpm);
  const vals = sampled.map(grade).filter((v) => v > 0);
  const vmax = Math.max(cut * 2, ...vals);
  const vmin = Math.max(Math.min(cut / 20, ...vals), vmax / 1e5);
  const x = (v: number) => {
    if (v <= 0) return 0;
    if (!logScale) return (Math.min(v, vmax) / vmax) * BARW;
    const t = (Math.log10(Math.max(v, vmin)) - Math.log10(vmin)) / (Math.log10(vmax) - Math.log10(vmin));
    return Math.max(1, t * BARW);
  };
  const ticks = depthTicks(d0, d1);
  const bx = AX, bandX = AX + BARW + GAP;
  const unit = unitLabel(d) + (ratio ? " eq." : "");
  const visible = (s: { from: number; to: number }) => s.to > d0 && s.from < d1;
  const clipY = (m: number) => y(Math.min(Math.max(m, d0), d1));

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3 text-xs text-gray-300">
        <label className="flex items-center gap-1.5"><input type="checkbox" className="accent-emerald-500" checked={logScale} onChange={(e) => setLogScale(e.target.checked)} /> Log grade axis</label>
        <label className="flex items-center gap-1.5">Show
          <select className="rounded border border-gray-700 bg-gray-950 px-1 py-0.5" value={zoom} onChange={(e) => setZoom(e.target.value as "hole" | "intercepts")}>
            <option value="hole">whole sampled hole</option>
            <option value="intercepts" disabled={!comps.length}>intercepts only</option>
          </select>
        </label>
      </div>
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxWidth: W }} className="rounded border border-gray-800 bg-white" fontFamily="system-ui, sans-serif">
        <defs>
          <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="6" stroke="#9ca3af" strokeWidth="1.5" />
          </pattern>
        </defs>
        <text x={W / 2} y={14} textAnchor="middle" fontSize="12" fontWeight="600" fill="#111827">{hole}</text>
        <text x={bx + BARW / 2} y={28} textAnchor="middle" fontSize="10" fill="#4b5563">{`Assays (${unit}${logScale ? ", log" : ""})`}</text>
        <text x={bandX + BANDW / 2} y={28} textAnchor="middle" fontSize="10" fill="#4b5563">Intercepts</text>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={AX - 4} x2={bandX + BANDW} y1={y(t)} y2={y(t)} stroke="#e5e7eb" strokeWidth="0.6" />
            <text x={AX - 6} y={y(t) + 3} textAnchor="end" fontSize="9" fill="#374151">{t} m</text>
          </g>
        ))}
        {segs.filter(visible).map((s, i) =>
          s.sampled ? (
            <rect key={i} x={bx} y={clipY(s.from)} width={x(grade(s))} height={Math.max(0.6, clipY(s.to) - clipY(s.from))} fill={grade(s) >= cut ? "#f97316" : "#60a5fa"} stroke="#ffffff" strokeWidth="0.3" />
          ) : (
            <rect key={i} x={bx} y={clipY(s.from)} width={BARW} height={Math.max(0.6, clipY(s.to) - clipY(s.from))} fill="url(#hatch)" opacity="0.5" />
          ),
        )}
        <line x1={bx + x(cut)} x2={bx + x(cut)} y1={TOP} y2={H - BOTTOM} stroke="#dc2626" strokeDasharray="4 3" strokeWidth="1" />
        <text x={bx + x(cut) + 3} y={H - BOTTOM + 11} fontSize="9" fill="#dc2626">{`cut-off ${r(cut)}`}</text>
        <line x1={bx} x2={bx} y1={TOP} y2={H - BOTTOM} stroke="#6b7280" strokeWidth="0.8" />
        {comps.filter(visible).map((c, i) => {
          const y0 = clipY(c.from), y1 = clipY(c.to);
          return (
            <g key={i}>
              <rect x={bandX} y={y0} width={28} height={Math.max(1.5, y1 - y0)} fill="#fdba74" stroke="#c2410c" strokeWidth="0.8" />
              {c.incl && <rect x={bandX} y={clipY(c.incl.from)} width={28} height={Math.max(1.5, clipY(c.incl.to) - clipY(c.incl.from))} fill="#c2410c" />}
              <text x={bandX + 33} y={(y0 + y1) / 2 + 3} fontSize="9.5" fill="#111827">{`${r(c.len, 1)} m @ ${r(fromPpm(d, c.eq))}`}</text>
              {c.incl && <text x={bandX + 33} y={(y0 + y1) / 2 + 14} fontSize="8.5" fill="#7c2d12">{`incl. ${r(c.incl.len, 1)} m @ ${r(fromPpm(d, c.incl.eq))}`}</text>}
            </g>
          );
        })}
        <text x={4} y={H - 6} fontSize="8" fill="#6b7280">{[`Grades in ${unit}${eqLabel ? ` (${eqLabel})` : ""}; hatched = unsampled; orange bars at or above the cut-off.`, credit].filter(Boolean).join(" ")}</text>
      </svg>
    </div>
  );
});

function depthTicks(a: number, b: number): number[] {
  const span = b - a;
  const raw = span / 8;
  const p = 10 ** Math.floor(Math.log10(Math.max(raw, 1e-6)));
  const step = [1, 2, 5, 10].map((k) => k * p).find((s) => s >= raw) ?? 10 * p;
  const out: number[] = [];
  for (let t = Math.ceil(a / step) * step; t <= b + 1e-9; t += step) out.push(Number(t.toFixed(6)));
  return out;
}
