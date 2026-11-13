"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { GeostatData, GeostatOptions, Series } from "@/lib/geostat/data";
import {
  KdTree, MODEL_TYPES, autoFit, crossValidate, experimentalVariogram, interpolateGrid, makeProjection, medianSpacing, mergeColocated, quantile,
  type CvStats, type Grid, type Lag, type Method, type ModelType, type Pt, type VariogramModel,
} from "@/lib/geostat/engine";
import { writeGeoTiff } from "@/lib/geostat/geotiff";
import { datasetName } from "@/lib/geochem-methods";
import { csvWithCredits } from "@/lib/csv";
import { Check, Notice, Num, Select, btnGreen, btnRun, card, downloadSvgPng, downloadText, heading, input, label } from "@/components/multivariate/ui";
import GridMap, { type MapSample } from "./GridMap";
import { CvChart, Histogram, VariogramChart } from "./Charts";
import { gridSnapshotBase64 } from "./render";

// Geostatistics page (/tools/geostatistics), phase 1: grid ONE series (one dataset, sample type, element, survey, method, fraction and unit) of
// soil, till or lake-sediment samples by ordinary kriging or inverse-distance weighting, with the variogram, a kriging error map and
// leave-one-out cross-validation. The server only supplies the sample values (src/lib/geostat/data.ts); everything else runs in the browser
// (src/lib/geostat/engine.ts), so variogram changes need no round trip. The written interpretation comes from /api/geostat/interpret.
// Phase 2 (not here): stream-sediment catchment maps, indicator kriging, co-kriging.

const LIMITS = [1000, 2500, 5000] as const;
const K_OPTIONS = ["8", "16", "24", "32", "48"] as const;
const CELL_OPTIONS = ["80", "120", "160", "200"] as const;
const EXAMPLE = { source: "SWEDEN_SGU_MARKGEOKEMI", sampleType: "Till Sample (unspecified)", element: "Cu", box: { w: "17", s: "64", e: "21.5", n: "66" } };

type Row = { id: string; lon: number; lat: number; val: number; t: number; bdl: boolean; gt: boolean };
type RunResult = { grid: Grid; cv: CvStats; method: Method; ms: number; cellKm: number; maskKm: number; settingsKey: string; nPts: number };

const fmtV = (v: number) => (!Number.isFinite(v) ? "NA" : Math.abs(v) >= 1000 ? Math.round(v).toLocaleString("en-US") : String(Number(v.toPrecision(3))));
const md = {
  h2: (p: { children?: React.ReactNode }) => <h2 className="mt-4 mb-1 text-sm font-semibold text-emerald-300 first:mt-0">{p.children}</h2>,
  p: (p: { children?: React.ReactNode }) => <p className="mb-2 text-sm leading-relaxed text-gray-200">{p.children}</p>,
  ul: (p: { children?: React.ReactNode }) => <ul className="mb-2 list-disc space-y-1 pl-5 text-sm text-gray-200">{p.children}</ul>,
  ol: (p: { children?: React.ReactNode }) => <ol className="mb-2 list-decimal space-y-1 pl-5 text-sm text-gray-200">{p.children}</ol>,
  strong: (p: { children?: React.ReactNode }) => <strong className="font-semibold text-gray-50">{p.children}</strong>,
};
const seriesLabel = (s: Series) => [s.survey ? `${s.survey}${s.surveyDesc ? ` (${s.surveyDesc})` : ""}` : null, s.method ?? "method not recorded", s.fraction ?? "fraction not recorded", s.unit ?? "unit?"].filter(Boolean).join(" · ");
const asciiOnly = (s: string) => s.normalize("NFKD").replace(/[^\x20-\x7e]/g, "");

