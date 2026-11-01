"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { correlation, ellipse, type Cell, type PcaResult, type Processed, type Table } from "@/lib/dimred/math";
import { PALETTE, colourBy } from "@/lib/dimred/colours";
import { CorrHeatmap, ScatterMatrix, Scree, corrColor } from "./Charts";
import { ScatterPlot, type PlotHandle } from "./Plot";
import { ClusterSettings, runJob, useClusterSettings } from "./MethodTab";
import { escapeHtml, type MapPoint } from "./ClusterMap";
import { Check, DataGrid, LOCKED_NOTE, Notice, Num, Select, btn, btnGreen, btnRun, card, downloadCsv, fmtNum, heading, input, label, usePolicy } from "./ui";

// Correlation, PCA, Clustering and Map tabs (the old "PrincipalComponentAnalysis" app), all working on the Data tab's processed rows.

const ClusterMap = dynamic(() => import("./ClusterMap"), { ssr: false });

export type Shared = {
  table: Table;
  processed: Processed;
  dims: string[];
  complete: number[]; // processed rows with every selected dimension present
  columnValues: (col: string) => Cell[]; // one value per processed row; "Cluster" gives the latest clustering
  colourChoices: string[];
};

export type ClusterResult = { labels: (number | null)[]; note: string; seed: number; basis: string; clusterModel: string; ms: number; data: Processed };

function colours(shared: Shared, col: string, rows: number[]) {
  if (col === "None") return { colors: rows.map(() => "#9ca3af"), legend: null };
  const v = shared.columnValues(col);
  return colourBy(rows.map((r) => v[r]), col, col === "Cluster");
}

// ---------- Correlation ----------

