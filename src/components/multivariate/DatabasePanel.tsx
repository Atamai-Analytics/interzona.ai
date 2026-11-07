"use client";

import { useEffect, useMemo, useState } from "react";
import type { Options, SampleResponse } from "@/lib/geochem-extract";
import type { Table } from "@/lib/dimred/math";
import { Check, Notice, btnRun, card, heading, input, label } from "./ui";

// "Load from the Interzona database" panel: pick datasets, sample types, an optional area and elements, then load a random sample of
// geochem.sample_chemistry_wide into the Data tab.

const DATASET_NAMES: Record<string, string> = {
  ARGENTINA_SEGEMAR: "Argentina (SEGEMAR)",
  AUSTRALIA_VIC_GSV_GEOCHEMISTRY: "Victoria, Australia (GSV)",
  AUSTRALIA_TAS_MRT: "Tasmania, Australia (MRT)",
  CANADA_QC_SIGEOM: "Québec, Canada (SIGÉOM rock)",
  CANADA_QC_SIGEOM_SED: "Québec, Canada (SIGÉOM sediment, soil, till)",
  CANADA_NRCAN_CDOGS: "Canada (NRCan CDoGS federal surveys)",
  CANADA_ATHABASCA_OF7792: "Athabasca Basin, Canada (GSC OF 7792 uranium drill core)",
  CANADA_SK_SGS: "Saskatchewan, Canada (SGS)",
  FINLAND_GTK_ROCK: "Finland (GTK)",
  GREENLAND_GEUS: "Greenland (GEUS)",
  SWEDEN_SGU_LITHOGEOCHEMISTRY: "Sweden (SGU rock)",
  SWEDEN_SGU_MARKGEOKEMI: "Sweden (SGU till, sediment, soil)",
  SWEDEN_SGU_BIOGEOKEMI: "Sweden (SGU stream plants, dry weight)",
  USA_USGS_NGDB: "USA (USGS NGDB)",
};
const datasetName = (s: string) => DATASET_NAMES[s] ?? s;

const PRESETS: { name: string; codes: string[][] }[] = [
  { name: "Major oxides", codes: [["sio2_t"], ["tio2_t"], ["al2o3_t"], ["feto3_t", "fe2o3_t"], ["mno_t"], ["mgo_t"], ["cao_t"], ["na2o_t"], ["k2o_t"], ["p2o5_t"]] },
  { name: "REE", codes: ["la", "ce", "pr", "nd", "sm", "eu", "gd", "tb", "dy", "ho", "er", "tm", "yb", "lu"].map((e) => [`${e}_t`, `${e}_p`]) },
  { name: "Base metals", codes: ["cu", "pb", "zn", "ni", "co"].map((e) => [`${e}_t`, `${e}_p`]) },
  { name: "Battery metals", codes: ["li", "co", "ni", "mn", "v", "cu"].map((e) => [`${e}_t`, `${e}_p`]) },
];

export type DbLoad = { table: Table; name: string; dims: string[]; classCol: string; note: string };

/** Turns the server's rows into a Data-tab table. Values below detection have no stored limit in the wide table, so the lowest detected value of
 *  that element in the selection stands in as the limit (flagged "<" like a CSV value, so the Data tab's detection-limit options apply). */
function toTable(r: SampleResponse): { table: Table; proxied: number } {
  // sample_id and the descriptive columns come first and are text; lon, lat and the elements are numbers.
  const firstNumber = r.columns.indexOf("lon");
  const numeric = r.columns.map((_, j) => j >= firstNumber);
  const rows = r.rows.map((row) => [...row]);
  const lt = r.columns.map(() => new Set<number>());
  const minDetected = r.columns.map((_, j) => {
    let m = Infinity;
    for (const row of rows) { const v = row[j]; if (typeof v === "number" && v > 0 && v < m) m = v; }
    return Number.isFinite(m) ? m : null;
  });
  let proxied = 0;
  r.bdl.forEach((cols, i) => cols.forEach((j) => { const m = minDetected[j]; if (m !== null) { rows[i][j] = m; lt[j].add(i); proxied++; } }));
  return { table: { columns: r.labels, rows, numeric, lt, meta: { credits: r.credits, restricted: r.restricted, bdlProxy: proxied > 0 } }, proxied };
}

