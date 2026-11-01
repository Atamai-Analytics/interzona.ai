"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { MapData } from "@/lib/types";
import { addBaseLayer } from "@/lib/leafletBase";
import "leaflet/dist/leaflet.css";
import { csvWithCredits } from "@/lib/csv";

// Group colours: the three anomaly classes get fixed, meaningful colours; any other group takes the next palette colour.
const FIXED: Record<string, string> = {
  "New lead (no known occurrence nearby)": "#f59e0b",
  "Near an occurrence of a different commodity": "#a78bfa",
  "Near a known occurrence of this commodity": "#34d399",
};
const PALETTE = ["#60a5fa", "#f472b6", "#fbbf24", "#34d399", "#c084fc", "#fb7185", "#2dd4bf", "#a3e635"];

function csvText(m: MapData, credits: string[]) {
  return csvWithCredits(
    ["Label", "Group", "Latitude", "Longitude", "Detail"],
    m.points.map((p) => [p.label, p.group, p.lat, p.lon, (p.detail ?? "").replace(/\n/g, "; ")]),
    credits
  );
}

export default function MapView({ map, credits = [], light = false }: { map: MapData; credits?: string[]; light?: boolean }) {
  const el = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  const groups = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of map.points) counts.set(p.group, (counts.get(p.group) ?? 0) + 1);
    let i = 0;
    return [...counts.entries()].map(([name, n]) => ({ name, n, color: FIXED[name] ?? PALETTE[i++ % PALETTE.length] }));
  }, [map]);

  useEffect(() => {
    let cancelled = false;
    let instance: import("leaflet").Map | null = null;
    (async () => {
      try {
        const L = (await import("leaflet")).default;
        if (cancelled || !el.current) return;
        instance = L.map(el.current, { scrollWheelZoom: false, worldCopyJump: true });
        addBaseLayer(L, instance);
        const color = new Map(groups.map((g) => [g.name, g.color]));
        const bounds = L.latLngBounds([]);
        for (const p of map.points) {
          const c = color.get(p.group) ?? "#60a5fa";
          const radius = p.size !== undefined ? 6 + Math.round(p.size * 8) : 5;
          // A dark halo under a white-ringed marker, so the colour stays readable on any basemap (brown relief, white ice, green lowland).
          L.circleMarker([p.lat, p.lon], { radius: radius + 3, stroke: false, fillColor: "#111827", fillOpacity: 0.75, interactive: false }).addTo(instance);
          const m = L.circleMarker([p.lat, p.lon], { radius, color: "#ffffff", weight: 1.5, fillColor: c, fillOpacity: 0.95 }).addTo(instance);
          const box = document.createElement("div");
          const b = document.createElement("strong");
          b.textContent = p.label;
          box.appendChild(b);
          if (p.detail) {
            const d = document.createElement("div");
            d.style.whiteSpace = "pre-line";
            d.style.fontSize = "11px";
            d.textContent = p.detail;
            box.appendChild(d);
          }
          m.bindPopup(box);
          bounds.extend([p.lat, p.lon]);
        }
        if (bounds.isValid()) instance.fitBounds(bounds, { padding: [30, 30], maxZoom: map.points.length === 1 ? 8 : 10 });
        else instance.setView([20, 0], 2);
      } catch (err) {
        console.error("The map could not be drawn:", err);
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      instance?.remove();
    };
  }, [map, groups]);

  function download() {
    const blob = new Blob([csvText(map, credits)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = map.title.replace(/[^a-z0-9]+/gi, "_").slice(0, 60) + "_points.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const t = light
    ? { title: "text-gray-600", count: "text-gray-400", frame: "border-gray-300", legend: "text-gray-700", n: "text-gray-500", note: "text-gray-500", btn: "border-gray-400 text-gray-700 hover:border-blue-600 print:hidden" }
    : { title: "text-gray-400", count: "text-gray-600", frame: "border-gray-700", legend: "text-gray-300", n: "text-gray-500", note: "text-gray-500", btn: "border-gray-600 text-gray-300 hover:border-blue-500 hover:text-white" };
  return (
    <div className="mt-3">
      <div className={`mb-1 text-xs ${t.title}`}>
        {map.title} <span className={t.count}>· {map.points.length} place{map.points.length === 1 ? "" : "s"}</span>
      </div>
      {failed ? (
        <div className={`flex h-24 items-center justify-center rounded border text-xs ${t.title} ${t.frame}`}>The map could not be loaded. The places are in the download below.</div>
      ) : (
        <div ref={el} className={`h-[340px] w-full max-w-[640px] rounded border ${t.frame}`} style={{ background: "#e5e7eb" }} />
      )}
      <div className={`mt-1 flex max-w-[640px] flex-wrap gap-x-4 gap-y-0.5 text-xs ${t.legend}`}>
        {groups.map((g) => (
          <span key={g.name}>
            <span style={{ color: g.color }}>●</span> {g.name} <span className={t.n}>({g.n})</span>
          </span>
        ))}
      </div>
      {map.note && <p className={`mt-1 max-w-[640px] text-[11px] ${t.note}`}>{map.note}</p>}
      <button onClick={download} className={`mt-2 rounded border px-2 py-1 text-xs ${t.btn}`}>
        ⬇ Download places (CSV, {map.points.length} rows)
      </button>
    </div>
  );
}
