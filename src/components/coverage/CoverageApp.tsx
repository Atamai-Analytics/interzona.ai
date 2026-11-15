"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import "leaflet/dist/leaflet.css";
import { card, downloadText, heading } from "@/components/multivariate/ui";
import { datasetName } from "@/lib/geochem-methods";

// World coverage map (/tools/coverage): countries shaded by how many samples, analyses, occurrences, deposits, drill holes or library
// documents the database holds there. Counts come from /api/country-coverage (core.country_coverage, rebuilt by
// gold_schema/build_country_coverage.py); boundaries are Natural Earth 1:50m admin-0 (public domain), simplified, in
// public/coverage-countries.geojson keyed by ADM0_A3. Colour classes are powers of ten, because counts run from a handful to tens of millions.

type Row = {
  a3: string; name: string; samples: number; analyses: number; occurrences: number; deposits: number; drill_holes: number; documents: number;
  sample_sources: string | null; updated_at: string;
};
type Metric = "samples" | "analyses" | "occurrences" | "deposits" | "drill_holes" | "documents";
const METRICS: { key: Metric; label: string; note: string }[] = [
  { key: "samples", label: "Samples", note: "geochemical samples (rock, soil, stream sediment, till, drill core...)" },
  { key: "analyses", label: "Analyses", note: "active analytical results (one element on one sample = one analysis)" },
  { key: "occurrences", label: "Occurrences", note: "active mineral occurrences, deposits, mines and facilities" },
  { key: "deposits", label: "Deposits", note: "occurrences flagged as deposits" },
  { key: "drill_holes", label: "Drill holes", note: "drill holes with collar locations" },
  { key: "documents", label: "Documents", note: "library documents tagged to the country or one of its states or provinces" },
];
// Dark (few) to bright (many) on the dark base map; class i covers [10^i, 10^(i+1)).
const RAMP = ["#3b2a6e", "#3e4a8c", "#35648f", "#2a7e8e", "#20978a", "#35b07a", "#7cc75a", "#c8dc3c", "#fde725"];
const fmt = (v: number) => v.toLocaleString("en-US");
const short = (v: number) => (v >= 1e6 ? `${+(v / 1e6).toPrecision(3)}M` : v >= 1e3 ? `${+(v / 1e3).toPrecision(3)}k` : String(v));
const cls = (v: number) => (v > 0 ? Math.min(RAMP.length - 1, Math.floor(Math.log10(v))) : -1);
const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] as string);
// sample_sources is "SOURCE_SYSTEM n, SOURCE_SYSTEM n, ..." (largest first); shown with the readable dataset names.
const topSources = (s: string | null, n: number) =>
  (s ? s.split(", ").slice(0, n) : []).map((x) => {
    const i = x.lastIndexOf(" ");
    return { name: datasetName(x.slice(0, i)), n: Number(x.slice(i + 1)) };
  });