export function DatabasePanel({ onLoad, onClose }: { onLoad: (l: DbLoad) => void; onClose: () => void }) {
  const [options, setOptions] = useState<Options | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [groups, setGroups] = useState<Set<string>>(new Set());
  const [lith, setLith] = useState<Set<string>>(new Set());
  const [useBox, setUseBox] = useState(false);
  const [box, setBox] = useState({ w: "", s: "", e: "", n: "" });
  const [elements, setElements] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [limit, setLimit] = useState(5000);
  const [requireAll, setRequireAll] = useState(true);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch("/api/geochem/options")
      .then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error ?? "Could not load the options."); setOptions(j); })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const key = (s: string, t: string) => `${s}|${t}`;
  const bySource = useMemo(() => {
    const m = new Map<string, Options["groups"]>();
    options?.groups.forEach((g) => m.set(g.source, [...(m.get(g.source) ?? []), g].sort((a, b) => b.n - a.n)));
    return [...m.entries()].sort((a, b) => datasetName(a[0]).localeCompare(datasetName(b[0])));
  }, [options]);
  const chosen = useMemo(() => options?.groups.filter((g) => groups.has(key(g.source, g.sampleType))) ?? [], [options, groups]);
  const total = chosen.reduce((a, g) => a + g.n, 0);
  const coverage = useMemo(() => {
    if (!options || total === 0) return [];
    return options.columns
      .map((c) => ({ ...c, n: chosen.reduce((a, g) => a + (g.counts[c.code] ?? 0), 0) }))
      .filter((c) => c.n > 0)
      .sort((a, b) => b.n - a.n);
  }, [options, chosen, total]);
  const shown = coverage.filter((c) => (showAll || c.n / total >= 0.05 || elements.includes(c.code)) && (!search || c.label.toLowerCase().includes(search.toLowerCase())));
  const includesGreenland = chosen.some((g) => g.source === "GREENLAND_GEUS");

  function toggleGroup(k: string) {
    const next = new Set(groups);
    if (next.has(k)) next.delete(k); else next.add(k);
    setGroups(next);
  }
  function toggleSource(source: string, list: Options["groups"]) {
    const keys = list.map((g) => key(source, g.sampleType));
    const allOn = keys.every((k) => groups.has(k));
    const next = new Set(groups);
    keys.forEach((k) => (allOn ? next.delete(k) : next.add(k)));
    setGroups(next);
  }
  function preset(codes: string[][]) {
    const have = new Set(coverage.map((c) => c.code));
    const picks = codes.map((alts) => alts.find((c) => have.has(c))).filter((c): c is string => !!c);
    setElements([...new Set([...elements, ...picks])]);
  }

  async function load() {
    if (!options) return;
    const bbox = useBox ? [box.w, box.s, box.e, box.n].map(Number) : null;
    if (bbox && bbox.some((v) => !Number.isFinite(v))) { setError("Fill in all four edges of the area, in decimal degrees."); return; }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/geochem/samples", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groups: chosen.map((g) => ({ source: g.source, sampleType: g.sampleType })), lithologyCategories: [...lith], bbox, columns: elements, requireAll, limit, seed: Math.floor(Math.random() * 1e9) }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "The samples could not be loaded.");
      const r = j as SampleResponse;
      if (r.rows.length === 0) throw new Error("No samples match that selection. Try fewer elements, untick 'every chosen element', or widen the area.");
      const { table } = toTable(r);
      const sources = [...new Set(r.rows.map((row) => row[r.columns.indexOf("source_system")] as string))];
      const dims = r.labels.slice(r.columns.indexOf("lat") + 1);
      const note = r.rows.length < r.matching ? `random ${r.rows.length.toLocaleString()} of ${r.matching.toLocaleString()} matching samples` : `all ${r.matching.toLocaleString()} matching samples`;
      onLoad({ table, name: `Interzona database: ${sources.map(datasetName).join(", ")}`, dims, classCol: sources.length > 1 ? "source_system" : "sample_type_name", note });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={`${card} space-y-4`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className={heading}>Load from the Interzona database</h3>
          <p className="text-xs text-gray-400">One row per sample from the harmonised geochemistry table: units are standardised (ppm; wt% for oxides) and one method is chosen per element. &quot;Total&quot; means total or fusion methods, &quot;partial&quot; aqua regia and similar leaches; do not mix the two for the same element.</p>
        </div>
        <button className="shrink-0 text-xs text-gray-400 underline" onClick={onClose}>Close</button>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {!options ? (
        !error && <p className="text-sm text-gray-400">Loading what the database holds…</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="space-y-2">
            <span className={label}>1. Datasets and sample types</span>
            <div className="max-h-96 space-y-2 overflow-auto pr-1">
              {bySource.map(([source, list]) => (
                <div key={source} className="rounded border border-gray-800 p-2">
                  <button className="text-left text-sm font-medium text-gray-100 hover:underline" onClick={() => toggleSource(source, list)}>
                    {datasetName(source)} <span className="text-xs font-normal text-gray-500">({list.reduce((a, g) => a + g.n, 0).toLocaleString()})</span>
                  </button>
                  {source === "GREENLAND_GEUS" && options.geusLocked && <p className="text-[11px] text-amber-300">Plots and statistics only: sample values cannot be listed or downloaded (GEUS permission).</p>}
                  <div className="mt-1 space-y-0.5">
                    {list.map((g) => (
                      <label key={g.sampleType} className="flex items-center gap-2 text-xs text-gray-300">
                        <input type="checkbox" className="accent-emerald-500" checked={groups.has(key(source, g.sampleType))} onChange={() => toggleGroup(key(source, g.sampleType))} />
                        {g.sampleType} <span className="text-gray-500">{g.n.toLocaleString()}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-3">
            <div>
              <span className={label}>2. Lithology (optional; mostly recorded for rock samples)</span>
              <div className="flex flex-wrap gap-1.5">
                {options.lithologyCategories.map((c) => {
                  const on = lith.has(c);
                  return (
                    <button key={c} onClick={() => { const n = new Set(lith); if (on) n.delete(c); else n.add(c); setLith(n); }} className={`rounded-full border px-2 py-0.5 text-[11px] ${on ? "border-emerald-500 bg-emerald-900/50 text-emerald-100" : "border-gray-700 text-gray-400 hover:text-gray-200"}`}>
                      {c.replace(/_/g, " ").toLowerCase()}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="space-y-2">
              <Check name="3. Limit to an area (decimal degrees)" value={useBox} set={setUseBox} />
              {useBox && (
                <div className="grid grid-cols-4 gap-1.5">
                  {(["w", "s", "e", "n"] as const).map((k) => (
                    <label key={k} className="block">
                      <span className={label}>{{ w: "West", s: "South", e: "East", n: "North" }[k]}</span>
                      <input className={input} type="number" value={box[k]} onChange={(e) => setBox({ ...box, [k]: e.target.value })} />
                    </label>
                  ))}
                </div>
              )}
            </div>
            <div className="space-y-2 border-t border-gray-800 pt-3">
              <label className="block">
                <span className={label}>Maximum samples (a random sample is drawn when more match)</span>
                <select className={input} value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
                  {[1000, 2000, 5000, 10000, 20000].map((v) => <option key={v} value={v}>{v.toLocaleString()}</option>)}
                </select>
              </label>
              <Check name="Only samples analysed for every chosen element" value={requireAll} set={setRequireAll} />
              <p className="text-xs text-gray-500">t-SNE is slow above about 3,000 samples; PCA, correlation and clustering handle 20,000 comfortably.</p>
            </div>
          </div>

          <div className="space-y-2">
            <span className={label}>4. Elements {total > 0 && `(% of the ${total.toLocaleString()} chosen samples with a value)`}</span>
            {total === 0 ? (
              <p className="text-xs text-gray-500">Choose datasets and sample types first.</p>
            ) : (
              <>
                <div className="flex flex-wrap gap-2 text-xs">
                  {PRESETS.map((p) => <button key={p.name} className="text-gray-300 underline" onClick={() => preset(p.codes)}>+ {p.name}</button>)}
                  <button className="text-gray-300 underline" onClick={() => setElements(coverage.slice(0, 10).map((c) => c.code))}>10 best covered</button>
                  <button className="text-gray-400 underline" onClick={() => setElements([])}>Clear</button>
                </div>
                <input className={input} placeholder="Search elements" value={search} onChange={(e) => setSearch(e.target.value)} />
                <div className="flex max-h-64 flex-wrap gap-1.5 overflow-auto">
                  {shown.map((c) => {
                    const on = elements.includes(c.code);
                    return (
                      <button key={c.code} onClick={() => setElements(on ? elements.filter((e) => e !== c.code) : [...elements, c.code])} className={`rounded-full border px-2 py-0.5 text-[11px] ${on ? "border-emerald-500 bg-emerald-900/50 text-emerald-100" : "border-gray-700 text-gray-400 hover:text-gray-200"}`} title={c.code}>
                        {c.label} <span className="text-gray-500">{Math.round((100 * c.n) / total)}%</span>
                      </button>
                    );
                  })}
                </div>
                <div className="flex items-center gap-3 text-xs">
                  <Check name="Show sparsely covered elements" value={showAll} set={setShowAll} />
                  <span className="text-gray-500">{elements.length} chosen</span>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {options && (
        <div className="flex flex-wrap items-center gap-3 border-t border-gray-800 pt-3">
          <button className={btnRun} disabled={loading || chosen.length === 0 || elements.length < 2} onClick={load}>{loading ? "Loading…" : "Load samples"}</button>
          {includesGreenland && options.geusLocked && <span className="text-xs text-amber-300">Includes Greenland: tables, CSV downloads and map pop-ups will be switched off for this selection.</span>}
          {chosen.length > 0 && new Set(chosen.map((g) => g.source)).size > 1 && <span className="text-xs text-gray-400">Mixing surveys: labs and methods differ, so clusters may separate the surveys. Colour by source_system to check.</span>}
        </div>
      )}
    </div>
  );
}
