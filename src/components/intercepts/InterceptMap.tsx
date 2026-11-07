"use client";

import { useEffect, useRef, useState } from "react";
import "leaflet/dist/leaflet.css";
import { addBaseLayer } from "@/lib/leafletBase";

// Collar map for the Drill intercepts page: one circle per hole with a position; holes with an intercept are orange and sized by their best
// grade x length, the others are small and grey. Clicking a collar selects the hole for the strip log.

export type CollarPoint = { id: string; lat: number; lon: number; label: string; hit: boolean; size: number; selected: boolean };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export default function InterceptMap({ points, onSelect }: { points: CollarPoint[]; onSelect: (id: string) => void }) {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<import("leaflet").Map | null>(null);
  const layerRef = useRef<import("leaflet").LayerGroup | null>(null);
  const LRef = useRef<typeof import("leaflet") | null>(null);
  const fittedRef = useRef("");
  const selectRef = useRef(onSelect);
  const [ready, setReady] = useState(0); // bumped each time a map is created, so markers are redrawn on a new map
  const [failed, setFailed] = useState(false);
  selectRef.current = onSelect;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const L = (await import("leaflet")).default;
        if (cancelled || !el.current) return;
        const m = L.map(el.current, { worldCopyJump: true });
        addBaseLayer(L, m);
        m.setView([0, 0], 2);
        LRef.current = L;
        mapRef.current = m;
        layerRef.current = L.layerGroup().addTo(m);
        fittedRef.current = "";
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
    const ordered = [...points].sort((a, b) => Number(a.hit) - Number(b.hit) || Number(a.selected) - Number(b.selected));
    for (const p of ordered) {
      const c = L.circleMarker([p.lat, p.lon], {
        radius: p.hit ? 4 + 10 * p.size : 3,
        color: p.selected ? "#ffffff" : "#111827",
        weight: p.selected ? 2.5 : 0.6,
        fillColor: p.hit ? "#f97316" : "#9ca3af",
        fillOpacity: p.hit ? 0.9 : 0.6,
      });
      c.bindTooltip(esc(p.label));
      c.on("click", () => selectRef.current(p.id));
      c.addTo(layer);
      bounds.extend([p.lat, p.lon]);
    }
    // Fit once per set of holes, not on every selection change.
    const key = points.map((p) => p.id).join(",");
    if (bounds.isValid() && key !== fittedRef.current) {
      fittedRef.current = key;
      m.fitBounds(bounds, { padding: [30, 30], maxZoom: 13 });
    }
  }, [ready, points]);

  if (failed) return <p className="text-sm text-red-300">The map could not be loaded.</p>;
  return <div ref={el} className="h-[440px] w-full overflow-hidden rounded-lg border border-gray-800" />;
}
