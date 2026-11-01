"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { BDL, FUNCTIONS, IMPUTE, SCALE, completeRows, parseCsv, pcaFull, processTable, summarise, type Cell, type PcaResult, type Processed, type RowFilter, type Table } from "@/lib/dimred/math";
import { MethodTab } from "./MethodTab";
import { ClusterTab, CorrelationTab, MapTab, PcaTab, type ClusterResult, type Shared } from "./PcaTabs";
import { DatabasePanel, type DbLoad } from "./DatabasePanel";
import { Check, DataGrid, LOCKED_NOTE, Notice, Num, PolicyContext, Select, btn, btnGreen, card, downloadCsv, heading, input, label, type DataPolicy } from "./ui";

// Multivariate tools: browser rewrite of the old R Shiny apps "PrincipalComponentAnalysis" and "DimRedWithUMAPandtSNE",
// sharing one Data tab. The maths runs in the browser (heavy parts in a web worker), so uploaded data never reaches the server.

const DATASETS = ["iris", "biopsy", "Melanoma", "Pima.te", "Boston", "diamonds", "muscle", "mtcars"];
const SOFT_LIMIT = 5000;
const TABS = [
  ["data", "Data"],
  ["corr", "Correlation"],
  ["pca", "PCA"],
  ["cluster", "Clustering"],
  ["map", "Map"],
  ["umap", "UMAP"],
  ["tsne", "t-SNE"],
] as const;
type Tab = (typeof TABS)[number][0];

