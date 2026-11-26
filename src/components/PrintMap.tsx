"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { MapData } from "@/lib/types";
import { addBaseLayer } from "@/lib/leafletBase";
import { mapGroups } from "@/lib/mapColors";
import "leaflet/dist/leaflet.css";

// A fixed-size, non-interactive copy of an answer's map for the PDF export. It reports onReady once the basemap tiles have loaded (or the
// map failed), so printing waits for a complete picture. The tile provider's credit stays on the map, as its terms require.
export default function PrintMap({ map, onReady }: { map: MapData; onReady: () => void }) {
  const el = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const groups = useMemo(() => mapGroups(map), [map]);
  const ready = useRef(onReady);
  ready.current = onReady;

  useEffect(() => {
    let cancelled = false;
    let instance: import("leaflet").Map | null = null;
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        ready.current();
      }
    };
    (async () => {
      try {
        const L = (await import("leaflet")).default;
        if (cancelled || !el.current) return;
        instance = L.map(el.current, { zoomControl: false, dragging: false, scrollWheelZoom: false, doubleClickZoom: false, boxZoom: false, keyboard: false, touchZoom: false, fadeAnimation: false, zoomAnimation: false, markerZoomAnimation: false });
        const layer = addBaseLayer(L, instance);
        layer.on("load", finish);
        const color = new Map(groups.map((g) => [g.name, g.color]));
        const bounds = L.latLngBounds([]);
        for (const p of map.points) {
          const radius = p.size !== undefined ? 5 + Math.round(p.size * 6) : 4;
          L.circleMarker([p.lat, p.lon], { radius: radius + 2, stroke: false, fillColor: "#111827", fillOpacity: 0.7, interactive: false }).addTo(instance);
          L.circleMarker([p.lat, p.lon], { radius, color: "#ffffff", weight: 1.2, fillColor: color.get(p.group) ?? "#60a5fa", fillOpacity: 0.95, interactive: false }).addTo(instance);
          bounds.extend([p.lat, p.lon]);
        }
        if (bounds.isValid()) instance.fitBounds(bounds, { padding: [24, 24], maxZoom: map.points.length === 1 ? 8 : 10, animate: false });
        else instance.setView([20, 0], 2, { animate: false });
      } catch (err) {
        console.error("The map could not be drawn for the PDF:", err);
        if (!cancelled) setFailed(true);
        finish();
      }
    })();
    return () => {
      cancelled = true;
      instance?.remove();
    };
  }, [map, groups]);

  return (
    <div className="my-2 break-inside-avoid">
      <div className="text-[11px] text-gray-600">
        {map.title} · {map.points.length} place{map.points.length === 1 ? "" : "s"}
      </div>
      {failed ? (
        <div className="flex h-16 w-[640px] items-center justify-center border border-gray-300 text-[11px] text-gray-500">The map could not be drawn; the places are listed below.</div>
      ) : (
        <div ref={el} className="h-[340px] w-[640px] border border-gray-300" style={{ background: "#e5e7eb" }} />
      )}
      <div className="mt-1 flex max-w-[640px] flex-wrap gap-x-4 text-[11px] text-gray-700">
        {groups.map((g) => (
          <span key={g.name}>
            <span style={{ color: g.color }}>●</span> {g.name} ({g.n})
          </span>
        ))}
      </div>
      {map.note && <p className="mt-1 max-w-[640px] text-[11px] text-gray-500">{map.note}</p>}
    </div>
  );
}
