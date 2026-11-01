"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { GMM_LABELS, GMM_MODELS, type Cell, type GmmModel } from "@/lib/dimred/math";
import { PALETTE, colourBy, type Legend } from "@/lib/dimred/colours";
import type { ClusterParams, Job, JobResult } from "@/lib/dimred/worker";
import { ScatterPlot, type PlotHandle } from "./Plot";
import { Check, DataGrid, LOCKED_NOTE, Num, Select, btnGreen, btnRun, btn, card, downloadCsv, heading, input, label, usePolicy } from "./ui";

// UMAP or t-SNE tab: settings, clustering of the 2-D embedding, plots and downloads (the old "DimRedWithUMAPandtSNE" app).

export type Snapshot = { X: number[][]; dims: string[]; classCol: string | null; classValues: Cell[]; classAsFactor: boolean };
type Result = Extract<JobResult, { type: "result" }> & { seed: number; snap: Snapshot; clusterModel: string };

export function ClusterSettings({ s }: { s: ReturnType<typeof useClusterSettings> }) {
  return (
    <div className="space-y-2">
      <Select name="Cluster model" value={s.clusterModel} set={s.setClusterModel} options={["K-means", "GMM"] as const} labels={{ GMM: "Gaussian mixture (GMM)" }} />
      {s.clusterModel === "K-means" ? (
        <div className="grid grid-cols-3 gap-2">
          <Num name="Clusters" value={s.k} set={s.setK} step={1} min={1} max={100} />
          <Num name="Max. iterations" value={s.iterMax} set={s.setIterMax} step={1} min={1} max={100} />
          <Num name="Random starts" value={s.nstart} set={s.setNstart} step={1} min={1} max={25} />
        </div>
      ) : (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <Num name="Clusters" value={s.gmmG} set={s.setGmmG} step={1} min={1} max={30} />
            <Select name="Model" value={s.gmmModel} set={s.setGmmModel} options={["best", ...GMM_MODELS] as const} labels={{ best: "Best by BIC (default)", ...GMM_LABELS }} />
          </div>
          <Check name="Let BIC choose the number of clusters (1–9)" value={s.useBic} set={s.setUseBic} />
        </div>
      )}
    </div>
  );
}

export function useClusterSettings(defaultK = 2) {
  const [clusterModel, setClusterModel] = useState<"K-means" | "GMM">("K-means");
  const [k, setK] = useState(defaultK);
  const [iterMax, setIterMax] = useState(10);
  const [nstart, setNstart] = useState(1);
  const [gmmG, setGmmG] = useState(2);
  const [gmmModel, setGmmModel] = useState<"best" | GmmModel>("best");
  const [useBic, setUseBic] = useState(false);
  const params: ClusterParams = clusterModel === "K-means" ? { kind: "kmeans", k, iterMax, nstart } : { kind: "gmm", G: useBic ? "auto" : gmmG, models: gmmModel === "best" ? "all" : [gmmModel] };
  return { clusterModel, setClusterModel, k, setK, iterMax, setIterMax, nstart, setNstart, gmmG, setGmmG, gmmModel, setGmmModel, useBic, setUseBic, params };
}

/** Runs one job in a fresh web worker; returns a stop function. */
export function runJob(job: Job, onProgress: (p: number) => void, onDone: (r: Extract<JobResult, { type: "result" }>) => void, onError: (m: string) => void): () => void {
  const w = new Worker(new URL("../../lib/dimred/worker.ts", import.meta.url));
  w.onmessage = (e: MessageEvent<JobResult>) => {
    const m = e.data;
    if (m.type === "progress") onProgress(m.done / m.total);
    else {
      w.terminate();
      if (m.type === "error") onError(m.message);
      else onDone(m);
    }
  };
  w.onerror = (e) => { w.terminate(); onError(e.message || "The calculation failed."); };
  w.postMessage(job);
  return () => w.terminate();
}