export function CorrelationTab({ shared }: { shared: Shared }) {
  const [method, setMethod] = useState<"Pearson" | "Spearman">("Pearson");
  const [plot, setPlot] = useState<"Heatmap" | "Scatter-plot matrix">("Heatmap");
  const [colourCol, setColourCol] = useState("None");
  const ref = useRef<PlotHandle>(null);
  const { credits } = usePolicy();
  const { processed, dims, complete } = shared;
  const corr = useMemo(() => correlation(processed.X, method), [processed, method]);
  const tooMany = plot === "Scatter-plot matrix" && dims.length > 10;
  const sample = useMemo(() => {
    // The matrix draws at most 2,000 points (evenly spaced rows) so it stays responsive.
    const step = Math.max(1, Math.ceil(complete.length / 2000));
    return complete.filter((_, i) => i % step === 0);
  }, [complete]);
  const sampleColours = useMemo(() => colours(shared, colourCol, sample).colors, [shared, colourCol, sample]);

  if (dims.length < 2) return <Notice>Select at least two dimensions on the Data tab.</Notice>;
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
      <div className={`${card} space-y-3 xl:col-span-3`}>
        <h3 className={heading}>Correlation</h3>
        <Select name="Method" value={method} set={setMethod} options={["Pearson", "Spearman"] as const} labels={{ Spearman: "Spearman (rank; robust to outliers)" }} />
        <Select name="Plot" value={plot} set={setPlot} options={["Heatmap", "Scatter-plot matrix"] as const} />
        {plot === "Scatter-plot matrix" && <Select name="Colour points by" value={colourCol} set={setColourCol} options={shared.colourChoices} />}
        <p className="text-xs text-gray-500">
          Uses the dimensions and processing chosen on the Data tab ({corr.n.toLocaleString()} complete rows). For geochemical concentrations, CLR (Data tab → Apply a function) avoids the spurious correlations that closure to 100% creates.
        </p>
        <div className="space-y-2 border-t border-gray-800 pt-3">
          <button className={`${btnGreen} w-full`} onClick={() => downloadCsv(`correlation_${method.toLowerCase()}.csv`, ["", ...dims], corr.r.map((row, i) => [dims[i], ...row]), credits)}>Correlation matrix (CSV)</button>
          <button className={`${btnGreen} w-full`} disabled={tooMany} onClick={() => ref.current?.downloadPng(plot === "Heatmap" ? "correlation_heatmap.png" : "correlation_matrix.png")}>Plot (PNG)</button>
        </div>
      </div>
      <div className="xl:col-span-9">
        {tooMany ? (
          <Notice tone="warn">The scatter-plot matrix shows at most 10 dimensions; {dims.length} are selected. Use the heatmap, or select fewer on the Data tab.</Notice>
        ) : plot === "Heatmap" ? (
          <div className="overflow-hidden rounded-lg"><CorrHeatmap ref={ref} names={dims} r={corr.r} title={`${method} correlation`} /></div>
        ) : (
          <div className="overflow-hidden rounded-lg">
            <ScatterMatrix ref={ref} names={dims} cols={dims.map((_, j) => sample.map((r) => processed.X[r][j]))} r={corr.r} colors={sampleColours} />
            {sample.length < complete.length && <p className="mt-1 text-xs text-gray-500">Showing {sample.length.toLocaleString()} of {complete.length.toLocaleString()} rows; correlations use them all.</p>}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- PCA ----------

export type PcaSettings = { centre: boolean; setCentre: (v: boolean) => void; scale: boolean; setScale: (v: boolean) => void };

export function PcaTab({ shared, pca, error, settings }: { shared: Shared; pca: PcaResult | null; error: string | null; settings: PcaSettings }) {
  const [pcx, setPcx] = useState("PC1");
  const [pcy, setPcy] = useState("PC2");
  const [showPoints, setShowPoints] = useState(true);
  const [showArrows, setShowArrows] = useState(true);
  const [showEllipses, setShowEllipses] = useState(false);
  const [groupCol, setGroupCol] = useState("None");
  const [colourCol, setColourCol] = useState("None");
  const [xBounds, setXBounds] = useState(false);
  const [xmin, setXmin] = useState(-5);
  const [xmax, setXmax] = useState(5);
  const [yBounds, setYBounds] = useState(false);
  const [ymin, setYmin] = useState(-5);
  const [ymax, setYmax] = useState(5);
  const [title, setTitle] = useState("");
  const biplot = useRef<PlotHandle>(null);
  const scree = useRef<PlotHandle>(null);
  const policy = usePolicy();
  const { dims, complete } = shared;

  const k = pca?.explained.length ?? 0;
  const pcs = Array.from({ length: k }, (_, i) => `PC${i + 1}`);
  const ix = Math.max(0, pcs.indexOf(pcx)), iy = Math.max(0, pcs.indexOf(pcy));
  const groupChoices = ["None", ...shared.colourChoices.filter((c) => c !== "None" && (c === "Cluster" || !shared.table.numeric[shared.table.columns.indexOf(c)]))];

  const view = useMemo(() => {
    if (!pca || k < 2) return null;
    const xs = pca.scores.map((s) => s[ix]), ys = pca.scores.map((s) => s[iy]);
    const col = colours(shared, colourCol, complete);
    let ellipses: { points: [number, number][]; color: string }[] | undefined;
    if (showEllipses && groupCol !== "None") {
      const gv = complete.map((r) => shared.columnValues(groupCol)[r]);
      const keys = gv.map((v) => (v === null ? "NA" : String(v)));
      const g = colourBy(gv, groupCol, true);
      const items = g.legend?.kind === "categories" ? g.legend.items : [];
      ellipses = items
        .map(({ label, color }) => {
          const idx = keys.flatMap((k, i) => (k === label ? [i] : []));
          const e = ellipse(idx.map((i) => xs[i]), idx.map((i) => ys[i]));
          return e ? { points: e, color } : null;
        })
        .filter((e): e is { points: [number, number][]; color: string } => e !== null);
    }
    let arrows: { x: number; y: number; label: string }[] | undefined;
    if (showArrows) {
      const lx = pca.loadings.map((l) => l[ix]), ly = pca.loadings.map((l) => l[iy]);
      const maxAbs = (v: number[]) => Math.max(...v.map(Math.abs)) || 1;
      const s = 0.8 * Math.min(maxAbs(xs) / maxAbs(lx), maxAbs(ys) / maxAbs(ly));
      arrows = dims.map((d, j) => ({ x: lx[j] * s, y: ly[j] * s, label: d }));
    }
    const legend = showEllipses && groupCol !== "None" && colourCol === "None" ? colourBy(complete.map((r) => shared.columnValues(groupCol)[r]), groupCol, true).legend : col.legend;
    return { xs, ys, colors: col.colors, legend, ellipses, arrows };
  }, [pca, k, ix, iy, shared, colourCol, complete, showEllipses, groupCol, showArrows, dims]);

  function downloadScores() {
    if (!pca) return;
    const t = shared.table;
    downloadCsv("pca_scores.csv", [...t.columns, ...pcs], complete.map((r, i) => [...t.rows[shared.processed.keep[r]], ...pca.scores[i]]), policy.credits);
  }
  function downloadLoadings() {
    if (!pca) return;
    const rows: Cell[][] = dims.map((d, j) => [d, ...pca.loadings[j]]);
    rows.push(["Standard deviation", ...pca.sdev], ["Proportion of variance", ...pca.explained]);
    let c = 0;
    rows.push(["Cumulative proportion", ...pca.explained.map((v) => (c += v))]);
    downloadCsv("pca_loadings.csv", ["", ...pcs], rows, policy.credits);
  }

  if (dims.length < 2) return <Notice>Select at least two dimensions on the Data tab.</Notice>;
  const shownPcs = pcs.slice(0, 10);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        <div className={`${card} space-y-3 xl:col-span-3`}>
          <h3 className={heading}>PCA settings</h3>
          <div className="grid grid-cols-2 gap-1">
            <Check name="Centre data" value={settings.centre} set={settings.setCentre} />
            <Check name="Scale data" value={settings.scale} set={settings.setScale} />
          </div>
          <p className="text-xs text-gray-500">Runs on the Data tab&apos;s processed values ({complete.length.toLocaleString()} complete rows). Turn Scale off if you already scaled there or used CLR on similar-sized values.</p>
          {k >= 2 && (
            <div className="grid grid-cols-2 gap-2">
              <Select name="X axis" value={pcs[ix]} set={setPcx} options={pcs} />
              <Select name="Y axis" value={pcs[iy]} set={setPcy} options={pcs} />
            </div>
          )}
          <div className="grid grid-cols-2 gap-1">
            <Check name="Show points" value={showPoints} set={setShowPoints} />
            <Check name="Show loadings" value={showArrows} set={setShowArrows} />
          </div>
          <Select name="Colour points by" value={colourCol} set={setColourCol} options={shared.colourChoices} />
          <Check name="95% ellipse per group" value={showEllipses} set={setShowEllipses} />
          {showEllipses && <Select name="Group by" value={groupCol} set={setGroupCol} options={groupChoices} />}
          <div className="space-y-2 border-t border-gray-800 pt-3">
            <Check name="Set X axis limits" value={xBounds} set={setXBounds} />
            {xBounds && <div className="grid grid-cols-2 gap-2"><Num name="Min. X" value={xmin} set={setXmin} /><Num name="Max. X" value={xmax} set={setXmax} /></div>}
            <Check name="Set Y axis limits" value={yBounds} set={setYBounds} />
            {yBounds && <div className="grid grid-cols-2 gap-2"><Num name="Min. Y" value={ymin} set={setYmin} /><Num name="Max. Y" value={ymax} set={setYmax} /></div>}
            <label className="block">
              <span className={label}>Biplot title</span>
              <input className={input} value={title} placeholder={`Biplot - ${pcs[ix] ?? "PC1"} vs ${pcs[iy] ?? "PC2"}`} onChange={(e) => setTitle(e.target.value)} />
            </label>
          </div>
          <div className="space-y-2 border-t border-gray-800 pt-3">
            <h3 className={heading}>Downloads</h3>
            <button className={`${btnGreen} w-full`} disabled={!pca || policy.restricted} title={policy.restricted ? LOCKED_NOTE : undefined} onClick={downloadScores}>Scores with data (CSV)</button>
            <button className={`${btnGreen} w-full`} disabled={!pca} onClick={downloadLoadings}>Loadings and variance (CSV)</button>
            <button className={`${btnGreen} w-full`} disabled={!view} onClick={() => biplot.current?.downloadPng("pca_biplot.png")}>Biplot (PNG)</button>
            <button className={`${btnGreen} w-full`} disabled={!pca} onClick={() => scree.current?.downloadPng("pca_scree.png")}>Scree plot (PNG)</button>
          </div>
        </div>
        <div className="space-y-4 xl:col-span-4">
          {error && <Notice tone="error">{error}</Notice>}
          {pca && <div className="overflow-hidden rounded-lg"><Scree ref={scree} explained={pca.explained} /></div>}
          {pca && (
            <div className={card}>
              <h3 className={`${heading} mb-2`}>Contribution to {pcs[ix]}</h3>
              <div className="space-y-1">
                {dims
                  .map((d, j) => ({ d, v: pca.loadings[j][ix] }))
                  .sort((a, b) => Math.abs(b.v) - Math.abs(a.v))
                  .map(({ d, v }) => (
                    <div key={d} className="flex items-center gap-2 text-xs">
                      <span className="w-24 shrink-0 truncate text-gray-300" title={d}>{d}</span>
                      <div className="h-3 flex-1 rounded bg-gray-800"><div className="h-3 rounded" style={{ width: `${(v * v * 100).toFixed(1)}%`, background: v >= 0 ? "#ef8a62" : "#67a9cf" }} /></div>
                      <span className="w-20 shrink-0 text-right font-mono text-gray-400">{(v * v * 100).toFixed(1)}% {v >= 0 ? "+" : "−"}</span>
                    </div>
                  ))}
              </div>
              <p className="mt-2 text-xs text-gray-500">Share of the component made up by each dimension (squared loading); + and − give the direction.</p>
            </div>
          )}
        </div>
        <div className="xl:col-span-5">
          {view ? (
            <div className="overflow-hidden rounded-lg">
              <ScatterPlot
                ref={biplot}
                title={title || `Biplot - ${pcs[ix]} vs ${pcs[iy]}`}
                xLabel={`${pcs[ix]} (${((pca?.explained[ix] ?? 0) * 100).toFixed(1)}%)`}
                yLabel={`${pcs[iy]} (${((pca?.explained[iy] ?? 0) * 100).toFixed(1)}%)`}
                xs={view.xs}
                ys={view.ys}
                colors={view.colors}
                legend={view.legend}
                hidePoints={!showPoints}
                ellipses={view.ellipses}
                arrows={view.arrows}
                xlim={xBounds && xmax > xmin ? [xmin, xmax] : null}
                ylim={yBounds && ymax > ymin ? [ymin, ymax] : null}
              />
            </div>
          ) : (
            !error && <div className={`${card} flex h-64 items-center justify-center text-sm text-gray-500`}>PCA needs at least two dimensions and complete rows.</div>
          )}
        </div>
      </div>
      {pca && (
        <div className={card}>
          <h3 className={`${heading} mb-2`}>Loadings</h3>
          <div className="overflow-auto">
            <table className="text-xs">
              <thead>
                <tr>
                  <th className="px-2 py-1 text-left text-gray-300"></th>
                  {shownPcs.map((p, i) => <th key={p} className="px-2 py-1 text-right text-gray-300">{p}<div className="font-normal text-gray-500">{(pca.explained[i] * 100).toFixed(1)}%</div></th>)}
                </tr>
              </thead>
              <tbody>
                {dims.map((d, j) => (
                  <tr key={d}>
                    <td className="whitespace-nowrap px-2 py-1 text-gray-300">{d}</td>
                    {shownPcs.map((p, i) => (
                      <td key={p} className="px-2 py-1 text-right font-mono" style={{ background: corrColor(pca.loadings[j][i]), color: Math.abs(pca.loadings[j][i]) > 0.6 ? "#fff" : "#111" }}>
                        {pca.loadings[j][i].toFixed(3)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pcs.length > 10 && <p className="mt-1 text-xs text-gray-500">First 10 of {pcs.length} components shown; the CSV has them all.</p>}
          <p className="mt-1 text-xs text-gray-500">Signs are arbitrary (each component is oriented so its largest loading is positive), so they may be flipped compared with R.</p>
        </div>
      )}
    </div>
  );
}

// ---------- Clustering ----------

export function ClusterTab({ shared, pca, result, setResult }: { shared: Shared; pca: PcaResult | null; result: ClusterResult | null; setResult: (r: ClusterResult) => void }) {
  const cs = useClusterSettings();
  const [basis, setBasis] = useState<"First N components" | "All processed dimensions">("First N components");
  const [nPcs, setNPcs] = useState(2);
  const [pcx, setPcx] = useState("PC1");
  const [pcy, setPcy] = useState("PC2");
  const [colourCol, setColourCol] = useState("None");
  const [labels, setLabels] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const plot1 = useRef<PlotHandle>(null);
  const plot2 = useRef<PlotHandle>(null);
  const policy = usePolicy();
  const { complete, processed } = shared;
  useEffect(() => () => stopRef.current?.(), []);

  const k = pca?.explained.length ?? 0;
  const pcs = Array.from({ length: k }, (_, i) => `PC${i + 1}`);
  const ix = Math.max(0, pcs.indexOf(pcx)), iy = Math.max(0, pcs.indexOf(pcy));
  const stale = result !== null && result.data !== processed;

  function run() {
    if (!pca) return;
    const n = Math.min(Math.max(2, Math.round(nPcs) || 2), k);
    const X = basis === "First N components" ? pca.scores.map((s) => s.slice(0, n)) : complete.map((r) => processed.X[r]);
    if (Object.values(cs.params).some((v) => typeof v === "number" && !Number.isFinite(v))) { setError("Please fill in every clustering setting."); return; }
    const seed = 123; // the R app used set.seed(123) for every clustering run
    const desc = basis === "First N components" ? `PC1–PC${n} (${(pca.explained.slice(0, n).reduce((a, b) => a + b, 0) * 100).toFixed(1)}% of variance)` : `all ${shared.dims.length} processed dimensions`;
    const clusterModel = cs.clusterModel;
    const data = processed;
    stopRef.current?.();
    setRunning(true);
    setError(null);
    stopRef.current = runJob(
      { method: "cluster", X, cluster: cs.params, seed },
      () => {},
      (m) => {
        setRunning(false);
        const labs: (number | null)[] = new Array(data.X.length).fill(null);
        complete.forEach((r, i) => (labs[r] = m.clusters[i]));
        setResult({ labels: labs, note: m.note, seed, basis: desc, clusterModel, ms: m.ms, data });
      },
      (msg) => { setRunning(false); setError(msg); }
    );
  }

  const view = useMemo(() => {
    if (!pca || !result || stale || k < 2) return null;
    const xs = pca.scores.map((s) => s[ix]), ys = pca.scores.map((s) => s[iy]);
    const labs = complete.map((r) => result.labels[r] ?? 0);
    const clu = colourBy(labs, "Cluster", true);
    const col = colours(shared, colourCol, complete);
    const acc = new Map<number, [number, number, number]>();
    labs.forEach((l, i) => { const a = acc.get(l) ?? [0, 0, 0]; a[0] += xs[i]; a[1] += ys[i]; a[2]++; acc.set(l, a); });
    const centres = [...acc.entries()].sort((a, b) => a[0] - b[0]).map(([cluster, a]) => ({ cluster, x: a[0] / a[2], y: a[1] / a[2] }));
    return { xs, ys, clu, col, centres };
  }, [pca, result, stale, k, ix, iy, complete, shared, colourCol]);

  function downloadClusters() {
    if (!result || !pca) return;
    const t = shared.table;
    downloadCsv("clusters.csv", [...t.columns, ...pcs, "ClusterID"], complete.map((r, i) => [...t.rows[processed.keep[r]], ...pca.scores[i], result.labels[r]]), policy.credits);
  }

  if (!pca) return <Notice>Run PCA first: select at least two dimensions on the Data tab.</Notice>;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        <div className={`${card} space-y-3 xl:col-span-3`}>
          <h3 className={heading}>Cluster on</h3>
          <Select name="" value={basis} set={setBasis} options={["First N components", "All processed dimensions"] as const} />
          {basis === "First N components" && (
            <>
              <Num name={`Number of components (2–${k})`} value={nPcs} set={setNPcs} step={1} min={2} max={k} />
              <p className="text-xs text-gray-500">These explain {(pca.explained.slice(0, Math.min(Math.max(2, nPcs || 2), k)).reduce((a, b) => a + b, 0) * 100).toFixed(1)}% of the variance. The old app always used just the two plotted components.</p>
            </>
          )}
          <div className="space-y-2 border-t border-gray-800 pt-3">
            <h3 className={heading}>Cluster model</h3>
            <ClusterSettings s={cs} />
          </div>
          <button className={`${btnRun} w-full`} onClick={run} disabled={running || complete.length < 5}>{running ? "Working…" : "Run clustering"}</button>
          {error && <p className="text-xs text-red-300">{error}</p>}
        </div>
        <div className="space-y-4 xl:col-span-6">
          {stale && <Notice tone="warn">The data or PCA changed since the last run. Press Run clustering again.</Notice>}
          {view ? (
            <>
              <div className="overflow-hidden rounded-lg">
                <ScatterPlot ref={plot1} title={colourCol === "None" ? `${pcs[ix]} vs ${pcs[iy]}` : `${pcs[ix]} vs ${pcs[iy]} by ${colourCol}`} xLabel={pcs[ix]} yLabel={pcs[iy]} xs={view.xs} ys={view.ys} colors={view.col.colors} legend={view.col.legend} centres={labels ? view.centres : undefined} />
              </div>
              <div className="overflow-hidden rounded-lg">
                <ScatterPlot ref={plot2} title={`${result!.clusterModel} clusters`} xLabel={pcs[ix]} yLabel={pcs[iy]} xs={view.xs} ys={view.ys} colors={view.clu.colors} legend={view.clu.legend} centres={labels ? view.centres : undefined} />
              </div>
              <p className="text-xs text-gray-500">{complete.length.toLocaleString()} rows · clustered on {result!.basis} · {result!.note} · {(result!.ms / 1000).toFixed(1)} s</p>
            </>
          ) : (
            !stale && <div className={`${card} flex h-64 items-center justify-center text-sm text-gray-500`}>Choose settings, then press Run clustering.</div>
          )}
        </div>
        <div className={`${card} space-y-3 xl:col-span-3`}>
          <h3 className={heading}>Plot</h3>
          <div className="grid grid-cols-2 gap-2">
            <Select name="X axis" value={pcs[ix]} set={setPcx} options={pcs} />
            <Select name="Y axis" value={pcs[iy]} set={setPcy} options={pcs} />
          </div>
          <Select name="Colour first plot by" value={colourCol} set={setColourCol} options={shared.colourChoices.filter((c) => c !== "Cluster")} />
          <Check name="Show cluster labels" value={labels} set={setLabels} />
          <div className="space-y-2 border-t border-gray-800 pt-3">
            <h3 className={heading}>Downloads</h3>
            <button className={`${btnGreen} w-full`} disabled={!view || policy.restricted} title={policy.restricted ? LOCKED_NOTE : undefined} onClick={downloadClusters}>Data with PCs and ClusterID (CSV)</button>
            <button className={`${btnGreen} w-full`} disabled={!view} onClick={() => plot1.current?.downloadPng("cluster_colour_plot.png")}>First plot (PNG)</button>
            <button className={`${btnGreen} w-full`} disabled={!view} onClick={() => plot2.current?.downloadPng("cluster_plot.png")}>Cluster plot (PNG)</button>
          </div>
          <p className="text-xs text-gray-500">Clusters appear as &quot;Cluster&quot; in the colour choices on the other tabs and on the Map.</p>
        </div>
      </div>
      {view && result && (
        <div className={card}>
          <DataGrid columns={[...shared.table.columns, "PC1", "PC2", "ClusterID"]} rows={complete.map((r, i) => [...shared.table.rows[processed.keep[r]], pca.scores[i][0], pca.scores[i][1], result.labels[r]])} />
        </div>
      )}
    </div>
  );
}

// ---------- Map ----------

const LON = /^(lon|long|lng|longitude|x|dec_?long|decimallongitude)$/i;
const LAT = /^(lat|latitude|y|dec_?lat|decimallatitude)$/i;

export function MapTab({ shared, hasClusters }: { shared: Shared; hasClusters: boolean }) {
  const { table, processed } = shared;
  const policy = usePolicy();
  const numericCols = table.columns.filter((_, j) => table.numeric[j]);
  const [lonCol, setLonCol] = useState(() => numericCols.find((c) => LON.test(c.trim())) ?? "None");
  const [latCol, setLatCol] = useState(() => numericCols.find((c) => LAT.test(c.trim())) ?? "None");
  const [colourCol, setColourCol] = useState(hasClusters ? "Cluster" : "None");
  const [mode, setMode] = useState<"Points" | "Pie charts">("Points");
  const [asFactor, setAsFactor] = useState(false);
  useEffect(() => { if (hasClusters) setColourCol((c) => (c === "None" ? "Cluster" : c)); }, [hasClusters]);

  const data = useMemo(() => {
    const li = table.columns.indexOf(lonCol), ai = table.columns.indexOf(latCol);
    if (li < 0 || ai < 0) return null;
    const rows = processed.keep.map((_, r) => r);
    const values = colourCol === "None" ? null : shared.columnValues(colourCol);
    const isNumeric = values !== null && values.every((v) => v === null || typeof v === "number");
    // For locked data a numeric column is shown only as a gradient: as categories or pie slices its legend would list the raw values.
    const numericLocked = policy.restricted && isNumeric && colourCol !== "Cluster";
    const pies = mode === "Pie charts" && !numericLocked;
    const col = colourCol === "None" ? { colors: rows.map(() => PALETTE[2]), legend: null } : colourBy(values!, colourCol, pies || (asFactor && !numericLocked) || colourCol === "Cluster");
    const points: MapPoint[] = [];
    let skipped = 0;
    rows.forEach((r) => {
      const src = table.rows[processed.keep[r]];
      const lon = src[li], lat = src[ai];
      // The R app put rows without coordinates at 0, 0; they are left off the map instead.
      if (typeof lon !== "number" || typeof lat !== "number" || Math.abs(lat) > 90 || Math.abs(lon) > 180) { skipped++; return; }
      const v = values ? values[r] : null;
      const showValue = values !== null && !(policy.restricted && typeof v === "number" && colourCol !== "Cluster");
      const lines = [showValue ? `<strong>${escapeHtml(colourCol)}: ${escapeHtml(v === null ? "NA" : typeof v === "number" ? fmtNum(v) : String(v))}</strong>` : ""];
      // Locked data (GEUS) shows only the colour category in pop-ups, not the sample's values.
      if (!policy.restricted) shared.dims.slice(0, 8).forEach((d) => { const j = table.columns.indexOf(d); const x = src[j]; lines.push(`${escapeHtml(d)}: ${x === null ? "NA" : escapeHtml(String(x))}`); });
      points.push({ lat, lon, color: col.colors[r], category: v === null ? "NA" : String(v), popup: lines.filter(Boolean).join("<br/>") });
    });
    const colorOf = new Map<string, string>(col.legend?.kind === "categories" ? col.legend.items.map((it) => [it.label, it.color]) : []);
    return { points, skipped, legend: col.legend, colorOf, isNumeric, numericLocked, mode: pies ? ("Pie charts" as const) : ("Points" as const) };
  }, [table, processed, lonCol, latCol, colourCol, mode, asFactor, shared, policy.restricted]);

  const coordChoices = ["None", ...numericCols];
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
      <div className={`${card} space-y-3 xl:col-span-3`}>
        <h3 className={heading}>Map</h3>
        <div className="grid grid-cols-2 gap-2">
          <Select name="Longitude column" value={lonCol} set={setLonCol} options={coordChoices} />
          <Select name="Latitude column" value={latCol} set={setLatCol} options={coordChoices} />
        </div>
        <Select name="Colour by" value={colourCol} set={setColourCol} options={shared.colourChoices} />
        <Select name="Display" value={mode} set={setMode} options={["Points", "Pie charts"] as const} labels={{ "Pie charts": "Pie charts (mix of categories at each location)" }} />
        {mode === "Points" && data?.isNumeric && !data.numericLocked && colourCol !== "Cluster" && <Check name="Treat numbers as categories" value={asFactor} set={setAsFactor} />}
        <p className="text-xs text-gray-500">Coordinates must be decimal degrees (WGS84). Rows on the Data tab&apos;s current selection only.{!hasClusters && " Run clustering to colour by cluster."}</p>
        {data && (
          <p className="rounded bg-gray-950 px-2 py-1 font-mono text-xs text-gray-300">
            {data.points.length.toLocaleString()} rows mapped{data.skipped ? `, ${data.skipped.toLocaleString()} without valid coordinates left off` : ""}
          </p>
        )}
        {data?.legend && (
          <div className="border-t border-gray-800 pt-3 text-xs">
            <p className="mb-1 font-semibold text-gray-300">{data.legend.title}</p>
            {data.legend.kind === "categories" ? (
              <div className="max-h-64 space-y-0.5 overflow-auto">
                {data.legend.items.map((it) => <div key={it.label} className="flex items-center gap-2 text-gray-300"><span className="inline-block h-3 w-3 rounded-full" style={{ background: it.color }} />{it.label}</div>)}
              </div>
            ) : (
              <div className="flex items-center gap-2 text-gray-300">
                {fmtNum(data.legend.min)}
                <span className="h-3 flex-1 rounded" style={{ background: `linear-gradient(to right, ${data.legend.colors.join(",")})` }} />
                {fmtNum(data.legend.max)}
              </div>
            )}
          </div>
        )}
        {data && (
          <button className={`${btn} w-full bg-gray-700 text-white hover:bg-gray-600 disabled:hover:bg-gray-700`} disabled={policy.restricted} title={policy.restricted ? LOCKED_NOTE : undefined} onClick={() => downloadCsv("map_points.csv", ["Longitude", "Latitude", colourCol], data.points.map((p) => [p.lon, p.lat, p.category]), policy.credits)}>
            Mapped points (CSV)
          </button>
        )}
        {policy.credits.length > 0 && <p className="text-[11px] text-gray-500">Data: {policy.credits.join("; ")}</p>}
      </div>
      <div className="xl:col-span-9">
        {data ? <ClusterMap points={data.points} mode={data.mode} colorOf={data.colorOf} /> : <Notice>Choose the longitude and latitude columns.</Notice>}
      </div>
    </div>
  );
}
