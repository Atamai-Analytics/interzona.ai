"use client";

import { useEffect, useRef, useState } from "react";
import "leaflet/dist/leaflet.css";
import { addBaseLayer } from "@/lib/leafletBase";

// Map for the Multivariate tools page: one circle per row, or one pie chart per location showing the mix of categories there
// (the R app's leaflet.minicharts pies). Only rows with valid coordinates are passed in.

export type MapPoint = { lat: number; lon: number; color: string; category: string; popup: string };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function pieSvg(parts: { n: number; color: string }[], size: number): string {
  const total = parts.reduce((a, p) => a + p.n, 0);
  const r = size / 2;
  if (parts.length === 1) return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><circle cx="${r}" cy="${r}" r="${r - 1}" fill="${parts[0].color}" stroke="#fff" stroke-width="1.5"/></svg>`;
  let a0 = -Math.PI / 2;
  const paths = parts.map((p) => {
    const a1 = a0 + (2 * Math.PI * p.n) / total;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const d = `M${r},${r} L${r + (r - 1) * Math.cos(a0)},${r + (r - 1) * Math.sin(a0)} A${r - 1},${r - 1} 0 ${large} 1 ${r + (r - 1) * Math.cos(a1)},${r + (r - 1) * Math.sin(a1)} Z`;
    a0 = a1;
    return `<path d="${d}" fill="${p.color}" stroke="#fff" stroke-width="1"/>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">${paths.join("")}</svg>`;
}

export default function ClusterMap({ points, mode, colorOf }: { points: MapPoint[]; mode: "Points" | "Pie charts"; colorOf: Map<string, string> }) {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<import("leaflet").Map | null>(null);
  const layerRef = useRef<import("leaflet").LayerGroup | null>(null);
  const LRef = useRef<typeof import("leaflet") | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

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
        setReady(true);
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
    layer.clearLayers();
    const bounds = L.latLngBounds([]);
    if (mode === "Points") {
      const r = points.length > 3000 ? 3 : 5;
      for (const p of points) {
        L.circleMarker([p.lat, p.lon], { radius: r, color: "#111827", weight: 0.6, fillColor: p.color, fillOpacity: 0.9 }).bindPopup(p.popup).addTo(layer);
        bounds.extend([p.lat, p.lon]);
      }
    } else {
      // One pie per distinct location, sized by the square root of the number of rows there.
      const groups = new Map<string, { lat: number; lon: number; counts: Map<string, number> }>();
      for (const p of points) {
        const key = `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`;
        const g = groups.get(key) ?? { lat: p.lat, lon: p.lon, counts: new Map() };
        g.counts.set(p.category, (g.counts.get(p.category) ?? 0) + 1);
        groups.set(key, g);
      }
      let maxN = 1;
      groups.forEach((g) => { const n = [...g.counts.values()].reduce((a, b) => a + b, 0); if (n > maxN) maxN = n; });
      groups.forEach((g) => {
        const parts = [...g.counts.entries()].map(([k, n]) => ({ k, n, color: colorOf.get(k) ?? "#999" }));
        const n = parts.reduce((a, p) => a + p.n, 0);
        const size = Math.round(14 + 46 * Math.sqrt(n / maxN));
        const icon = L.divIcon({ html: pieSvg(parts, size), className: "", iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
        const popup = `<strong>${n} row${n === 1 ? "" : "s"}</strong><br/>` + parts.map((p) => `<span style="color:${p.color}">●</span> ${esc(p.k)}: ${p.n}`).join("<br/>");
        L.marker([g.lat, g.lon], { icon }).bindPopup(popup).addTo(layer);
        bounds.extend([g.lat, g.lon]);
      });
    }
    if (bounds.isValid()) m.fitBounds(bounds, { padding: [30, 30], maxZoom: 12 });
  }, [ready, points, mode, colorOf]);

  if (failed) return <p className="text-sm text-red-300">The map could not be loaded.</p>;
  return <div ref={el} className="h-[620px] w-full overflow-hidden rounded-lg border border-gray-800" />;
}

export { esc as escapeHtml };