export function MethodTab({ method, snapshot, ready }: { method: "umap" | "tsne"; snapshot: () => Snapshot | null; ready: string | null }) {
  const name = method === "umap" ? "UMAP" : "t-SNE";
  const policy = usePolicy();
  // UMAP settings (R umap package defaults)
  const [nNeighbors, setNNeighbors] = useState(15);
  const [minDist, setMinDist] = useState(0.1);
  const [spread, setSpread] = useState(1);
  const [nEpochs, setNEpochs] = useState(200);
  const [metric, setMetric] = useState<"euclidean" | "manhattan">("euclidean");
  const [alpha, setAlpha] = useState(1);
  const [gamma, setGamma] = useState(1);
  const [negRate, setNegRate] = useState(5);
  const [mixRatio, setMixRatio] = useState(1);
  const [localConn, setLocalConn] = useState(1);
  // t-SNE settings (Rtsne defaults)
  const [perplexity, setPerplexity] = useState(30);
  const [initialDims, setInitialDims] = useState(50);
  const [usePca, setUsePca] = useState(true);
  const [pcaCenter, setPcaCenter] = useState(true);
  const [pcaScale, setPcaScale] = useState(false);
  const [normalise, setNormalise] = useState(true);
  const [maxIter, setMaxIter] = useState(1000);
  const [momentum, setMomentum] = useState(0.5);
  const [finalMomentum, setFinalMomentum] = useState(0.8);
  const [exaggeration, setExaggeration] = useState(12);
  const cs = useClusterSettings();
  // seed and chart
  const [fixSeed, setFixSeed] = useState(false);
  const [seedValue, setSeedValue] = useState(1234);
  const [xBounds, setXBounds] = useState(false);
  const [xmin, setXmin] = useState(0);
  const [xmax, setXmax] = useState(0);
  const [yBounds, setYBounds] = useState(false);
  const [ymin, setYmin] = useState(0);
  const [ymax, setYmax] = useState(0);
  const [labels, setLabels] = useState(true);
  const [title1, setTitle1] = useState("");
  const [title2, setTitle2] = useState("");

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const plot1 = useRef<PlotHandle>(null);
  const plot2 = useRef<PlotHandle>(null);

  useEffect(() => () => stopRef.current?.(), []);

  function run() {
    const snap = snapshot();
    if (!snap) return;
    const seed = fixSeed && Number.isFinite(seedValue) ? Math.round(seedValue) : 1000 + Math.floor(Math.random() * 9000);
    const cluster = cs.params;
    const job: Job =
      method === "umap"
        ? { method, X: snap.X, seed, cluster, params: { nNeighbors, minDist, spread, nEpochs, metric, learningRate: alpha, repulsionStrength: gamma, negativeSampleRate: negRate, setOpMixRatio: mixRatio, localConnectivity: localConn } }
        : { method, X: snap.X, seed, cluster, params: { perplexity, initialDims, pca: usePca, pcaCenter, pcaScale, normalise, maxIter, momentum, finalMomentum, exaggeration } };
    const numbers = [...Object.values(job.params), ...Object.values(cluster)].filter((v) => typeof v === "number");
    if (numbers.some((v) => !Number.isFinite(v))) { setError(`Please fill in every ${name} and clustering setting.`); return; }
    stopRef.current?.();
    setRunning(true);
    setError(null);
    setProgress(0);
    const clusterModel = cs.clusterModel;
    stopRef.current = runJob(
      job,
      setProgress,
      (m) => { setRunning(false); stopRef.current = null; setResult({ ...m, seed, snap, clusterModel }); },
      (msg) => { setRunning(false); stopRef.current = null; setError(msg); }
    );
  }

  function stop() {
    stopRef.current?.();
    stopRef.current = null;
    setRunning(false);
  }

  const view = useMemo(() => {
    if (!result) return null;
    const xs = result.embedding.map((p) => p[0]), ys = result.embedding.map((p) => p[1]);
    const none: Legend = { kind: "categories", title: "class", items: [{ label: "None", color: PALETTE[0] }] };
    const cls = result.snap.classCol ? colourBy(result.snap.classValues, result.snap.classCol, result.snap.classAsFactor) : { colors: xs.map(() => PALETTE[0]), legend: none };
    const clu = colourBy(result.clusters, "Cluster", true);
    return { xs, ys, cls, clu };
  }, [result]);

  const grid = useMemo(() => {
    if (!result) return null;
    const s = result.snap;
    return {
      columns: [...s.dims, ...(s.classCol ? [s.classCol] : []), "x", "y", "cluster"],
      rows: s.X.map((r, i) => [...r, ...(s.classCol ? [s.classValues[i]] : []), result.embedding[i][0], result.embedding[i][1], result.clusters[i]] as Cell[]),
    };
  }, [result]);

  const xlim: [number, number] | null = xBounds && xmax > xmin ? [xmin, xmax] : null;
  const ylim: [number, number] | null = yBounds && ymax > ymin ? [ymin, ymax] : null;
  const fileBase = method === "umap" ? "umap" : "tsne";

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        <div className={`${card} space-y-4 xl:col-span-3`}>
          <h3 className={heading}>{name} settings</h3>
          {method === "umap" ? (
            <div className="grid grid-cols-2 gap-2">
              <Num name="Nearest neighbours" value={nNeighbors} set={setNNeighbors} step={1} min={2} max={100} />
              <Select name="Metric" value={metric} set={setMetric} options={["euclidean", "manhattan"] as const} />
              <Num name="Epochs" value={nEpochs} set={setNEpochs} step={1} min={2} max={1000} />
              <Num name="Min. distance" value={minDist} set={setMinDist} step={0.05} min={0} />
              <Num name="Spread" value={spread} set={setSpread} step={0.1} min={0.1} />
              <Num name="Alpha (learning rate)" value={alpha} set={setAlpha} step={0.1} min={0.01} />
              <Num name="Gamma (repulsion)" value={gamma} set={setGamma} step={0.1} min={0.01} />
              <Num name="Negative sample rate" value={negRate} set={setNegRate} step={1} min={1} />
              <Num name="Set op mix ratio" value={mixRatio} set={setMixRatio} step={0.1} min={0} max={1} />
              <Num name="Local connectivity" value={localConn} set={setLocalConn} step={1} min={1} />
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <Num name="Perplexity" value={perplexity} set={setPerplexity} step={1} min={2} max={100} />
              <Num name="Initial dimensions" value={initialDims} set={setInitialDims} step={1} min={2} max={100} />
              <Num name="Max. iterations" value={maxIter} set={setMaxIter} step={50} min={100} max={5000} />
              <Num name="Exaggeration factor" value={exaggeration} set={setExaggeration} step={1} min={1} max={20} />
              <Num name="Momentum" value={momentum} set={setMomentum} step={0.05} min={0} max={1} />
              <Num name="Final momentum" value={finalMomentum} set={setFinalMomentum} step={0.05} min={0} max={1} />
              <div className="col-span-2 grid grid-cols-2 gap-1 pt-1">
                <Check name="PCA first" value={usePca} set={setUsePca} />
                <Check name="Normalise" value={normalise} set={setNormalise} />
                <Check name="PCA centre" value={pcaCenter} set={setPcaCenter} />
                <Check name="PCA scale" value={pcaScale} set={setPcaScale} />
              </div>
              <p className="col-span-2 text-xs text-gray-500">Perplexity must satisfy 3 × perplexity &lt; rows − 1. This is exact t-SNE: a few seconds for 1,000 rows, about 20 s for 3,000, much longer above that.</p>
            </div>
          )}
          <div className="space-y-2 border-t border-gray-800 pt-3">
            <h3 className={heading}>Clustering</h3>
            <ClusterSettings s={cs} />
          </div>
        </div>

        <div className={`${card} space-y-4 xl:col-span-2`}>
          <div className="space-y-2">
            {running ? (
              <>
                <button className={`${btn} w-full bg-gray-700 text-white`} onClick={stop}>Stop</button>
                <div className="h-2 overflow-hidden rounded bg-gray-800"><div className="h-full bg-orange-500 transition-all" style={{ width: `${Math.round(progress * 100)}%` }} /></div>
                <p className="text-xs text-gray-400">Running {name}… {Math.round(progress * 100)}%</p>
              </>
            ) : (
              <button className={`${btnRun} w-full`} onClick={run} disabled={!!ready}>Generate plots</button>
            )}
            {ready && <p className="text-xs text-amber-300">{ready}</p>}
            <p className="text-xs text-gray-500">Press again to rerun with new settings or a new random seed.</p>
          </div>
          <div className="space-y-2 border-t border-gray-800 pt-3">
            <h3 className={heading}>Seed</h3>
            {result && <p className="rounded bg-gray-950 px-2 py-1 font-mono text-xs text-gray-300">Seed used: {result.seed}</p>}
            <Check name="Set seed" value={fixSeed} set={setFixSeed} />
            {fixSeed && <Num name="Seed" value={seedValue} set={setSeedValue} step={1} />}
          </div>
          <div className="space-y-2 border-t border-gray-800 pt-3">
            <h3 className={heading}>Downloads</h3>
            <button className={`${btnGreen} w-full`} disabled={!grid || policy.restricted} title={policy.restricted ? LOCKED_NOTE : undefined} onClick={() => grid && downloadCsv(`${fileBase}data.csv`, grid.columns, grid.rows, policy.credits)}>Data grid (CSV)</button>
            <button className={`${btnGreen} w-full`} disabled={!result} onClick={() => plot1.current?.downloadPng(`${fileBase}plot.png`)}>{name} plot (PNG)</button>
            <button className={`${btnGreen} w-full`} disabled={!result} onClick={() => plot2.current?.downloadPng(`${fileBase}clusplot.png`)}>Cluster plot (PNG)</button>
          </div>
        </div>

        <div className="space-y-4 xl:col-span-5">
          {error && <p className="rounded border border-red-900 bg-red-950/50 p-3 text-sm text-red-300">{error}</p>}
          {result && view ? (
            <>
              <div className="overflow-hidden rounded-lg">
                <ScatterPlot ref={plot1} title={title1 || `${name} Dimension Reduction`} xs={view.xs} ys={view.ys} colors={view.cls.colors} legend={view.cls.legend} centres={labels ? result.centres : undefined} xlim={xlim} ylim={ylim} />
              </div>
              <div className="overflow-hidden rounded-lg">
                <ScatterPlot ref={plot2} title={title2 || `${name} Dimension Reduction with ${result.clusterModel} Clusters`} xs={view.xs} ys={view.ys} colors={view.clu.colors} legend={view.clu.legend} centres={labels ? result.centres : undefined} xlim={xlim} ylim={ylim} />
              </div>
              <p className="text-xs text-gray-500">{result.snap.X.length.toLocaleString()} rows · {result.note} · {(result.ms / 1000).toFixed(1)} s</p>
            </>
          ) : (
            <div className={`${card} flex h-64 items-center justify-center text-sm text-gray-500`}>{running ? "Working…" : "Choose data on the Data tab, then press Generate plots."}</div>
          )}
        </div>

        <div className={`${card} space-y-3 xl:col-span-2`}>
          <h3 className={heading}>Chart options</h3>
          <Check name="Set X axis limits" value={xBounds} set={setXBounds} />
          {xBounds && <div className="grid grid-cols-2 gap-2"><Num name="Min. X" value={xmin} set={setXmin} /><Num name="Max. X" value={xmax} set={setXmax} /></div>}
          <Check name="Set Y axis limits" value={yBounds} set={setYBounds} />
          {yBounds && <div className="grid grid-cols-2 gap-2"><Num name="Min. Y" value={ymin} set={setYmin} /><Num name="Max. Y" value={ymax} set={setYmax} /></div>}
          <div className="border-t border-gray-800 pt-3"><Check name="Show cluster labels" value={labels} set={setLabels} /></div>
          <label className="block border-t border-gray-800 pt-3">
            <span className={label}>{name} plot title</span>
            <input className={input} value={title1} placeholder={`${name} Dimension Reduction`} onChange={(e) => setTitle1(e.target.value)} />
          </label>
          <label className="block">
            <span className={label}>Cluster plot title</span>
            <input className={input} value={title2} placeholder="Default title" onChange={(e) => setTitle2(e.target.value)} />
          </label>
        </div>
      </div>
      {grid && <div className={card}><DataGrid columns={grid.columns} rows={grid.rows} /></div>}
    </div>
  );
}