export function MultivariateApp() {
  const [tab, setTab] = useState<Tab>("data");
  const [table, setTable] = useState<Table | null>(null);
  const [source, setSource] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [dataset, setDataset] = useState("");
  const [limitOn, setLimitOn] = useState(false);
  const [limitNum, setLimitNum] = useState(2000);
  const [dims, setDims] = useState<string[]>([]);
  const [classCol, setClassCol] = useState("None");
  const [classAsFactor, setClassAsFactor] = useState(false);
  const [filters, setFilters] = useState<RowFilter[]>([]);
  const [bdl, setBdl] = useState<(typeof BDL)[number]>("Half the limit");
  const [impute, setImpute] = useState<(typeof IMPUTE)[number]>("None");
  const [fn, setFn] = useState<(typeof FUNCTIONS)[number]>("None");
  const [scale, setScale] = useState<(typeof SCALE)[number]>("None");
  const [roundOn, setRoundOn] = useState(false);
  const [roundDigits, setRoundDigits] = useState(1);
  const [dview, setDview] = useState<"Pre-processed" | "Processed" | "Summary">("Pre-processed");
  const [pcaCentre, setPcaCentre] = useState(true);
  const [pcaScale, setPcaScale] = useState(true);
  const [clusters, setClusters] = useState<ClusterResult | null>(null);
  const [showDb, setShowDb] = useState(false);
  const [loadNote, setLoadNote] = useState("");

  function load(t: Table, name: string, preset?: { dims: string[]; classCol: string; note: string }) {
    setTable(t);
    setSource(name);
    setLoadError(null);
    setFilters([]);
    setClusters(null);
    setLoadNote(preset?.note ?? "");
    if (preset) {
      setClassCol(preset.classCol);
      setDims(preset.dims);
      setLimitOn(false);
      if (t.meta?.restricted) setDview("Summary");
      return;
    }
    // Start with every numeric column except an ID as a dimension; a text column becomes the class if there is exactly one.
    const text = t.columns.filter((_, j) => !t.numeric[j]);
    const cls = text.length === 1 ? text[0] : "None";
    setClassCol(cls);
    setDims(t.columns.filter((c, j) => t.numeric[j] && c !== cls && !/^(id|lon|long|lng|longitude|lat|latitude|x|y|easting|northing)$/i.test(c.trim())));
    setLimitOn(t.rows.length > SOFT_LIMIT);
  }

  function loadFromDb(l: DbLoad) {
    setDataset("");
    load(l.table, l.name, l);
    setShowDb(false);
  }

  async function pickDataset(name: string) {
    setDataset(name);
    if (!name) return;
    setLoading(true);
    try {
      const res = await fetch(`/dimred/${name}.csv`);
      if (!res.ok) throw new Error(`Could not load ${name} (${res.status}).`);
      load(parseCsv(await res.text()), `${name} (R dataset)`);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function upload(f: File | undefined) {
    if (!f) return;
    if (f.size > 50 * 1024 * 1024) { setLoadError("That file is over 50 MB; please upload a subset."); return; }
    setDataset("");
    try {
      load(parseCsv(await f.text()), f.name);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }

  const options = useMemo(
    () => ({ dims, classCol: classCol === "None" ? null : classCol, limit: limitOn ? limitNum : null, filters, bdl, impute, fn, scale, round: roundOn ? roundDigits : null }),
    [dims, classCol, limitOn, limitNum, filters, bdl, impute, fn, scale, roundOn, roundDigits]
  );
  const processed: Processed | null = useMemo(() => (table && options.dims.length ? processTable(table, options) : null), [table, options]);
  const summary = useMemo(() => (processed ? summarise(options.dims, processed.X) : null), [processed, options.dims]);
  const complete = useMemo(() => (processed ? completeRows(processed.X) : []), [processed]);

  const pcaState = useMemo((): { pca: PcaResult | null; error: string | null } => {
    if (!processed || dims.length < 2) return { pca: null, error: null };
    if (complete.length < 3) return { pca: null, error: "PCA needs at least three complete rows. Handle missing values on the Data tab." };
    try {
      return { pca: pcaFull(complete.map((r) => processed.X[r]), pcaCentre, pcaScale), error: null };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const m = /^Column (\d+) /.exec(msg);
      return { pca: null, error: m ? msg.replace(/^Column \d+/, `"${dims[Number(m[1]) - 1]}"`) : msg };
    }
  }, [processed, complete, dims, pcaCentre, pcaScale]);

  const hasClusters = clusters !== null && clusters.data === processed;
  const shared: Shared | null = useMemo(() => {
    if (!table || !processed) return null;
    const columnValues = (col: string): Cell[] => {
      if (col === "Cluster") return hasClusters ? clusters!.labels : processed.keep.map(() => null);
      const j = table.columns.indexOf(col);
      return processed.keep.map((i) => (j >= 0 ? table.rows[i][j] : null));
    };
    return { table, processed, dims, complete, columnValues, colourChoices: ["None", ...table.columns, ...(hasClusters ? ["Cluster"] : [])] };
  }, [table, processed, dims, complete, hasClusters, clusters]);

  const policy: DataPolicy = useMemo(() => ({ credits: table?.meta?.credits ?? [], restricted: table?.meta?.restricted ?? false }), [table]);
  const view = policy.restricted ? "Summary" : dview;

  const ready = !table ? "Choose a dataset on the Data tab first." : dims.length < 2 ? "Select at least two dimensions on the Data tab." : null;
  const snapshot = () => (processed ? { X: processed.X, dims: [...dims], classCol: options.classCol, classValues: processed.classValues, classAsFactor } : null);
  const numericCols = table ? table.columns.filter((_, j) => table.numeric[j]) : [];

  const shown: { columns: string[]; rows: Cell[][] } | null = !table
    ? null
    : view === "Pre-processed"
      ? { columns: table.columns, rows: limitOn ? table.rows.slice(0, limitNum) : table.rows }
      : !processed
        ? null
        : view === "Processed"
          ? { columns: dims, rows: processed.X }
          : { columns: ["attribute", "mean", "median", "min", "max", "sd", "Has NAs"], rows: (summary ?? []).map((s) => [s.name, s.mean, s.median, s.min, s.max, s.sd, s.hasNA ? "TRUE" : "FALSE"]) };

  const setFilter = (i: number, f: Partial<RowFilter>) => setFilters(filters.map((x, k) => (k === i ? { ...x, ...f } : x)));

  return (
    <PolicyContext.Provider value={policy}>
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <header className="flex items-center gap-3 border-b border-gray-800 px-4 py-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/interzona-mark.png" alt="Interzona" width={40} height={40} className="h-10 w-10 shrink-0 select-none" />
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold leading-tight">Multivariate tools</h1>
          <p className="text-xs text-gray-400">Correlation, PCA, clustering, maps, UMAP and t-SNE on a CSV or a sample dataset. It runs in your browser; your data is not sent to the server.</p>
        </div>
        <Link href="/" className="shrink-0 text-xs text-gray-300 underline">← Assistant</Link>
      </header>

      <nav className="flex gap-1 overflow-x-auto border-b border-gray-800 px-4">
        {TABS.map(([t, name]) => (
          <button key={t} onClick={() => setTab(t)} className={`whitespace-nowrap border-b-2 px-4 py-2 text-sm ${tab === t ? "border-emerald-500 text-white" : "border-transparent text-gray-400 hover:text-gray-200"}`}>
            {name}
          </button>
        ))}
      </nav>

      <main className="p-4">
        <section className={tab === "data" ? "space-y-4" : "hidden"}>
          {showDb && <DatabasePanel onLoad={loadFromDb} onClose={() => setShowDb(false)} />}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className={`${card} space-y-3`}>
              <h3 className={heading}>Data selection</h3>
              <button className={`${btn} w-full bg-emerald-700 text-white hover:bg-emerald-600`} onClick={() => setShowDb(!showDb)}>
                {showDb ? "Hide the database panel" : "Load from the Interzona database"}
              </button>
              <p className="text-xs font-semibold text-gray-400">— or —</p>
              <label className="block">
                <span className={label}>Upload a CSV file (first row = column names)</span>
                <input type="file" accept=".csv,text/csv" className="block w-full text-sm text-gray-300 file:mr-3 file:rounded file:border-0 file:bg-gray-700 file:px-3 file:py-1.5 file:text-sm file:text-white" onChange={(e) => upload(e.target.files?.[0])} />
              </label>
              <p className="text-xs font-semibold text-gray-400">— or —</p>
              <label className="block">
                <span className={label}>Sample dataset (from R&apos;s MASS and ggplot2 packages)</span>
                <select className={input} value={dataset} onChange={(e) => pickDataset(e.target.value)}>
                  <option value="">Choose…</option>
                  {DATASETS.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              </label>
              {loading && <p className="text-xs text-gray-400">Loading…</p>}
              {loadError && <p className="text-xs text-red-400">{loadError}</p>}
              {table && (
                <p className="rounded bg-gray-950 px-2 py-1 font-mono text-xs text-gray-300">
                  {source}: {table.rows.length.toLocaleString()} rows, {table.columns.length} columns{loadNote && ` (${loadNote})`}
                </p>
              )}
              {policy.restricted && <p className="text-xs text-amber-300">{LOCKED_NOTE} Tables are replaced by the summary; plots, statistics and PNGs work as usual.</p>}
              {policy.credits.length > 0 && <p className="text-[11px] text-gray-500">Data: {policy.credits.join("; ")}. Credits are added to every download.</p>}
              <div className="space-y-2 border-t border-gray-800 pt-3">
                <p className="text-xs text-gray-500">Large datasets are slow: above {SOFT_LIMIT.toLocaleString()} rows, use a subset (especially for t-SNE).</p>
                <Check name="Limit to the first rows" value={limitOn} set={setLimitOn} />
                {limitOn && <div className="w-32"><Num name="Rows" value={limitNum} set={(v) => setLimitNum(Math.max(1, Math.round(v || 1)))} step={100} min={1} /></div>}
              </div>
              {table && (
                <div className="space-y-2 border-t border-gray-800 pt-3">
                  <span className={label}>Row filters (keep rows inside every range; bounds included)</span>
                  {filters.map((f, i) => (
                    <div key={i} className="grid grid-cols-[1fr_5rem_5rem_auto] items-end gap-1.5">
                      <Select name="" value={f.col} set={(v) => setFilter(i, { col: v })} options={numericCols} />
                      <input className={input} type="number" placeholder="min" value={f.min ?? ""} onChange={(e) => setFilter(i, { min: e.target.value === "" ? null : Number(e.target.value) })} />
                      <input className={input} type="number" placeholder="max" value={f.max ?? ""} onChange={(e) => setFilter(i, { max: e.target.value === "" ? null : Number(e.target.value) })} />
                      <button className="px-1 pb-1 text-gray-400 hover:text-red-300" title="Remove filter" onClick={() => setFilters(filters.filter((_, k) => k !== i))}>✕</button>
                    </div>
                  ))}
                  {numericCols.length > 0 && <button className="text-xs text-gray-400 underline" onClick={() => setFilters([...filters, { col: numericCols[0], min: null, max: null }])}>+ Add a filter</button>}
                </div>
              )}
            </div>

            <div className={`${card} space-y-3`}>
              <h3 className={heading}>Dimensions</h3>
              {!table ? (
                <p className="text-xs text-gray-500">Load data to choose columns.</p>
              ) : (
                <>
                  <div>
                    <span className={label}>Dimensions to analyse (numeric columns)</span>
                    <div className="flex flex-wrap gap-1.5">
                      {numericCols.filter((c) => c !== classCol).map((c) => {
                        const on = dims.includes(c);
                        return (
                          <button key={c} onClick={() => setDims(on ? dims.filter((d) => d !== c) : [...dims, c].sort((a, b) => table.columns.indexOf(a) - table.columns.indexOf(b)))} className={`rounded-full border px-2.5 py-0.5 text-xs ${on ? "border-emerald-500 bg-emerald-900/50 text-emerald-100" : "border-gray-700 text-gray-400 hover:text-gray-200"}`}>
                            {c}
                          </button>
                        );
                      })}
                    </div>
                    <div className="mt-1.5 flex gap-3 text-xs">
                      <button className="text-gray-400 underline" onClick={() => setDims(numericCols.filter((c) => c !== classCol))}>All</button>
                      <button className="text-gray-400 underline" onClick={() => setDims([])}>None</button>
                      <span className="text-gray-500">{dims.length} selected</span>
                    </div>
                  </div>
                  <Select name="Data class (colours the UMAP and t-SNE plots)" value={classCol} set={(v) => { setClassCol(v); setDims(dims.filter((d) => d !== v)); }} options={["None", ...table.columns]} />
                  <Check name="Treat a numeric class as categories" value={classAsFactor} set={setClassAsFactor} />
                </>
              )}
              <div className="space-y-2 border-t border-gray-800 pt-3">
                <Select name="Data to view" value={view} set={setDview} options={policy.restricted ? (["Summary"] as const) : (["Pre-processed", "Processed", "Summary"] as const)} />
                <button className={btnGreen} disabled={!shown} onClick={() => shown && downloadCsv(`${view.toLowerCase()}.csv`, shown.columns, shown.rows, policy.credits)}>Download data view</button>
              </div>
            </div>

            <div className={`${card} space-y-3`}>
              <h3 className={heading}>Data processing</h3>
              {processed && (
                <p className="rounded bg-gray-950 px-2 py-1 font-mono text-xs text-gray-300">
                  Below detection limit (&quot;&lt;x&quot;): {processed.ltCount.toLocaleString()}
                  <br />Missing values: {processed.naCount.toLocaleString()}
                  {processed.filtered > 0 && <><br />Removed by filters: {processed.filtered.toLocaleString()}</>}
                  <br />Rows used: {processed.X.length.toLocaleString()} ({complete.length.toLocaleString()} complete)
                </p>
              )}
              <Select name='Values below detection limit ("<x")' value={bdl} set={setBdl} options={BDL} labels={{ "Half the limit": "Replace with half the limit (x/2)", "The limit": "Replace with the limit (x)", Missing: "Treat as missing" }} />
              <Select name="Missing values" value={impute} set={setImpute} options={IMPUTE} />
              <div className="grid grid-cols-2 gap-2">
                <Select name="Apply a function" value={fn} set={setFn} options={FUNCTIONS} />
                <Select name="Scale data" value={scale} set={setScale} options={SCALE} />
              </div>
              <Check name="Round to decimal places" value={roundOn} set={setRoundOn} />
              {roundOn && <div className="w-24"><Num name="Digits" value={roundDigits} set={(v) => setRoundDigits(Math.max(0, Math.min(10, Math.round(v || 0))))} step={1} min={0} max={10} /></div>}
              {table?.meta?.bdlProxy && (
                <p className="text-xs text-gray-400">
                  The database keeps which values were below detection but not the limits, so the lowest detected value of each element in this selection stands in as the limit. &quot;Half the limit&quot; is a common substitution; &quot;Treat as missing&quot; drops them instead.
                </p>
              )}
              {processed?.warning && <p className="text-xs text-amber-300">{processed.warning}</p>}
              <p className="text-xs text-gray-500">
                Applied in this order: row limit → filters → detection limits → missing values → function → scaling → rounding. CLR (centred log-ratio) is the usual choice for geochemical concentrations: it removes the closure effect that makes raw ppm and % values correlate falsely.
              </p>
            </div>
          </div>
          {shown && <div className={card}><DataGrid columns={shown.columns} rows={shown.rows} raw={view !== "Summary"} /></div>}
        </section>

        {!shared && tab !== "data" && tab !== "umap" && tab !== "tsne" && <Notice>{ready ?? "Choose a dataset on the Data tab first."}</Notice>}
        {shared && (
          <>
            {/* Kept mounted while hidden so their settings (and a running clustering job) survive tab switches. */}
            <section className={tab === "corr" ? "" : "hidden"}><CorrelationTab shared={shared} /></section>
            <section className={tab === "pca" ? "" : "hidden"}>
              <PcaTab shared={shared} pca={pcaState.pca} error={pcaState.error} settings={{ centre: pcaCentre, setCentre: setPcaCentre, scale: pcaScale, setScale: setPcaScale }} />
            </section>
            <section className={tab === "cluster" ? "" : "hidden"}><ClusterTab shared={shared} pca={pcaState.pca} result={clusters} setResult={setClusters} /></section>
            {/* Leaflet cannot size a hidden map, so the map is only mounted while its tab is open. */}
            {tab === "map" && <section><MapTab key={source} shared={shared} hasClusters={hasClusters} /></section>}
          </>
        )}

        <section className={tab === "umap" ? "" : "hidden"}>
          <MethodTab method="umap" snapshot={snapshot} ready={ready} />
        </section>
        <section className={tab === "tsne" ? "" : "hidden"}>
          <MethodTab method="tsne" snapshot={snapshot} ready={ready} />
        </section>
      </main>
    </div>
    </PolicyContext.Provider>
  );
}