export function CoverageApp() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [geo, setGeo] = useState<GeoJSON.FeatureCollection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [metric, setMetric] = useState<Metric>("samples");
  const [picked, setPicked] = useState<string | null>(null);
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<import("leaflet").Map | null>(null);
  const LRef = useRef<typeof import("leaflet") | null>(null);
  const layerRef = useRef<import("leaflet").GeoJSON | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/country-coverage").then((r) => r.json()),
      fetch("/coverage-countries.geojson").then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); }),
    ])
      .then(([c, g]) => {
        if (cancelled) return;
        if (c.error) setError(c.error);
        else { setRows(c.rows); setGeo(g); }
      })
      .catch(() => !cancelled && setError("Could not load the coverage figures. Please reload the page."));
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let ro: ResizeObserver | null = null;
    (async () => {
      const L = (await import("leaflet")).default;
      if (cancelled || !el.current) return;
      // No tile layer: country fills on a plain sea read better than fills over terrain, and every land area gets a fill (grey = none).
      const m = L.map(el.current, { zoomSnap: 0.25, zoomDelta: 0.5, minZoom: 1.5, maxBounds: [[-85, -220], [88, 220]], attributionControl: true });
      m.attributionControl.setPrefix(false).addAttribution("Boundaries: Natural Earth");
      m.setView([25, 10], 2);
      LRef.current = L;
      mapRef.current = m;
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

  const byA3 = useMemo(() => new Map((rows ?? []).map((r) => [r.a3, r])), [rows]);
  const offshore = byA3.get("OFF");
  const ranked = useMemo(() => (rows ?? []).filter((r) => r.a3 !== "OFF" && r[metric] > 0).sort((a, b) => b[metric] - a[metric]), [rows, metric]);
  const totals = useMemo(() => {
    const t = { samples: 0, analyses: 0, occurrences: 0, deposits: 0, drill_holes: 0, documents: 0 } as Record<Metric, number>;
    for (const r of rows ?? []) for (const m of METRICS) t[m.key] += r[m.key];
    return t;
  }, [rows]);
  const maxCls = useMemo(() => Math.max(0, ...ranked.map((r) => cls(r[metric]))), [ranked, metric]);

  // Choropleth layer, redrawn when the metric changes.
  useEffect(() => {
    const L = LRef.current, m = mapRef.current;
    if (!ready || !L || !m || !geo || !rows) return;
    layerRef.current?.remove();
    const tip = (a3: string, name: string) => {
      const r = byA3.get(a3);
      if (!r) return `<b>${esc(name)}</b><br/>Nothing in the database yet`;
      const lines = METRICS.map((x) => `${x.key === metric ? "<b>" : ""}${x.label}: ${fmt(r[x.key])}${x.key === metric ? "</b>" : ""}`);
      const src = topSources(r.sample_sources, 3);
      // Leaflet tooltips do not wrap by default; a fixed width keeps long source lists readable.
      return `<div style="white-space:normal;width:230px;line-height:1.35"><b>${esc(r.name)}</b><br/>${lines.join("<br/>")}${src.length ? `<br/><span style="color:#6b7280;font-size:11px">Main sample sources: ${esc(src.map((x) => x.name).join("; "))}</span>` : ""}</div>`;
    };
    const layer = L.geoJSON(geo, {
      style: (f) => {
        const v = byA3.get(f?.properties?.a3)?.[metric] ?? 0;
        const k = cls(v);
        return k < 0
          ? { color: "#4b5563", weight: 0.5, fillColor: "#1f2937", fillOpacity: 1, opacity: 0.8 }
          : { color: "#111827", weight: 0.6, fillColor: RAMP[k], fillOpacity: 1, opacity: 0.9 };
      },
      onEachFeature: (f, lyr) => {
        const { a3, name } = f.properties as { a3: string; name: string };
        lyr.bindTooltip(tip(a3, name), { sticky: true, direction: "top", className: "text-xs" });
        lyr.on({
          mouseover: (e) => (e.target as import("leaflet").Path).setStyle({ weight: 2, color: "#f9fafb" }),
          mouseout: (e) => layer.resetStyle(e.target),
          click: () => setPicked(a3),
        });
      },
    }).addTo(m);
    layerRef.current = layer;
  }, [ready, geo, rows, byA3, metric]);

  const pickedRow = picked ? byA3.get(picked) : undefined;
  const pickedName = pickedRow?.name ?? (picked && geo ? (geo.features.find((f) => f.properties?.a3 === picked)?.properties?.name as string) : null);
  const metricInfo = METRICS.find((m) => m.key === metric)!;
  const updated = rows?.[0]?.updated_at ? new Date(rows[0].updated_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : null;

  const downloadCsv = () => {
    const head = ["country", "adm0_a3", ...METRICS.map((m) => m.key), "sample_sources"];
    const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const lines = (rows ?? []).map((r) => [r.name, r.a3, ...METRICS.map((m) => String(r[m.key])), r.sample_sources ?? ""].map(q).join(","));
    downloadText("interzona_country_coverage.csv", [head.join(","), ...lines].join("\n") + "\n");
  };

  return (
    <div className="min-h-dvh bg-gray-950 text-gray-100">
      <header className="flex flex-wrap items-center gap-3 border-b border-gray-800 px-4 py-3">
        <Link href="/" className="text-sm text-gray-400 hover:text-gray-200">← Assistant</Link>
        <h1 className="text-lg font-semibold">World coverage</h1>
        <p className="text-xs text-gray-400">What the database holds, country by country.</p>
        <div className="ml-auto flex gap-3 text-xs">
          <Link href="/tools/geochemistry" className="text-sky-300 hover:underline">Geochemistry</Link>
          <Link href="/tools/geostatistics" className="text-violet-300 hover:underline">Geostatistics</Link>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-4 p-4">
        {error && <p className="rounded border border-red-800 bg-red-950/40 px-3 py-2 text-sm text-red-200">{error}</p>}

        <section className={`${card} space-y-3`}>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="What to count">
            {METRICS.map((m) => (
              <button
                key={m.key}
                role="radio"
                aria-checked={metric === m.key}
                onClick={() => setMetric(m.key)}
                className={`rounded-md border px-3 py-1.5 text-left text-sm ${metric === m.key ? "border-emerald-500 bg-emerald-900/40 text-emerald-100" : "border-gray-700 text-gray-300 hover:border-gray-500"}`}
              >
                <span className="block font-medium">{m.label}</span>
                <span className="block text-xs text-gray-400">{rows ? short(totals[m.key]) : "…"}</span>
              </button>
            ))}
          </div>
          <p className="text-xs text-gray-400">Shaded by {metricInfo.note}. Hover a country for all its counts; click it for its sources.</p>

          <div className="relative">
            <div ref={el} className="h-[60vh] min-h-[380px] w-full overflow-hidden rounded-md border border-gray-800" style={{ background: "#0b1220" }} />
            {!rows && !error && <p className="absolute inset-0 grid place-items-center text-sm text-gray-400">Loading…</p>}
            {rows && (
              <div className="pointer-events-none absolute bottom-3 left-3 z-[500] rounded-md bg-gray-950/85 px-3 py-2 text-xs text-gray-200 shadow">
                <p className="mb-1 font-medium">{metricInfo.label}</p>
                {RAMP.slice(0, maxCls + 1).map((c, i) => (
                  <p key={c} className="flex items-center gap-2">
                    <span className="inline-block h-3 w-5 rounded-sm" style={{ background: c }} />
                    {i === maxCls ? `${short(10 ** i)} or more` : `${short(10 ** i)} – ${short(10 ** (i + 1))}`}
                  </p>
                ))}
                <p className="flex items-center gap-2 text-gray-400"><span className="inline-block h-3 w-5 rounded-sm border border-gray-600" style={{ background: "#1f2937" }} />none</p>
              </div>
            )}
          </div>

          <p className="text-xs text-gray-500">
            Counts cover everything the database holds, whatever the licence or quality of each record, so a high count is not the same as
            usable or complete data. Each point is placed by its coordinates in Natural Earth country boundaries (points within about 25 km
            of a coast go to the nearest country){offshore ? `; ${fmt(offshore.samples)} samples, ${fmt(offshore.occurrences)} occurrences and ${fmt(offshore.drill_holes)} drill holes lie further offshore and are not shown` : ""}.
            Boundaries (Natural Earth) are drawn for reference only and imply no view on disputed borders. {updated && `Figures updated ${updated}.`}
          </p>
        </section>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <section className={`${card} lg:col-span-1`}>
            <h2 className={heading}>{pickedName ?? "Pick a country"}</h2>
            {!picked ? (
              <p className="mt-2 text-sm text-gray-400">Click a country on the map or in the table to see its counts and where its samples come from.</p>
            ) : !pickedRow ? (
              <p className="mt-2 text-sm text-gray-400">Nothing in the database for this country yet.</p>
            ) : (
              <div className="mt-2 space-y-3 text-sm">
                <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
                  {METRICS.map((m) => (
                    <div key={m.key} className="contents">
                      <dt className="text-gray-400">{m.label}</dt>
                      <dd className="text-right tabular-nums">{fmt(pickedRow[m.key])}</dd>
                    </div>
                  ))}
                </dl>
                {pickedRow.sample_sources && (
                  <div>
                    <p className="mb-1 text-xs font-medium text-gray-400">Sample sources (dataset and sample count)</p>
                    <ul className="max-h-60 space-y-0.5 overflow-auto text-xs text-gray-300">
                      {topSources(pickedRow.sample_sources, 50).map((x, i) => <li key={i} className="flex justify-between gap-3"><span>{x.name}</span><span className="tabular-nums text-gray-400">{fmt(x.n)}</span></li>)}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </section>

          <section className={`${card} lg:col-span-2`}>
            <div className="mb-2 flex items-baseline gap-3">
              <h2 className={heading}>Countries by {metricInfo.label.toLowerCase()}</h2>
              <span className="text-xs text-gray-500">{ranked.length} countries</span>
              <button onClick={downloadCsv} disabled={!rows} className="ml-auto text-xs text-emerald-300 underline hover:text-emerald-200 disabled:opacity-40">Download CSV</button>
            </div>
            <div className="max-h-[420px] overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-gray-900 text-xs text-gray-400">
                  <tr>
                    <th className="py-1 text-left font-medium">#</th>
                    <th className="py-1 text-left font-medium">Country</th>
                    {METRICS.map((m) => (
                      <th key={m.key} className={`py-1 pl-3 text-right font-medium ${m.key === metric ? "text-emerald-300" : ""}`}>
                        <button onClick={() => setMetric(m.key)} className="hover:underline">{m.label}</button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {ranked.map((r, i) => (
                    <tr key={r.a3} onClick={() => setPicked(r.a3)} className={`cursor-pointer border-t border-gray-800 hover:bg-gray-800/50 ${picked === r.a3 ? "bg-emerald-900/30" : ""}`}>
                      <td className="py-1 text-gray-500 tabular-nums">{i + 1}</td>
                      <td className="py-1">{r.name}</td>
                      {METRICS.map((m) => (
                        <td key={m.key} className={`py-1 pl-3 text-right tabular-nums ${m.key === metric ? "text-gray-100" : "text-gray-400"}`}>{r[m.key] ? fmt(r[m.key]) : "–"}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
