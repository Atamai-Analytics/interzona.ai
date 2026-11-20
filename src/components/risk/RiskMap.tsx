"use client";

import { useEffect, useRef, useState } from "react";
import "leaflet/dist/leaflet.css";
import { addBaseLayer } from "@/lib/leafletBase";

// Facility map for the supply-risk scenario: one circle per USGS facility line outside the country that is cut, coloured by stage.

export type RiskPoint = { lat: number; lon: number; label: string; group: string; detail?: string };
const COLOURS: Record<string, string> = { Mine: "#f59e0b", "Brine operation": "#38bdf8", Concentrator: "#a3e635", Smelter: "#f472b6", Refinery: "#c084fc", "Other processing plant": "#2dd4bf" };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export default function RiskMap({ points }: { points: RiskPoint[] }) {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<import("leaflet").Map | null>(null);
  const layerRef = useRef<import("leaflet").LayerGroup | null>(null);
  const LRef = useRef<typeof import("leaflet") | null>(null);
  const [ready, setReady] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const L = (await import("leaflet")).default;
        if (cancelled || !el.current) return;
        const m = L.map(el.current, { worldCopyJump: true });
        addBaseLayer(L, m);
        m.setView([15, 10], 2);
        LRef.current = L;
        mapRef.current = m;
        layerRef.current = L.layerGroup().addTo(m);
        setReady((n) => n + 1);
      } catch (e) {
        console.error(e);
        setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const L = LRef.current, m = mapRef.current, layer = layerRef.current;
    if (!ready || !L || !m || !layer) return;
    m.invalidateSize();
    layer.clearLayers();
    const bounds = L.latLngBounds([]);
    for (const p of points) {
      const c = L.circleMarker([p.lat, p.lon], { radius: 5, color: "#111827", weight: 0.6, fillColor: COLOURS[p.group] ?? "#9ca3af", fillOpacity: 0.9 });
      c.bindTooltip(`<div style="white-space:normal;width:230px;line-height:1.35"><b>${esc(p.label)}</b><br/>${esc(p.group)}${p.detail ? `<br/>${esc(p.detail).replace(/\n/g, "<br/>")}` : ""}</div>`, { sticky: true, direction: "top" });
      c.addTo(layer);
      bounds.extend([p.lat, p.lon]);
    }
    if (bounds.isValid()) m.fitBounds(bounds, { padding: [30, 30], maxZoom: 6 });
  }, [ready, points]);

  if (failed) return <p className="text-sm text-red-300">The map could not be loaded.</p>;
  const groups = [...new Set(points.map((p) => p.group))];
  return (
    <div className="relative">
      <div ref={el} className="h-[420px] w-full overflow-hidden rounded-lg border border-gray-800" />
      {groups.length > 0 && (
        <div className="pointer-events-none absolute bottom-3 right-3 z-[500] rounded-md bg-gray-950/85 px-3 py-2 text-xs text-gray-200 shadow">
          {groups.map((g) => (
            <p key={g} className="flex items-center gap-2"><span className="inline-block h-3 w-3 rounded-full" style={{ background: COLOURS[g] ?? "#9ca3af" }} />{g}</p>
          ))}
        </div>
      )}
    </div>
  );
}
