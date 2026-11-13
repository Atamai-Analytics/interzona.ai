"use client";

import { useEffect, useRef, useState } from "react";
import "leaflet/dist/leaflet.css";
import { addBaseLayer } from "@/lib/leafletBase";
import type { CatchmentPour } from "@/lib/geostat/data";

// Stream-sediment catchment map: every sample catchment basin (the ground draining to the sample, minus what drains to the next sample
// upstream) filled with the colour of its value class, with the sampled stream points on top. Catchments whose sample could not be placed
// on a mapped stream (tiny upstream area) get a dashed orange outline.

export type PourStyle = { colour: string; popup: string; weak: boolean };

export default function CatchmentMap({ pours, styleOf, showPoints }: { pours: CatchmentPour[]; styleOf: (p: CatchmentPour) => PourStyle | null; showPoints: boolean }) {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<import("leaflet").Map | null>(null);
  const LRef = useRef<typeof import("leaflet") | null>(null);
  const layerRef = useRef<import("leaflet").LayerGroup | null>(null);
  const fittedRef = useRef<unknown>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let ro: ResizeObserver | null = null;
    (async () => {
      const L = (await import("leaflet")).default;
      if (cancelled || !el.current) return;
      const m = L.map(el.current, { preferCanvas: true, zoomSnap: 0.25, zoomDelta: 0.5 });
      addBaseLayer(L, m);
      m.setView([0, 0], 2);
      LRef.current = L;
      mapRef.current = m;
      layerRef.current = L.layerGroup().addTo(m);
      ro = new ResizeObserver(() => m.invalidateSize());
      ro.observe(el.current);
      setReady(true);
    })();
    return () => {
      cancelled = true;
      ro?.disconnect();
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const L = LRef.current, m = mapRef.current, layer = layerRef.current;
    if (!ready || !L || !m || !layer) return;
    layer.clearLayers();
    const renderer = L.canvas({ padding: 0.3 });
    const bounds = L.latLngBounds([]);
    for (const p of pours) {
      const st = styleOf(p);
      if (!st) continue;
      const g = L.geoJSON(p.geometry as GeoJSON.GeoJsonObject, {
        style: {
          renderer, fillColor: st.colour, fillOpacity: 0.78, weight: st.weak ? 1.2 : 0.4, color: st.weak ? "#f97316" : "#111827",
          dashArray: st.weak ? "3 3" : undefined,
        } as import("leaflet").PathOptions,
      }).bindPopup(st.popup);
      g.addTo(layer);
      bounds.extend(g.getBounds());
      if (showPoints) L.circleMarker([p.lat, p.lon], { renderer, radius: 1.6, stroke: false, fillColor: "#0b0f19", fillOpacity: 0.9, interactive: false }).addTo(layer);
    }
    if (bounds.isValid() && fittedRef.current !== pours) {
      m.fitBounds(bounds, { padding: [15, 15], maxZoom: 12 });
      fittedRef.current = pours;
    }
  }, [ready, pours, styleOf, showPoints]);

  return <div ref={el} className="h-[560px] w-full overflow-hidden rounded-lg border border-gray-800" />;
}
