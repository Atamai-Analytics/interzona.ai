"use client";

import { useEffect, useRef, useState } from "react";
import "leaflet/dist/leaflet.css";
import { addBaseLayer } from "@/lib/leafletBase";
import type { Grid } from "@/lib/geostat/engine";
import { gridToDataUrl, rampCss, RAMP_GRADIENT } from "./render";

// One grid band (estimate or kriging error) as a coloured overlay on the base map, with the samples drawn on top in the same colour scale
// (smoothing hides single high samples, so the points always stay visible). Below-detection samples are hollow circles.

export type MapSample = { lon: number; lat: number; t: number; bdl: boolean; popup: string };

export default function GridMap({
  grid, band, lo, hi, samples, legendTitle, legendTicks, showSamples, colourSamples,
}: {
  grid: Grid | null; band: "z" | "sd"; lo: number; hi: number; samples: MapSample[]; legendTitle: string; legendTicks: { t: number; label: string }[];
  showSamples: boolean; colourSamples: boolean;
}) {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<import("leaflet").Map | null>(null);
  const LRef = useRef<typeof import("leaflet") | null>(null);
  const layerRef = useRef<import("leaflet").LayerGroup | null>(null);
  const fittedRef = useRef<string>("");
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const L = (await import("leaflet")).default;
        if (cancelled || !el.current) return;
        const m = L.map(el.current, { preferCanvas: true });
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
    if (grid) {
      const url = gridToDataUrl(grid, band === "z" ? grid.z : grid.sd, lo, hi, true);
      const b = L.latLngBounds([grid.south, grid.west], [grid.north, grid.east]);
      L.imageOverlay(url, b, { opacity: 0.85, interactive: false }).addTo(layer);
      bounds.extend(b);
    }
    if (showSamples) {
      const r = samples.length > 2500 ? 2.5 : 3.5;
      const span = hi - lo || 1;
      for (const s of samples) {
        const fill = colourSamples ? rampCss((s.t - lo) / span) : "#ffffff";
        L.circleMarker([s.lat, s.lon], s.bdl
          ? { radius: r, color: "#9ca3af", weight: 1, fill: false }
          : { radius: r, color: "#111827", weight: 0.6, fillColor: fill, fillOpacity: 0.95 }
        ).bindPopup(s.popup).addTo(layer);
        bounds.extend([s.lat, s.lon]);
      }
    }
    // Fit the view once per grid extent, not on every redraw (the user may have zoomed in).
    const key = grid ? `${grid.west},${grid.south},${grid.east},${grid.north}` : `${samples.length}`;
    if (bounds.isValid() && fittedRef.current !== key) {
      m.fitBounds(bounds, { padding: [20, 20], maxZoom: 13 });
      fittedRef.current = key;
    }
  }, [ready, grid, band, lo, hi, samples, showSamples, colourSamples]);

  if (failed) return <p className="text-sm text-red-300">The map could not be loaded.</p>;
  return (
    <div className="space-y-1">
      <div ref={el} className="h-[460px] w-full overflow-hidden rounded-lg border border-gray-800" />
      <div className="text-[11px] text-gray-400">
        <div className="flex items-center justify-between"><span>{legendTitle}</span></div>
        <div className="mt-0.5 h-2.5 w-full rounded" style={{ background: RAMP_GRADIENT }} />
        <div className="relative h-4">
          {legendTicks.map((t, i) => {
            const pos = Math.min(100, Math.max(0, ((t.t - lo) / (hi - lo || 1)) * 100));
            return (
              <span key={i} className="absolute whitespace-nowrap" style={{ left: `${pos}%`, transform: `translateX(${pos < 8 ? 0 : pos > 92 ? -100 : -50}%)` }}>{t.label}</span>
            );
          })}
        </div>
      </div>
    </div>
  );
}
