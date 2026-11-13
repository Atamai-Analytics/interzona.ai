"use client";

import { useEffect, useRef, useState } from "react";
import "leaflet/dist/leaflet.css";
import { addBaseLayer } from "@/lib/leafletBase";
import { MAX_SPAN_KM, spanKm } from "@/lib/geostat/limits";

// Area picker for the Geostatistics page: shows where the chosen dataset's samples are, draws the current area as an orange box, and sets the
// area from the map view ("Use map view") or the whole extent, so nobody has to type coordinates.

type Box = [number, number, number, number]; // west, south, east, north
const round = (v: number) => Number(v.toFixed(3));

export default function AreaPicker({ points, extent, box, onBox }: { points: [number, number][]; extent: Box | null; box: Box | null; onBox: (b: Box) => void }) {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<import("leaflet").Map | null>(null);
  const LRef = useRef<typeof import("leaflet") | null>(null);
  const ptsRef = useRef<import("leaflet").LayerGroup | null>(null);
  const rectRef = useRef<import("leaflet").Rectangle | null>(null);
  const [ready, setReady] = useState(false);
  const [note, setNote] = useState("");

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
      ptsRef.current = L.layerGroup().addTo(m);
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

  // Sample locations; fit the view to the whole extent when the dataset or element changes.
  useEffect(() => {
    const L = LRef.current, m = mapRef.current, layer = ptsRef.current;
    if (!ready || !L || !m || !layer) return;
    layer.clearLayers();
    for (const [lon, lat] of points) L.circleMarker([lat, lon], { radius: 1.8, stroke: false, fillColor: "#10b981", fillOpacity: 0.8, interactive: false }).addTo(layer);
    if (extent) m.fitBounds([[extent[1], extent[0]], [extent[3], extent[2]]], { padding: [15, 15] });
  }, [ready, points, extent]);

  // The current area.
  useEffect(() => {
    const L = LRef.current, m = mapRef.current;
    if (!ready || !L || !m) return;
    rectRef.current?.remove();
    rectRef.current = box ? L.rectangle([[box[1], box[0]], [box[3], box[2]]], { color: "#f97316", weight: 2, fill: false, dashArray: "6 4", interactive: false }).addTo(m) : null;
  }, [ready, box]);

  function useView() {
    const m = mapRef.current;
    if (!m) return;
    const b = m.getBounds();
    let w = b.getWest(), s = b.getSouth(), e = b.getEast(), n = b.getNorth();
    if (extent) { // no point extending the area beyond the samples
      w = Math.max(w, extent[0]); s = Math.max(s, extent[1]); e = Math.min(e, extent[2]); n = Math.min(n, extent[3]);
    }
    if (!(w < e && s < n)) return;
    // A view larger than one grid allows is trimmed to the largest allowed box around its centre.
    const sp = spanKm([w, s, e, n]), lim = MAX_SPAN_KM * 0.98;
    let trimmed = false;
    if (sp.ew > lim) { const c = (w + e) / 2, h = ((e - w) / 2) * (lim / sp.ew); w = c - h; e = c + h; trimmed = true; }
    if (sp.ns > lim) { const c = (s + n) / 2, h = ((n - s) / 2) * (lim / sp.ns); s = c - h; n = c + h; trimmed = true; }
    setNote(trimmed ? `The map view was larger than ${MAX_SPAN_KM} km, so the area was trimmed around its centre.` : "");
    onBox([round(w), round(s), round(e), round(n)]);
  }

  return (
    <div className="space-y-1.5">
      <div ref={el} className="h-[300px] w-full overflow-hidden rounded border border-gray-800" />
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <button className="rounded bg-orange-600 px-2 py-1 font-medium text-white hover:bg-orange-500" onClick={useView}>Use map view as the area</button>
        {extent && <button className="text-gray-300 underline" onClick={() => { setNote(""); onBox(extent.map(round) as Box); }}>Whole extent</button>}
        <span className="text-gray-500">Green dots: where this element was analysed (up to 4,000 shown). Orange box: the area.</span>
      </div>
      {note && <p className="text-xs text-amber-300/90">{note}</p>}
    </div>
  );
}