export function GeostatApp() {
  const [options, setOptions] = useState<GeostatOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dsKey, setDsKey] = useState("");
  const [element, setElement] = useState("");
  const [box, setBox] = useState({ w: "", s: "", e: "", n: "" });
  const [series, setSeries] = useState<Series[] | null>(null);
  const [seriesIdx, setSeriesIdx] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [limit, setLimit] = useState<number>(5000);
  const [data, setData] = useState<(GeostatData & { series: Series; source: string; sampleType: string; element: string }) | null>(null);

  // Processing and model settings
  const [logT, setLogT] = useState(true);
  const [bdlMode, setBdlMode] = useState<"half" | "full" | "exclude">("half");
  const [maxLag, setMaxLag] = useState(NaN);
  const [nLags, setNLags] = useState(15);
  const [autoModel, setAutoModel] = useState(true);
  const [model, setModel] = useState<VariogramModel>({ type: "spherical", nugget: 0, sill: 1, range: 10 });
  const [methodKind, setMethodKind] = useState<"kriging" | "idw">("kriging");
  const [k, setK] = useState<(typeof K_OPTIONS)[number]>("24");
  const [power, setPower] = useState(2);
  const [cells, setCells] = useState<(typeof CELL_OPTIONS)[number]>("120");
  const [maskKm, setMaskKm] = useState(NaN);
  const [showSamples, setShowSamples] = useState(true);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [text, setText] = useState("");
  const [interpreting, setInterpreting] = useState(false);
  const [interpError, setInterpError] = useState<string | null>(null);
  const variogramRef = useRef<SVGSVGElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    fetch("/api/geostat/options")
      .then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error ?? "Could not load the options."); setOptions(j); })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const dataset = useMemo(() => options?.datasets.find((d) => `${d.source}|${d.sampleType}` === dsKey) ?? null, [options, dsKey]);
  const bySource = useMemo(() => {
    const m = new Map<string, GeostatOptions["datasets"]>();
    options?.datasets.forEach((d) => m.set(d.source, [...(m.get(d.source) ?? []), d]));
    return [...m.entries()].sort((a, b) => datasetName(a[0]).localeCompare(datasetName(b[0])));
  }, [options]);

  const bbox = () => {
    const v = [box.w, box.s, box.e, box.n].map(Number);
    return [box.w, box.s, box.e, box.n].every((x) => x.trim() !== "") && v.every(Number.isFinite) ? v : null;
  };

  async function post<T>(url: string, body: unknown): Promise<T> {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((j as { error?: string }).error ?? "The request failed.");
    return j as T;
  }

  async function findSeries() {
    const bb = bbox();
    if (!dataset || !element) { setError("Choose a dataset and an element."); return; }
    if (!bb) { setError("Fill in all four edges of the area, in decimal degrees."); return; }
    setBusy("series"); setError(null); setSeries(null); setData(null); setResult(null); setText("");
    try {
      const r = await post<{ series: Series[] }>("/api/geostat/series", { source: dataset.source, sampleType: dataset.sampleType, element, bbox: bb });
      if (!r.series.length) throw new Error(`No ${element} results for ${dataset.sampleType.toLowerCase()} samples of this dataset inside that area.`);
      setSeries(r.series);
      setSeriesIdx(0);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  }

  async function loadData() {
    const bb = bbox();
    if (!dataset || !series || !bb) return;
    const s = series[seriesIdx];
    setBusy("data"); setError(null); setResult(null); setText("");
    try {
      const r = await post<GeostatData>("/api/geostat/data", {
        source: dataset.source, sampleType: dataset.sampleType, element, bbox: bb, limit, seed: Math.floor(Math.random() * 1e9),
        series: { survey: s.survey, method: s.method, fraction: s.fraction, unit: s.unit },
      });
      if (r.points.length < 30) throw new Error(`Only ${r.points.length} usable samples in this series and area: at least 30 are needed for a variogram.`);
      setData({ ...r, series: s, source: dataset.source, sampleType: dataset.sampleType, element });
      setAutoModel(true);
      setMaxLag(NaN);
      setMaskKm(NaN);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  }

  // ---- values: one per sample, below-detection substituted (and flagged), transformed ----
  const proc = useMemo(() => {
    if (!data) return null;
    const rows: Row[] = [];
    let nBdl = 0, nBdlDropped = 0, nGt = 0, nDropped = 0;
    const factor = bdlMode === "half" ? 0.5 : 1;
    data.points.forEach(([lon, lat, v, dl, flags], i) => {
      let val: number, bdl = false;
      if (v !== null && v > 0) val = v;
      else if (dl !== null && dl > 0) {
        nBdl++;
        if (bdlMode === "exclude") { nBdlDropped++; return; }
        val = dl * factor;
        bdl = true;
      } else { nDropped++; return; }
      if (flags & 1) nGt++;
      rows.push({ id: data.ids[i], lon, lat, val, t: logT ? Math.log10(val) : val, bdl, gt: (flags & 1) === 1 });
    });
    const merged = mergeColocated(rows);
    const lon0 = (Math.min(...rows.map((r) => r.lon)) + Math.max(...rows.map((r) => r.lon))) / 2;
    const lat0 = (Math.min(...rows.map((r) => r.lat)) + Math.max(...rows.map((r) => r.lat))) / 2;
    const proj = makeProjection(lon0, lat0);
    const pts: Pt[] = merged.map((m) => { const [x, y] = proj.fwd(m.lon, m.lat); return { x, y, z: m.t }; });
    const tree = new KdTree(pts);
    const zs = pts.map((p) => p.z);
    const mean = zs.reduce((a, b) => a + b, 0) / zs.length;
    const variance = zs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(zs.length - 1, 1);
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const diag = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    const spacing = medianSpacing(pts, tree);
    const sortedVals = rows.map((r) => r.val).sort((a, b) => a - b);
    const sortedT = rows.map((r) => r.t).sort((a, b) => a - b);
    return { rows, merged, pts, tree, proj, variance, diag, spacing, nBdl, nBdlDropped, nGt, nDropped, sortedVals, sortedT };
  }, [data, logT, bdlMode]);

  // Defaults that depend on the data: maximum lag about a third of the extent, mask about 3 sample spacings.
  useEffect(() => {
    if (!proc) return;
    if (!Number.isFinite(maxLag)) setMaxLag(Number((proc.diag / 3).toPrecision(2)));
    if (!Number.isFinite(maskKm)) setMaskKm(Number(Math.max(proc.spacing * 3, 0.05).toPrecision(2)));
  }, [proc, maxLag, maskKm]);

  const lags: Lag[] = useMemo(() => {
    if (!proc || !Number.isFinite(maxLag) || maxLag <= 0) return [];
    const sub = proc.pts.length > 3000 ? proc.pts.filter((_, i) => i % Math.ceil(proc.pts.length / 3000) === 0) : proc.pts;
    return experimentalVariogram(sub, maxLag, Math.min(Math.max(nLags, 5), 40));
  }, [proc, maxLag, nLags]);

  useEffect(() => {
    if (autoModel && proc && lags.length >= 3) setModel(autoFit(lags, maxLag, proc.variance));
  }, [autoModel, lags, proc, maxLag]);

  const editModel = (patch: Partial<VariogramModel>) => { setAutoModel(false); setModel((m) => ({ ...m, ...patch })); };
  const tLabel = logT ? `log10 ${data?.element ?? ""}` : `${data?.element ?? ""} ${data?.series.unit ?? ""}`;
  const back = (t: number) => (logT ? Math.pow(10, t) : t);
  const unit = data?.series.unit ?? "";

  const methodNow: Method = methodKind === "kriging" ? { kind: "kriging", model, k: Number(k) } : { kind: "idw", power, k: Number(k) };
  const settingsKey = JSON.stringify([methodNow, cells, maskKm, logT, bdlMode, data?.ids.length, data?.ids[0]]);

  function run() {
    if (!proc) return;
    setRunning(true);
    setText("");
    setTimeout(() => {
      try {
        const t0 = performance.now();
        const lons = proc.merged.map((m) => m.lon), lats = proc.merged.map((m) => m.lat);
        let west = Math.min(...lons), east = Math.max(...lons), south = Math.min(...lats), north = Math.max(...lats);
        const padLon = (east - west) * 0.02 || 0.01, padLat = (north - south) * 0.02 || 0.01;
        west -= padLon; east += padLon; south -= padLat; north += padLat;
        const ew = (east - west) * proc.proj.kx, ns = (north - south) * proc.proj.ky;
        const cellKm = Math.max(ew, ns) / Number(cells);
        const nx = Math.max(2, Math.round(ew / cellKm)), ny = Math.max(2, Math.round(ns / cellKm));
        const mask = Number.isFinite(maskKm) && maskKm > 0 ? maskKm : proc.spacing * 3;
        const grid = interpolateGrid(proc.pts, proc.tree, proc.proj, methodNow, { west, south, east, north }, nx, ny, mask);
        const cv = crossValidate(proc.pts, proc.tree, methodNow);
        setResult({ grid, cv, method: methodNow, ms: performance.now() - t0, cellKm, maskKm: mask, settingsKey, nPts: proc.pts.length });
      } catch (e) {
        setError(`The interpolation failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setRunning(false);
      }
    }, 30);
  }

  // ---- display scales ----
  const scale = useMemo(() => {
    if (!proc) return null;
    const lo = quantile(proc.sortedT, 0.02), hi = quantile(proc.sortedT, 0.98);
    const tick = (t: number) => ({ t, label: fmtV(back(t)) });
    const n = 5;
    const ticksZ = Array.from({ length: n }, (_, i) => tick(lo + ((hi - lo) * i) / (n - 1)));
    return { lo, hi, ticksZ };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proc]);
  const sdScale = useMemo(() => {
    if (!result || result.method.kind !== "kriging") return null;
    const v = Array.from(result.grid.sd).filter(Number.isFinite).sort((a, b) => a - b);
    if (!v.length) return null;
    const lo = quantile(v, 0.01), hi = quantile(v, 0.99);
    const ticks = Array.from({ length: 4 }, (_, i) => {
      const t = lo + ((hi - lo) * i) / 3;
      return { t, label: logT ? `×${Number(Math.pow(10, t).toPrecision(2))}` : `±${fmtV(t)}` };
    });
    return { lo, hi, ticks };
  }, [result, logT]);

  const mapSamples: MapSample[] = useMemo(
    () => proc?.rows.map((r) => ({ lon: r.lon, lat: r.lat, t: r.t, bdl: r.bdl, popup: `<strong>${fmtV(r.val)} ${unit}</strong>${r.bdl ? " (below detection: substituted value)" : ""}${r.gt ? " (above the upper limit)" : ""}<br/>${r.lat.toFixed(4)}, ${r.lon.toFixed(4)}` })) ?? [],
    [proc, unit]
  );

  // ---- summary for the interpretation ----
  function buildSummary() {
    if (!proc || !result || !data) return null;
    const g = result.grid;
    const cellsIdx: number[] = [];
    for (let i = 0; i < g.z.length; i++) if (Number.isFinite(g.z[i])) cellsIdx.push(i);
    const zs = cellsIdx.map((i) => g.z[i]).sort((a, b) => a - b);
    const sep = Math.max(result.maskKm, proc.spacing * 5);
    const top: { lon: number; lat: number; estimate: number; x: number; y: number }[] = [];
    for (const i of [...cellsIdx].sort((a, b) => g.z[b] - g.z[a])) {
      const lon = g.west + ((i % g.nx) + 0.5) * g.dlon, lat = g.north - (Math.floor(i / g.nx) + 0.5) * g.dlat;
      const [x, y] = proc.proj.fwd(lon, lat);
      if (top.every((t) => Math.hypot(t.x - x, t.y - y) > sep)) top.push({ lon, lat, estimate: back(g.z[i]), x, y });
      if (top.length >= 5) break;
    }
    const topSamples = [...proc.rows].sort((a, b) => b.val - a.val).slice(0, 5);
    const r3 = (v: number) => Number(v.toPrecision(3));
    const total = model.nugget + model.sill;
    return {
      dataset: data.source, sampleType: data.sampleType, element: data.element, unit, survey: data.series.survey, surveyDescription: data.series.surveyDesc,
      method: data.series.method, fraction: data.series.fraction,
      samples: {
        matchingInArea: data.matching, loaded: data.points.length, randomDraw: data.matching > data.points.length, used: proc.rows.length,
        distinctLocations: proc.pts.length, belowDetection: proc.nBdl, belowDetectionHandling: bdlMode === "half" ? "half the detection limit" : bdlMode === "full" ? "the detection limit" : "left out",
        aboveUpperLimit: proc.nGt, droppedNoValue: proc.nDropped, medianSpacingKm: r3(proc.spacing),
      },
      distribution: { p5: r3(quantile(proc.sortedVals, 0.05)), p25: r3(quantile(proc.sortedVals, 0.25)), median: r3(quantile(proc.sortedVals, 0.5)), p75: r3(quantile(proc.sortedVals, 0.75)), p95: r3(quantile(proc.sortedVals, 0.95)), max: r3(proc.sortedVals[proc.sortedVals.length - 1]) },
      transform: logT ? "log10" : "none",
      variogram: {
        model: model.type, nugget: r3(model.nugget), partialSill: r3(model.sill), rangeKm: r3(model.range), nuggetShare: r3(total > 0 ? model.nugget / total : 0),
        autoFitted: autoModel, sampleVariance: r3(proc.variance), maxLagKm: maxLag, usedForGrid: result.method.kind === "kriging",
        experimental: lags.map((l) => [r3(l.h), r3(l.gamma), l.pairs]),
      },
      interpolation: {
        method: result.method.kind === "kriging" ? "ordinary kriging" : `inverse distance (power ${power})`, neighbours: result.method.k, cellKm: r3(result.cellKm),
        maskBeyondKm: r3(result.maskKm), gridCells: `${g.nx} x ${g.ny}`, cellsEstimated: cellsIdx.length,
      },
      crossValidation: { n: result.cv.n, meanError: r3(result.cv.meanError), rmse: r3(result.cv.rmse), corrObservedPredicted: r3(result.cv.corr), meanStandardisedError: result.cv.mse === null ? null : r3(result.cv.mse), meanSquaredStandardisedError: result.cv.msse === null ? null : r3(result.cv.msse), units: logT ? "log10" : unit },
      grid: { estimateMedian: r3(back(quantile(zs, 0.5))), estimateP90: r3(back(quantile(zs, 0.9))), estimateMax: r3(back(zs[zs.length - 1])) },
      highestGridAreas: top.map((t) => ({ lon: r3(t.lon), lat: r3(t.lat), estimate: r3(t.estimate) })),
      highestSamples: topSamples.map((s) => ({ lon: Number(s.lon.toFixed(3)), lat: Number(s.lat.toFixed(3)), value: r3(s.val) })),
      area: { west: r3(g.west), south: r3(g.south), east: r3(g.east), north: r3(g.north) },
    };
  }

  async function interpret() {
    const summary = buildSummary();
    if (!summary || !result || !scale || !proc) return;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setInterpreting(true); setInterpError(null); setText("");
    try {
      const image = gridSnapshotBase64(result.grid, scale.lo, scale.hi, proc.rows);
      const res = await fetch("/api/geostat/interpret", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ summary, image }), signal: ac.signal });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        throw new Error((j as { error?: string }).error ?? "The interpretation could not start.");
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const e = JSON.parse(line) as Record<string, unknown>;
          if (e.type === "text") setText((t) => t + String(e.text));
          else if (e.type === "error") setInterpError(String(e.message));
        }
      }
    } catch (e) {
      if (!ac.signal.aborted) setInterpError(e instanceof Error ? e.message : String(e));
    } finally {
      setInterpreting(false);
    }
  }

  // ---- downloads ----
  const baseName = data ? `${data.element}_${data.source}_${(data.series.method ?? "method").replace(/[^A-Za-z0-9]+/g, "-")}`.toLowerCase() : "grid";
  function downloadGridCsv() {
    if (!result || !data) return;
    const g = result.grid;
    const rows: (number | null)[][] = [];
    for (let r = 0; r < g.ny; r++) for (let c = 0; c < g.nx; c++) {
      const i = r * g.nx + c;
      if (!Number.isFinite(g.z[i])) continue;
      const lon = g.west + (c + 0.5) * g.dlon, lat = g.north - (r + 0.5) * g.dlat;
      rows.push([Number(lon.toFixed(6)), Number(lat.toFixed(6)), Number(back(g.z[i]).toPrecision(5)), Number(g.z[i].toPrecision(5)), Number.isFinite(g.sd[i]) ? Number(g.sd[i].toPrecision(4)) : null]);
    }
    const cols = ["lon", "lat", `${data.element}_${unit}_estimate`, logT ? "log10_estimate" : "estimate_raw", logT ? "kriging_sd_log10" : "kriging_sd"];
    downloadText(`${baseName}_grid.csv`, csvWithCredits(cols, rows, data.credits));
  }
  function downloadTiff() {
    if (!result || !data) return;
    const g = result.grid;
    const est = g.z.map((v) => (Number.isFinite(v) ? back(v) : NaN));
    const bands = result.method.kind === "kriging" ? [Float32Array.from(est), g.sd] : [Float32Array.from(est)];
    const desc = asciiOnly(`${data.element} ${unit} ${result.method.kind === "kriging" ? "ordinary kriging" : "IDW"} estimate (band 1, back-transformed${logT ? " from log10" : ""})${bands.length > 1 ? `; band 2 kriging standard deviation (${logT ? "log10 units" : unit})` : ""}. ${data.source} ${data.sampleType}; ${seriesLabel(data.series)}. Data: ${data.credits.join("; ")}`);
    const bytes = writeGeoTiff({ width: g.nx, height: g.ny, bands, west: g.west, north: g.north, dlon: g.dlon, dlat: g.dlat, description: desc });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/tiff" }));
    a.download = `${baseName}_grid.tif`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function downloadSamples() {
    if (!proc || !data) return;
    const rows = proc.rows.map((r) => [r.id, r.lon, r.lat, Number(r.val.toPrecision(6)), r.bdl ? "below detection (substituted)" : r.gt ? "above upper limit" : "", Number(r.t.toPrecision(6))]);
    downloadText(`${baseName}_samples.csv`, csvWithCredits(["sample_id", "lon", "lat", `${data.element}_${unit}`, "flag", logT ? "log10" : "value"], rows, data.credits));
  }

  const stale = result && result.settingsKey !== settingsKey;
  const sel = series?.[seriesIdx];
  const bdlShare = proc ? proc.nBdl / Math.max(data!.points.length, 1) : 0;
  const nuggetShare = model.nugget + model.sill > 0 ? model.nugget / (model.nugget + model.sill) : 0;

  return (
    <div className="min-h-dvh bg-gray-950 text-gray-100">
      <header className="flex flex-wrap items-center gap-3 border-b border-gray-800 px-4 py-3">
        <Link href="/" className="text-sm text-gray-400 hover:text-gray-200">← Assistant</Link>
        <h1 className="text-lg font-semibold">Geostatistics</h1>
        <p className="text-xs text-gray-400">Grid one survey of soil, till or lake-sediment samples by kriging or inverse distance, with the variogram, error map and cross-validation.</p>
        <div className="ml-auto flex gap-3 text-xs">
          <Link href="/tools/geochemistry" className="text-sky-300 hover:underline">Geochemistry</Link>
          <Link href="/tools/multivariate" className="text-emerald-300 hover:underline">Multivariate tools</Link>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-4 p-4">
        {/* Step 1: what to grid */}
        <section className={`${card} space-y-4`}>
          <div className="flex flex-wrap items-baseline gap-3">
            <h2 className={heading}>1. Survey, element and area</h2>
            <button
              className="text-xs text-gray-400 underline hover:text-gray-200"
              onClick={() => { setDsKey(`${EXAMPLE.source}|${EXAMPLE.sampleType}`); setElement(EXAMPLE.element); setBox(EXAMPLE.box); setSeries(null); setData(null); setResult(null); }}
            >
              Example: copper in Swedish till, Skellefteå district
            </button>
          </div>
          {error && <Notice tone="error">{error}</Notice>}
          {!options ? (
            !error && <p className="text-sm text-gray-400">Loading what the database holds…</p>
          ) : (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <div className="space-y-3">
                <label className="block">
                  <span className={label}>Dataset and sample type (soil, till and lake sediment only)</span>
                  <select className={input} value={dsKey} onChange={(e) => { setDsKey(e.target.value); setSeries(null); setData(null); setResult(null); }}>
                    <option value="">Choose…</option>
                    {bySource.map(([source, list]) => (
                      <optgroup key={source} label={datasetName(source)}>
                        {list.map((d) => <option key={d.sampleType} value={`${d.source}|${d.sampleType}`}>{d.sampleType} ({d.n.toLocaleString()})</option>)}
                      </optgroup>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className={label}>Element</span>
                  <select className={input} value={element} disabled={!dataset} onChange={(e) => { setElement(e.target.value); setSeries(null); setData(null); setResult(null); }}>
                    <option value="">Choose…</option>
                    {dataset?.elements.map((el) => <option key={el.symbol} value={el.symbol}>{el.symbol} ({el.n.toLocaleString()} samples)</option>)}
                  </select>
                </label>
                <p className="text-[11px] text-gray-500">Stream sediments are not offered: each one stands for its upstream catchment, so they need catchment maps rather than kriging (planned).</p>
              </div>
              <div className="space-y-2">
                <span className={label}>Area (decimal degrees; each side at most 800 km)</span>
                <div className="grid grid-cols-4 gap-1.5">
                  {(["w", "s", "e", "n"] as const).map((key) => (
                    <label key={key} className="block">
                      <span className={label}>{{ w: "West", s: "South", e: "East", n: "North" }[key]}</span>
                      <input className={input} type="number" value={box[key]} onChange={(e) => { setBox({ ...box, [key]: e.target.value }); setSeries(null); }} />
                    </label>
                  ))}
                </div>
                <button className={btnGreen} disabled={busy !== null || !dataset || !element} onClick={findSeries}>
                  {busy === "series" ? "Searching…" : "Find surveys and methods"}
                </button>
              </div>
              <div className="space-y-2 text-xs text-gray-300">
                <span className={label}>One grid = one survey, one method, one fraction</span>
                {!series ? (
                  <p className="text-gray-500">Different labs, digestions and size fractions give different numbers for the same soil, so a grid never mixes them. Choose the series to grid after the search.</p>
                ) : (
                  <div className="max-h-56 space-y-1 overflow-auto pr-1">
                    {series.map((s, i) => (
                      <label key={i} className={`flex items-start gap-2 rounded border p-1.5 ${i === seriesIdx ? "border-emerald-600 bg-emerald-950/30" : "border-gray-800"}`}>
                        <input type="radio" className="mt-0.5 accent-emerald-500" checked={i === seriesIdx} onChange={() => { setSeriesIdx(i); setData(null); setResult(null); }} />
                        <span>
                          <span className="block text-gray-100">{seriesLabel(s)}</span>
                          <span className="text-gray-400">{s.samples.toLocaleString()} samples{s.bdl ? `, ${s.bdl.toLocaleString()} below detection (${Math.round((100 * s.bdl) / s.samples)}%)` : ""}</span>
                          {s.method && /UNKNOWN/i.test(s.method) && <span className="block text-amber-300/90">Method not recorded by the source: it may combine several methods.</span>}
                        </span>
                      </label>
                    ))}
                  </div>
                )}
                {series && (
                  <div className="flex flex-wrap items-end gap-2 pt-1">
                    <label className="block">
                      <span className={label}>Maximum samples</span>
                      <select className={input} value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
                        {LIMITS.map((v) => <option key={v} value={v}>{v.toLocaleString()}</option>)}
                      </select>
                    </label>
                    <button className={btnGreen} disabled={busy !== null || !sel} onClick={loadData}>{busy === "data" ? "Loading…" : "Load samples"}</button>
                  </div>
                )}
              </div>
            </div>
          )}
        </section>

        {data && proc && (
          <>
            {/* Step 2: data and variogram */}
            <section className={`${card} space-y-3`}>
              <h2 className={heading}>2. Values and variogram</h2>
              <p className="text-sm text-gray-200">
                {proc.rows.length.toLocaleString()} samples of {data.element} ({seriesLabel(data.series)})
                {data.matching > data.points.length ? `, a random draw from ${data.matching.toLocaleString()} in the area` : ""}; {proc.pts.length.toLocaleString()} distinct locations, median spacing {fmtV(proc.spacing)} km.
              </p>
              {proc.nBdl > 0 && (
                <Notice tone={bdlShare > 0.5 ? "warn" : "info"}>
                  {proc.nBdl.toLocaleString()} samples ({Math.round(100 * bdlShare)}%) are below the detection limit:{" "}
                  {bdlMode === "exclude" ? "left out." : `set to ${bdlMode === "half" ? "half" : "the full value of"} their stored detection limit and drawn as hollow circles on the maps.`}
                  {bdlShare > 0.5 ? " With so many censored values the variogram and the grid mostly describe the detection limit: treat the result with great caution." : ""}
                </Notice>
              )}
              {proc.nDropped > 0 && <p className="text-xs text-gray-400">{proc.nDropped} samples left out: no positive value and no detection limit.</p>}
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                <div className="space-y-3">
                  <Check name="Log-transform (log10; recommended for trace elements)" value={logT} set={(v) => { setLogT(v); setAutoModel(true); }} />
                  <Select name="Below-detection values" value={bdlMode} set={(v) => { setBdlMode(v); setAutoModel(true); }} options={["half", "full", "exclude"] as const} labels={{ half: "Half the detection limit", full: "The detection limit", exclude: "Leave them out" }} />
                  <div className="grid grid-cols-2 gap-2">
                    <Num name="Maximum lag (km)" value={maxLag} set={(v) => { setMaxLag(v); }} min={0} />
                    <Num name="Number of lags" value={nLags} set={setNLags} step={1} min={5} max={40} />
                  </div>
                  <div className="rounded border border-gray-800 p-2 space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-400">Model {autoModel ? "(auto-fitted)" : "(edited)"}</span>
                      <button className="ml-auto text-xs text-emerald-300 underline" onClick={() => setAutoModel(true)}>Auto-fit</button>
                    </div>
                    <Select name="Type" value={model.type} set={(v: ModelType) => editModel({ type: v })} options={MODEL_TYPES} />
                    <div className="grid grid-cols-3 gap-2">
                      <Num name="Nugget" value={Number(model.nugget.toPrecision(3))} set={(v) => editModel({ nugget: Math.max(0, v || 0) })} min={0} />
                      <Num name="Partial sill" value={Number(model.sill.toPrecision(3))} set={(v) => editModel({ sill: Math.max(1e-9, v || 0) })} min={0} />
                      <Num name="Range (km)" value={Number(model.range.toPrecision(3))} set={(v) => editModel({ range: Math.max(1e-6, v || 0) })} min={0} />
                    </div>
                    <p className="text-[11px] text-gray-500">Nugget share {Math.round(100 * nuggetShare)}%. {nuggetShare > 0.5 ? "High: much of the variation is at distances below the sample spacing, or is sampling and analytical noise." : "The range is the distance over which samples are related."}{model.type === "exponential" ? " Exponential range = practical range (95% of the sill)." : ""}</p>
                  </div>
                </div>
                <div className="lg:col-span-2 space-y-2">
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-gray-400">Experimental semivariogram (dot size = number of pairs) and model</span>
                    <button className="ml-auto text-xs text-gray-400 underline" onClick={() => downloadSvgPng(variogramRef.current, `${baseName}_variogram.png`)}>PNG</button>
                  </div>
                  {lags.length >= 2 ? (
                    <VariogramChart ref={variogramRef} lags={lags} model={model} maxLag={maxLag} variance={proc.variance} yLabel={`Semivariance (${logT ? "log10 units²" : `${unit}²`})`} />
                  ) : <Notice tone="warn">Not enough sample pairs within the maximum lag. Increase it.</Notice>}
                  <details className="text-xs text-gray-400">
                    <summary className="cursor-pointer">Histogram of the values</summary>
                    <Histogram values={proc.rows.map((r) => r.t)} label={tLabel} bdlCut={proc.rows.some((r) => r.bdl) ? Math.max(...proc.rows.filter((r) => r.bdl).map((r) => r.t)) : undefined} />
                  </details>
                </div>
              </div>
            </section>

            {/* Step 3: interpolation */}
            <section className={`${card} space-y-3`}>
              <h2 className={heading}>3. Interpolation</h2>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-6 items-end">
                <Select name="Method" value={methodKind} set={setMethodKind} options={["kriging", "idw"] as const} labels={{ kriging: "Ordinary kriging", idw: "Inverse distance" }} />
                <Select name="Neighbours (nearest samples)" value={k} set={setK} options={K_OPTIONS} />
                {methodKind === "idw" ? <Num name="IDW power" value={power} set={setPower} min={1} max={4} step={0.5} /> : <div className="hidden md:block" />}
                <Select name="Cells along the longer side" value={cells} set={setCells} options={CELL_OPTIONS} />
                <Num name="Leave blank beyond (km)" value={maskKm} set={setMaskKm} min={0} />
                <button className={btnRun} disabled={running} onClick={run}>{running ? "Running…" : result ? "Run again" : "Run"}</button>
              </div>
              <p className="text-[11px] text-gray-500">Cells farther than the blank distance from every sample are left empty rather than extrapolated (default three times the median sample spacing). Kriging uses the variogram model above.</p>
              {stale && <Notice tone="warn">Settings have changed since this grid was made: run again to update it.</Notice>}
            </section>

            {result && scale && (
              <section className="space-y-4">
                <div className={`${card} space-y-3`}>
                  <div className="flex flex-wrap items-center gap-3">
                    <h2 className={heading}>4. Results</h2>
                    <span className="text-xs text-gray-400">{result.grid.nx} × {result.grid.ny} cells of about {fmtV(result.cellKm)} km, {result.nPts.toLocaleString()} locations, {Math.round(result.ms).toLocaleString()} ms</span>
                    <div className="ml-auto flex flex-wrap gap-3 text-xs">
                      <Check name="Show samples" value={showSamples} set={setShowSamples} />
                      <button className="text-gray-300 underline" onClick={downloadGridCsv}>Grid CSV</button>
                      <button className="text-gray-300 underline" onClick={downloadTiff}>GeoTIFF</button>
                      {!data.restricted && <button className="text-gray-300 underline" onClick={downloadSamples}>Samples CSV</button>}
                    </div>
                  </div>
                  <div className={`grid grid-cols-1 gap-4 ${result.method.kind === "kriging" ? "lg:grid-cols-2" : ""}`}>
                    <div>
                      <p className="mb-1 text-xs text-gray-300">Estimate: {data.element} {unit}{logT ? " (back-transformed from log10: closer to a median than a mean)" : ""}</p>
                      <GridMap grid={result.grid} band="z" lo={scale.lo} hi={scale.hi} samples={mapSamples} legendTitle={`${data.element} ${unit}`} legendTicks={scale.ticksZ} showSamples={showSamples} colourSamples />
                    </div>
                    {result.method.kind === "kriging" && sdScale && (
                      <div>
                        <p className="mb-1 text-xs text-gray-300">Kriging standard deviation{logT ? " as a factor (×1.5 = the true value is likely within 1.5 times either way)" : ""}: higher away from samples</p>
                        <GridMap grid={result.grid} band="sd" lo={sdScale.lo} hi={sdScale.hi} samples={mapSamples} legendTitle="Kriging error" legendTicks={sdScale.ticks} showSamples={showSamples} colourSamples={false} />
                      </div>
                    )}
                  </div>
                  <p className="text-[11px] text-gray-500">Kriging and inverse distance both smooth: a single high sample is pulled down to its neighbours&apos; level. Check the sample points, not only the colours. Colours are stretched between the 2nd and 98th percentile of the samples.</p>
                </div>

                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                  <div className={`${card} space-y-2`}>
                    <h3 className="text-sm font-semibold text-gray-200">Leave-one-out cross-validation</h3>
                    <p className="text-xs text-gray-400">Each of {result.cv.n.toLocaleString()} samples predicted from its neighbours without itself ({logT ? "log10 units" : unit}).</p>
                    <table className="text-sm">
                      <tbody className="[&_td]:py-0.5 [&_td]:pr-4">
                        <tr><td className="text-gray-400">Mean error (ideal 0)</td><td>{fmtV(result.cv.meanError)}</td></tr>
                        <tr><td className="text-gray-400">Root mean square error</td><td>{fmtV(result.cv.rmse)}{logT ? ` (a factor of ×${fmtV(Math.pow(10, result.cv.rmse))})` : ""}</td></tr>
                        <tr><td className="text-gray-400">Correlation observed vs predicted</td><td>{fmtV(result.cv.corr)}</td></tr>
                        {result.cv.msse !== null && <tr><td className="text-gray-400">Mean standardised error (ideal 0)</td><td>{fmtV(result.cv.mse ?? NaN)}</td></tr>}
                        {result.cv.msse !== null && <tr><td className="text-gray-400">Mean squared standardised error (ideal 1)</td><td>{fmtV(result.cv.msse)}{result.cv.msse > 1.5 ? " — error map too optimistic" : result.cv.msse < 0.67 ? " — error map too pessimistic" : ""}</td></tr>}
                      </tbody>
                    </table>
                  </div>
                  <div className={`${card} space-y-2`}>
                    <h3 className="text-sm font-semibold text-gray-200">Observed vs predicted</h3>
                    <CvChart pairs={result.cv.pairs} label={logT ? "log10" : unit} />
                  </div>
                </div>

                <div className={`${card} space-y-2`}>
                  <div className="flex flex-wrap items-center gap-3">
                    <h2 className={heading}>Interpretation</h2>
                    <button className={btnRun} disabled={interpreting || !!stale} onClick={interpret}>{interpreting ? "Writing…" : text ? "Write again" : "Interpret this grid"}</button>
                    {interpreting && <button className="text-xs text-gray-400 underline" onClick={() => abortRef.current?.abort()}>Stop</button>}
                    <span className="text-xs text-gray-500">Counts as one question.</span>
                  </div>
                  {interpError && <Notice tone="error">{interpError}</Notice>}
                  {text ? <ReactMarkdown remarkPlugins={[remarkGfm]} components={md}>{text}</ReactMarkdown> : !interpreting && <p className="text-sm text-gray-500">An AI reading of the variogram, cross-validation and the highest areas, from the numbers above and a picture of the grid.</p>}
                  <p className="text-[11px] text-gray-500">AI-written from the numbers above; check it against them. Not a resource estimate or investment advice.</p>
                </div>
              </section>
            )}
            {data.credits.length > 0 && <p className="text-xs text-gray-500">Data: {data.credits.join("; ")}</p>}
          </>
        )}
      </main>
    </div>
  );
}
