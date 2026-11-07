"use client";

import { useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { parseCsv, type Table } from "@/lib/dimred/math";
import {
  ELEMENTS, PRICE_UNITS, buildSegments, compositeHole, equivalentRatio, fromPpm, gxlLabel, r, toPpm, unitLabel,
  type ElDef, type HoleComposite, type Interval, type Seg,
} from "@/lib/composite";
import { Check, DataGrid, Notice, Num, Select, btn, btnGreen, card, downloadCsv, downloadSvgPng, heading, input, label } from "@/components/multivariate/ui";
import { StripLog } from "./StripLog";
import type { CollarPoint } from "./InterceptMap";

const InterceptMap = dynamic(() => import("./InterceptMap"), { ssr: false });

// Drill intercepts: browser rewrite of the old R Shiny app "Grade Width Intercepts" (OGWI). Significant intercepts are calculated from downhole
// assay intervals with a cut-off grade, a minimum width and a maximum internal dilution (length-weighted), with an optional higher-grade 'including'
// part and an optional metal equivalent. Data come from the Interzona database (Tasmania MRT, Athabasca OF 7792) or a CSV the user uploads; the
// calculation runs in the browser (the same code as the assistant's tool), so an uploaded file never leaves the computer.

type Hole = { id: string; name: string; prospect: string | null; company: string | null; lat: number | null; lon: number | null; year: number | null; intervals: Interval[]; partial: number };
type Loaded = { holes: Hole[]; el: string; el2: string | null; credits: string[]; label: string; fromDb: boolean };
type DbHole = { id: number; name: string; source: string; prospect: string | null; company: string | null; lat: number | null; lon: number | null; depth: number | null; year: number | null; assayed: number; maxGrade: number | null };

const EL_KEYS = Object.keys(ELEMENTS);
const EL_LABELS: Record<string, string> = Object.fromEntries(EL_KEYS.map((k) => [k, `${ELEMENTS[k].name} (${unitLabel(ELEMENTS[k])})`]));
const SOURCES = ["", "AUSTRALIA_TAS_MRT", "CANADA_ATHABASCA_OF7792"] as const;
const SOURCE_LABELS: Record<string, string> = { "": "Tasmania and Athabasca", AUSTRALIA_TAS_MRT: "Tasmania (Mineral Resources Tasmania)", CANADA_ATHABASCA_OF7792: "Athabasca (GSC Open File 7792)" };
const SHORT_SOURCE: Record<string, string> = { AUSTRALIA_TAS_MRT: "Tasmania", CANADA_ATHABASCA_OF7792: "Athabasca" };
const IN_UNITS = ["ppm", "g/t", "ppb", "%"] as const;
const PRICE_U = Object.keys(PRICE_UNITS);
const RANKS = ["grade_x_length", "grade", "length"] as const;
const RANK_LABELS = { grade_x_length: "grade x length", grade: "grade", length: "length" };
const MAX_HOLES = 300;

const toPpmIn = (v: number, u: string) => (u === "%" ? v * 10000 : u === "ppb" ? v / 1000 : v);
const defaultPriceUnit = (d: ElDef) => (d.unit === "g/t" ? "$/oz" : "$/lb");

export function InterceptsApp() {
  const [mode, setMode] = useState<"db" | "csv">("db");
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // database panel
  const [dbSource, setDbSource] = useState<(typeof SOURCES)[number]>("");
  const [dbEl, setDbEl] = useState("Cu");
  const [dbEl2, setDbEl2] = useState("");
  const [dbQuery, setDbQuery] = useState("");
  const [found, setFound] = useState<{ holes: DbHole[]; truncated: boolean; unit: string; el: string } | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());

  // CSV panel
  const [csv, setCsv] = useState<{ table: Table; name: string } | null>(null);
  const [map, setMap] = useState({ hole: "", from: "", to: "", grade: "", grade2: "", lat: "", lon: "", project: "" });
  const [csvEl, setCsvEl] = useState("Au");
  const [csvUnit, setCsvUnit] = useState<(typeof IN_UNITS)[number]>("g/t");
  const [csvForm, setCsvForm] = useState<"element" | "report">("element");
  const [csvEl2, setCsvEl2] = useState("Ag");
  const [csvUnit2, setCsvUnit2] = useState<(typeof IN_UNITS)[number]>("g/t");

  // settings
  const [cutoff, setCutoff] = useState(0.5);
  const [minWidth, setMinWidth] = useState(1);
  const [maxDil, setMaxDil] = useState(3);
  const [inclOn, setInclOn] = useState(false);
  const [inclCut, setInclCut] = useState(2);
  const [eqOn, setEqOn] = useState(false);
  const [p1, setP1] = useState(NaN);
  const [p1u, setP1u] = useState("$/oz");
  const [p2, setP2] = useState(NaN);
  const [p2u, setP2u] = useState("$/oz");
  const [rec1, setRec1] = useState(100);
  const [rec2, setRec2] = useState(100);
  // 'Use the latest prices': monthly averages from the database (World Bank Pink Sheet, IMF), per unit of metal.
  type Latest = { price: number; unit: string; period: string; series: string; source: string; note?: string };
  const [useLatest, setUseLatest] = useState(false);
  const [latest, setLatest] = useState<{ p1: Latest; p2: Latest } | null>(null);
  const [priceMsg, setPriceMsg] = useState("");
  const [rankBy, setRankBy] = useState<(typeof RANKS)[number]>("grade_x_length");
  const [perHole, setPerHole] = useState(true);
  const [withExceptional, setWithExceptional] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const stripRef = useRef<SVGSVGElement>(null);

  function applyLoaded(l: Loaded) {
    setLoaded(l);
    setError(null);
    const d = ELEMENTS[l.el];
    setCutoff(d.cutoff ?? 1);
    setInclCut(r((d.cutoff ?? 1) * 4));
    setP1u(defaultPriceUnit(d));
    if (l.el2) setP2u(defaultPriceUnit(ELEMENTS[l.el2]));
    setEqOn(false);
    setUseLatest(false);
    setLatest(null);
    setPriceMsg("");
    setSelected(null);
  }

  async function applyLatestPrices(on: boolean) {
    setUseLatest(on);
    setPriceMsg("");
    if (!on || !loaded?.el2) { setLatest(null); return; }
    try {
      const res = await fetch(`/api/drill/prices?elements=${encodeURIComponent(loaded.el)},${encodeURIComponent(loaded.el2)}`);
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `Prices could not be loaded (${res.status}).`);
      const a = j.prices?.[loaded.el] as Latest | null, b = j.prices?.[loaded.el2] as Latest | null;
      const missing = [!a ? ELEMENTS[loaded.el].name : "", !b ? ELEMENTS[loaded.el2].name : ""].filter(Boolean);
      if (missing.length) {
        setUseLatest(false);
        setLatest(null);
        setPriceMsg(`No monthly metal price is held for ${missing.join(" or ")} (only annual compound prices, which do not fit a metal equivalent). Enter the prices by hand.`);
        return;
      }
      setP1(a!.price); setP1u(a!.unit); setP2(b!.price); setP2u(b!.unit);
      setLatest({ p1: a!, p2: b! });
    } catch (e) {
      setUseLatest(false);
      setLatest(null);
      setPriceMsg(e instanceof Error ? e.message : String(e));
    }
  }

  async function findHoles() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/drill/holes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ element: dbEl, source: dbSource, q: dbQuery }) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `Search failed (${res.status}).`);
      setFound({ ...j, el: dbEl });
      setPicked(new Set((j.holes as DbHole[]).slice(0, 50).map((h) => h.id)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function loadPicked() {
    if (!found || !picked.size) return;
    setBusy(true);
    setError(null);
    try {
      const ids = [...picked].slice(0, MAX_HOLES);
      const res = await fetch("/api/drill/intervals", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ holes: ids, element: found.el, secondary: dbEl2 || undefined }) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `Loading failed (${res.status}).`);
      const byId = new Map(found.holes.map((h) => [h.id, h]));
      const holes = new Map<number, Hole>();
      for (const [hid, f, t, g, g2, flags] of j.intervals as [number, number, number | null, number | null, number | null, number][]) {
        const info = byId.get(hid);
        if (!holes.has(hid)) holes.set(hid, { id: String(hid), name: info?.name ?? String(hid), prospect: info?.prospect ?? null, company: info?.company ?? null, lat: info?.lat ?? null, lon: info?.lon ?? null, year: info?.year ?? null, intervals: [], partial: 0 });
        const h = holes.get(hid)!;
        h.intervals.push({ from: f, to: t == null ? NaN : t, g, g2, bdl: Boolean(flags & 1), bdl2: Boolean(flags & 2) });
        if (flags & 4) h.partial++;
      }
      applyLoaded({ holes: [...holes.values()], el: found.el, el2: dbEl2 || null, credits: j.credits ?? [], label: `${holes.size} holes from ${(j.sources ?? []).join(" and ")}`, fromDb: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function upload(f: File | undefined) {
    if (!f) return;
    if (f.size > 50 * 1024 * 1024) { setError("That file is over 50 MB; please upload a subset."); return; }
    try {
      const table = parseCsv(await f.text());
      setCsv({ table, name: f.name });
      const find = (re: RegExp, numeric?: boolean) => table.columns.find((c, j) => re.test(c.trim()) && (numeric === undefined || table.numeric[j] === numeric)) ?? "";
      setMap({
        hole: find(/^(hole_?id|holeid|hole|bhid|dhid|hole ?name)$/i),
        from: find(/^(from|sampfrom|depth_?from|from_?m|mfrom)$/i, true),
        to: find(/^(to|sampto|depth_?to|to_?m|mto)$/i, true),
        grade: "", grade2: "",
        lat: find(/^(lat|latitude)$/i, true),
        lon: find(/^(lon|long|lng|longitude)$/i, true),
        project: find(/^(project|projectcode|prospect)$/i),
      });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function applyCsv() {
    if (!csv) return;
    const t = csv.table;
    const col = (name: string) => t.columns.indexOf(name);
    const [ih, iF, iT, iG, iG2, iLat, iLon, iP] = [map.hole, map.from, map.to, map.grade, map.grade2, map.lat, map.lon, map.project].map((c) => (c ? col(c) : -1));
    if (ih < 0 || iF < 0 || iT < 0 || iG < 0) { setError("Choose the hole, from, to and grade columns."); return; }
    const d = ELEMENTS[csvEl];
    const formFactor = csvForm === "report" ? 1 / d.toReport : 1; // reporting form (e.g. Li2O) -> element
    const holes = new Map<string, Hole>();
    t.rows.forEach((row, i) => {
      const hid = String(row[ih] ?? "").trim();
      if (!hid) return;
      if (!holes.has(hid)) {
        const num = (k: number) => (k >= 0 && typeof row[k] === "number" ? (row[k] as number) : null);
        holes.set(hid, { id: hid, name: hid, prospect: iP >= 0 ? (String(row[iP] ?? "") || null) : null, company: null, lat: num(iLat), lon: num(iLon), year: null, intervals: [], partial: 0 });
      }
      const val = (k: number, unit: string, factor: number) => {
        if (k < 0) return { g: null, bdl: false };
        const v = row[k];
        if (typeof v !== "number") return { g: null, bdl: false };
        if (t.lt[k].has(i) || v < 0) return { g: 0, bdl: true };
        return { g: toPpmIn(v, unit) * factor, bdl: false };
      };
      const a = val(iG, csvUnit, formFactor);
      const b = val(iG2, csvUnit2, 1);
      holes.get(hid)!.intervals.push({ from: Number(row[iF]), to: Number(row[iT]), g: a.g, bdl: a.bdl, g2: b.g, bdl2: b.bdl });
    });
    applyLoaded({ holes: [...holes.values()], el: csvEl, el2: iG2 >= 0 ? csvEl2 : null, credits: [], label: `${holes.size} holes from ${csv.name}`, fromDb: false });
  }

  // ---------- calculation (instant, in the browser) ----------
  const d = loaded ? ELEMENTS[loaded.el] : null;
  const d2 = loaded?.el2 ? ELEMENTS[loaded.el2] : null;
  const ratio = eqOn && d2 && p1 > 0 && p2 > 0 && rec1 > 0 ? equivalentRatio(p1, p1u, rec1, p2, p2u, rec2) : undefined;
  const eqLabel = ratio && d && d2 ? `${d.reportAs} + ${d2.reportAs} at ${p2} ${p2u} (${rec2}% rec.) vs ${p1} ${p1u} (${rec1}% rec.)` : "";

  const calc = useMemo(() => {
    if (!loaded || !d || !(cutoff > 0)) return null;
    const cutPpm = toPpm(d, cutoff);
    const inclPpm = inclOn && inclCut > cutoff ? toPpm(d, inclCut) : undefined;
    let overlaps = 0, impossible = 0, points = 0;
    const perHoleData = new Map<string, { segs: Seg[]; comps: HoleComposite[] }>();
    type Row = HoleComposite & { hole: Hole; exceptional: boolean };
    const rows: Row[] = [];
    const leftOut: Row[] = [];
    for (const h of loaded.holes) {
      const b = buildSegments(h.intervals, 1e6 / Math.max(d.toReport, 1));
      overlaps += b.overlaps; impossible += b.impossible; points += b.pointSamples;
      const comps = compositeHole(b.segs, { cutPpm, minWidth: Math.max(minWidth || 0, 0), maxDil: Math.max(maxDil || 0, 0), inclPpm, ratio });
      perHoleData.set(h.id, { segs: b.segs, comps });
      for (const c of comps) {
        const exceptional = fromPpm(d, c.maxSample) > d.exceptional || (ratio && d2 ? fromPpm(d2, c.maxSample2) > d2.exceptional : false);
        (exceptional && !withExceptional ? leftOut : rows).push({ ...c, hole: h, exceptional });
      }
    }
    const metric = (x: Row) => (rankBy === "grade" ? x.eq : rankBy === "length" ? x.len : x.eq * x.len);
    let ranked = rows.sort((a, b) => metric(b) - metric(a));
    const holesHit = new Set(ranked.map((x) => x.hole.id)).size;
    if (perHole) {
      const seen = new Set<string>();
      ranked = ranked.filter((x) => (seen.has(x.hole.id) ? false : (seen.add(x.hole.id), true)));
    }
    return { ranked, leftOut, overlaps, impossible, points, holesHit, perHoleData, total: rows.length };
  }, [loaded, d, d2, cutoff, minWidth, maxDil, inclOn, inclCut, ratio, rankBy, perHole, withExceptional]);

  const u = d ? unitLabel(d) + (ratio ? " eq." : "") : "";
  const columns = d
    ? ["Rank", "Hole", "Prospect / deposit", "From (m)", "To (m)", "Length (m)", `Grade (${unitLabel(d)})`, ...(ratio && d2 ? [`${d2.reportAs} (${unitLabel(d2)})`, `${d.reportAs} eq. (${unitLabel(d)})`] : []),
       gxlLabel(d) + (ratio ? " (eq.)" : ""), "Including", "Samples", "Low-grade core inside (m)", "Unassayed inside (m)", "Highest sample", "Check"]
    : [];
  const tableRows = calc && d
    ? calc.ranked.map((x, i) => [
        i + 1, x.hole.name, x.hole.prospect, r(x.from, 1), r(x.to, 1), r(x.len, 1), r(fromPpm(d, x.grade)),
        ...(ratio && d2 ? [r(fromPpm(d2, x.grade2)), r(fromPpm(d, x.eq))] : []),
        r(fromPpm(d, x.eq) * x.len), x.incl ? `${r(x.incl.len, 1)} m at ${r(fromPpm(d, x.incl.eq))} from ${r(x.incl.from, 1)} m` : "",
        x.nSamples, r(x.dilutionM, 1), r(x.unassayedM, 1), r(fromPpm(d, x.maxSample)), x.exceptional ? "exceptional assay inside" : "",
      ])
    : [];

  const selHole = loaded && selected ? loaded.holes.find((h) => h.id === selected) : loaded && calc?.ranked[0] ? calc.ranked[0].hole : null;
  const selData = selHole && calc ? calc.perHoleData.get(selHole.id) : null;

  const collars: CollarPoint[] = useMemo(() => {
    if (!loaded || !calc || !d) return [];
    const best = new Map<string, number>();
    for (const x of calc.ranked) best.set(x.hole.id, Math.max(best.get(x.hole.id) ?? 0, x.eq * x.len));
    const max = Math.max(1e-9, ...best.values());
    return loaded.holes
      .filter((h) => h.lat != null && h.lon != null && Number.isFinite(h.lat) && Number.isFinite(h.lon))
      .map((h) => {
        const top = calc.ranked.find((x) => x.hole.id === h.id);
        return {
          id: h.id, lat: h.lat!, lon: h.lon!, hit: best.has(h.id), size: Math.sqrt((best.get(h.id) ?? 0) / max), selected: h.id === selHole?.id,
          label: top ? `${h.name}: ${r(top.len, 1)} m at ${r(fromPpm(d, top.eq))} ${u} from ${r(top.from, 1)} m` : `${h.name}: no intercept at this cut-off`,
        };
      });
  }, [loaded, calc, d, u, selHole?.id]);

  const credits = loaded?.credits ?? [];
  const csvCols = csv?.table.columns ?? [];
  const numCols = csv ? csv.table.columns.filter((_, j) => csv.table.numeric[j]) : [];
  const stem = loaded ? `intercepts_${loaded.el}${ratio ? "eq" : ""}_${cutoff}` : "intercepts";

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <header className="flex items-center gap-3 border-b border-gray-800 px-4 py-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/interzona-mark.png" alt="Interzona" width={40} height={40} className="h-10 w-10 shrink-0 select-none" />
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold leading-tight">Drill intercepts</h1>
          <p className="text-xs text-gray-400">Significant intercepts from downhole assays: cut-off grade, minimum width, internal dilution, &quot;including&quot; and metal equivalent. It calculates in your browser; an uploaded file is not sent to the server.</p>
        </div>
        <Link href="/tools/multivariate" className="hidden shrink-0 text-xs text-gray-300 underline sm:block">Multivariate tools</Link>
        <Link href="/" className="shrink-0 text-xs text-gray-300 underline">← Assistant</Link>
      </header>

      <main className="space-y-4 p-4">
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          {/* ---------- data ---------- */}
          <div className={`${card} space-y-3`}>
            <div className="flex items-center gap-2">
              <h3 className={`${heading} flex-1`}>Data</h3>
              {(["db", "csv"] as const).map((m) => (
                <button key={m} className={`${btn} ${mode === m ? "bg-emerald-700 text-white" : "bg-gray-800 text-gray-300 hover:bg-gray-700"}`} onClick={() => setMode(m)}>
                  {m === "db" ? "Interzona database" : "Your CSV"}
                </button>
              ))}
            </div>

            {mode === "db" ? (
              <div className="space-y-3">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <Select name="Drill holes from" value={dbSource} set={setDbSource} options={SOURCES} labels={SOURCE_LABELS} />
                  <Select name="Element" value={dbEl} set={setDbEl} options={EL_KEYS} labels={EL_LABELS} />
                  <Select name="Second metal (for an equivalent)" value={dbEl2} set={setDbEl2} options={["", ...EL_KEYS.filter((k) => k !== dbEl)]} labels={{ "": "None", ...EL_LABELS }} />
                </div>
                <div className="flex items-end gap-2">
                  <label className="block flex-1">
                    <span className={label}>Hole, prospect, deposit or company name (optional)</span>
                    <input className={input} value={dbQuery} placeholder="e.g. Renison, Hellyer, Q8-, Cameco" onChange={(e) => setDbQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && findHoles()} />
                  </label>
                  <button className={btnGreen} disabled={busy} onClick={findHoles}>Find holes</button>
                </div>
                <p className="text-[11px] text-gray-500">
                  Only Tasmania and Athabasca holes have assays with from-to depths. Québec holes have reported intercepts only; ask the assistant for those.
                </p>
                {found && (
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-gray-300">
                      <span>{found.holes.length}{found.truncated ? "+" : ""} holes with {ELEMENTS[found.el].name} assays, highest single assay first. {picked.size} chosen.</span>
                      <button className="underline" onClick={() => setPicked(new Set(found.holes.slice(0, 50).map((h) => h.id)))}>top 50</button>
                      <button className="underline" onClick={() => setPicked(new Set(found.holes.slice(0, MAX_HOLES).map((h) => h.id)))}>all (max {MAX_HOLES})</button>
                      <button className="underline" onClick={() => setPicked(new Set())}>none</button>
                    </div>
                    <div className="max-h-64 overflow-auto rounded border border-gray-800">
                      <table className="min-w-full text-xs">
                        <thead className="sticky top-0 bg-gray-900 text-left text-gray-300">
                          <tr><th className="px-2 py-1"></th><th className="px-2 py-1">Hole</th><th className="px-2 py-1">Prospect / deposit</th><th className="px-2 py-1">Company</th><th className="px-2 py-1">Year</th><th className="px-2 py-1">Assays</th><th className="px-2 py-1">Highest ({found.unit})</th><th className="px-2 py-1">Source</th></tr>
                        </thead>
                        <tbody>
                          {found.holes.map((h) => (
                            <tr key={h.id} className="border-t border-gray-800/70 text-gray-200">
                              <td className="px-2 py-0.5"><input type="checkbox" className="accent-emerald-500" checked={picked.has(h.id)} onChange={(e) => { const s = new Set(picked); if (e.target.checked) s.add(h.id); else s.delete(h.id); setPicked(s); }} /></td>
                              <td className="whitespace-nowrap px-2 py-0.5">{h.name}</td>
                              <td className="px-2 py-0.5">{h.prospect}</td>
                              <td className="px-2 py-0.5">{h.company}</td>
                              <td className="px-2 py-0.5">{h.year}</td>
                              <td className="px-2 py-0.5">{h.assayed}</td>
                              <td className="px-2 py-0.5">{h.maxGrade == null ? "" : r(h.maxGrade)}</td>
                              <td className="px-2 py-0.5">{SHORT_SOURCE[h.source] ?? h.source}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <button className={btnGreen} disabled={busy || !picked.size} onClick={loadPicked}>Load assays for {Math.min(picked.size, MAX_HOLES)} hole{picked.size === 1 ? "" : "s"}</button>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                <label className="block">
                  <span className={label}>Upload a CSV of assay intervals (one row per sample: hole, from, to, grade)</span>
                  <input type="file" accept=".csv,text/csv" className="block w-full text-sm text-gray-300 file:mr-3 file:rounded file:border-0 file:bg-gray-700 file:px-3 file:py-1.5 file:text-sm file:text-white" onChange={(e) => upload(e.target.files?.[0])} />
                </label>
                {csv && (
                  <>
                    <p className="font-mono text-xs text-gray-400">{csv.name}: {csv.table.rows.length.toLocaleString()} rows, {csv.table.columns.length} columns</p>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                      <Select name="Hole ID" value={map.hole} set={(v) => setMap({ ...map, hole: v })} options={["", ...csvCols]} labels={{ "": "Choose…" }} />
                      <Select name="From (m)" value={map.from} set={(v) => setMap({ ...map, from: v })} options={["", ...numCols]} labels={{ "": "Choose…" }} />
                      <Select name="To (m)" value={map.to} set={(v) => setMap({ ...map, to: v })} options={["", ...numCols]} labels={{ "": "Choose…" }} />
                      <Select name="Project (optional)" value={map.project} set={(v) => setMap({ ...map, project: v })} options={["", ...csvCols]} labels={{ "": "None" }} />
                    </div>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                      <Select name="Grade column" value={map.grade} set={(v) => setMap({ ...map, grade: v })} options={["", ...numCols]} labels={{ "": "Choose…" }} />
                      <Select name="Element" value={csvEl} set={setCsvEl} options={EL_KEYS} labels={EL_LABELS} />
                      <Select name="Its unit" value={csvUnit} set={setCsvUnit} options={IN_UNITS} />
                      <Select name="Column holds" value={csvForm} set={setCsvForm} options={["element", "report"] as const}
                        labels={{ element: `${csvEl} (element)`, report: ELEMENTS[csvEl].reportAs === csvEl ? `${csvEl} (element)` : ELEMENTS[csvEl].reportAs }} />
                    </div>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                      <Select name="Second metal column (optional)" value={map.grade2} set={(v) => setMap({ ...map, grade2: v })} options={["", ...numCols]} labels={{ "": "None" }} />
                      <Select name="Second metal" value={csvEl2} set={setCsvEl2} options={EL_KEYS.filter((k) => k !== csvEl)} labels={EL_LABELS} />
                      <Select name="Its unit" value={csvUnit2} set={setCsvUnit2} options={IN_UNITS} />
                      <div />
                    </div>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                      <Select name="Collar latitude (optional)" value={map.lat} set={(v) => setMap({ ...map, lat: v })} options={["", ...numCols]} labels={{ "": "None" }} />
                      <Select name="Collar longitude (optional)" value={map.lon} set={(v) => setMap({ ...map, lon: v })} options={["", ...numCols]} labels={{ "": "None" }} />
                    </div>
                    <p className="text-[11px] text-gray-500">Values written &quot;&lt;x&quot; or negative (a common below-detection convention) count as zero; blank cells as not assayed. Latitude and longitude in decimal degrees; the first value per hole is used.</p>
                    <button className={btnGreen} onClick={applyCsv}>Use this file</button>
                  </>
                )}
              </div>
            )}
            {busy && <p className="text-xs text-gray-400">Working…</p>}
            {error && <p className="text-xs text-red-400">{error}</p>}
            {loaded && <p className="rounded bg-gray-950 px-2 py-1 font-mono text-xs text-gray-300">Loaded: {loaded.label}, {loaded.holes.reduce((a, h) => a + h.intervals.length, 0).toLocaleString()} intervals ({ELEMENTS[loaded.el].name}{loaded.el2 ? ` + ${ELEMENTS[loaded.el2].name}` : ""})</p>}
            {credits.length > 0 && <p className="text-[11px] text-gray-500">Data: {credits.join("; ")}. Credits are added to every download.</p>}
          </div>

          {/* ---------- settings ---------- */}
          <div className={`${card} space-y-3`}>
            <h3 className={heading}>Settings</h3>
            {!loaded || !d ? (
              <p className="text-xs text-gray-500">Load assays to set the cut-off and see intercepts. They update as you change any setting.</p>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  <Num name={`Cut-off (${u})`} value={cutoff} set={setCutoff} step={0.1} min={0} />
                  <Num name="Minimum width (m)" value={minWidth} set={setMinWidth} step={0.5} min={0} />
                  <Num name="Max internal dilution (m)" value={maxDil} set={setMaxDil} step={0.5} min={0} />
                </div>
                <p className="text-[11px] text-gray-500">The dilution limit applies to each continuous run of below-cut-off or unsampled core; the whole intercept must still average at least the cut-off.</p>
                <div className="flex flex-wrap items-end gap-3">
                  <Check name="Report an 'including' part" value={inclOn} set={(v) => { setInclOn(v); if (v && !(inclCut > cutoff)) setInclCut(r(cutoff * 4)); }} />
                  {inclOn && <div className="w-40"><Num name={`Including cut-off (${u})`} value={inclCut} set={setInclCut} step={0.5} min={0} /></div>}
                </div>
                {inclOn && !(inclCut > cutoff) && <p className="text-[11px] text-amber-300">The including cut-off must be above the main cut-off ({cutoff}).</p>}
                {d2 && (
                  <div className="space-y-2 rounded border border-gray-800 p-2">
                    <Check name={`${d.reportAs} equivalent with ${d2.name}`} value={eqOn} set={setEqOn} />
                    {eqOn && <Check name="Use the latest monthly prices for both metals" value={useLatest} set={applyLatestPrices} />}
                    {eqOn && priceMsg && <p className="text-[11px] text-amber-300">{priceMsg}</p>}
                    {eqOn && useLatest && latest && (
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                        <p className="col-span-2 text-xs text-gray-300">
                          {d.reportAs}: US{latest.p1.unit} {latest.p1.price.toLocaleString()} ({latest.p1.period}){latest.p1.note ? `, ${latest.p1.note}` : ""}
                          <br />
                          {d2.reportAs}: US{latest.p2.unit} {latest.p2.price.toLocaleString()} ({latest.p2.period}){latest.p2.note ? `, ${latest.p2.note}` : ""}
                          <br />
                          <span className="text-[11px] text-gray-500">{[...new Set([latest.p1.source, latest.p2.source])].join("; ")}. Untick to type your own prices.</span>
                        </p>
                        <div className="space-y-2">
                          <Num name={`${d.reportAs} recovery (%)`} value={rec1} set={setRec1} min={1} max={100} />
                          <Num name={`${d2.reportAs} recovery (%)`} value={rec2} set={setRec2} min={0} max={100} />
                        </div>
                      </div>
                    )}
                    {eqOn && !useLatest && (
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                        <Num name={`${d.reportAs} price`} value={p1} set={setP1} min={0} />
                        <Select name="per" value={p1u} set={setP1u} options={PRICE_U} />
                        <Num name={`${d.reportAs} recovery (%)`} value={rec1} set={setRec1} min={1} max={100} />
                        <Num name={`${d2.reportAs} price`} value={p2} set={setP2} min={0} />
                        <Select name="per" value={p2u} set={setP2u} options={PRICE_U} />
                        <Num name={`${d2.reportAs} recovery (%)`} value={rec2} set={setRec2} min={0} max={100} />
                      </div>
                    )}
                    {eqOn && !ratio && <p className="text-[11px] text-amber-300">Enter both prices to use the equivalent.</p>}
                    {ratio && <p className="text-[11px] text-gray-400">Prices are per unit of metal. 1 {unitLabel(d2)} counts as {r(fromPpm(d, toPpm(d2, 1) * ratio))} {unitLabel(d)}. An equivalent compares value only: no metallurgy, payability or costs.</p>}
                  </div>
                )}
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  <Select name="Rank by" value={rankBy} set={setRankBy} options={RANKS} labels={RANK_LABELS} />
                  <div className="space-y-1 pt-4">
                    <Check name="Best intercept per hole" value={perHole} set={setPerHole} />
                    <Check name={`Include exceptional assays (> ${d.exceptional} ${unitLabel(d)})`} value={withExceptional} set={setWithExceptional} />
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        {/* ---------- results ---------- */}
        {calc && d && loaded && (
          <>
            <div className={`${card} space-y-2`}>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className={`${heading} flex-1`}>Intercepts at {cutoff} {u}, min {minWidth} m, max {maxDil} m dilution</h3>
                <button className={`${btn} bg-gray-700 text-white hover:bg-gray-600`} onClick={() => downloadCsv(`${stem}.csv`, columns, tableRows, credits)}>Download intercepts</button>
                <button className={`${btn} bg-gray-700 text-white hover:bg-gray-600`} onClick={() => downloadIntervals(loaded, d, d2, credits)}>Download intervals</button>
              </div>
              <p className="text-xs text-gray-300">
                {calc.holesHit} of {loaded.holes.length} holes have an intercept ({calc.total} intercepts{perHole ? `; the best per hole is shown, ranked by ${RANK_LABELS[rankBy]}` : ""}).
                {calc.overlaps > 0 && ` ${calc.overlaps} overlapping intervals skipped (no metre counted twice).`}
                {calc.points > 0 && ` ${calc.points} intervals without a length skipped.`}
                {calc.impossible > 0 && ` ${calc.impossible} impossible assays (over 100 %) set to zero.`}
              </p>
              {calc.leftOut.length > 0 && (
                <Notice tone="warn">
                  {calc.leftOut.length} intercept{calc.leftOut.length === 1 ? "" : "s"} left out because {calc.leftOut.length === 1 ? "it contains" : "they contain"} an exceptional assay (usually a unit or typing error in the source, occasionally real):{" "}
                  {calc.leftOut.slice(0, 5).map((x) => `${x.hole.name} ${r(x.len, 1)} m at ${r(fromPpm(d, x.eq))} from ${r(x.from, 1)} m`).join("; ")}
                  {calc.leftOut.length > 5 ? "; …" : ""}. Tick &quot;Include exceptional assays&quot; to rank them.
                </Notice>
              )}
              {calc.ranked.length ? (
                <div className="max-h-[420px] overflow-auto rounded border border-gray-800">
                  <table className="min-w-full text-xs">
                    <thead className="sticky top-0 bg-gray-900"><tr>{columns.map((c) => <th key={c} className="whitespace-nowrap px-2 py-1.5 text-left font-semibold text-gray-300">{c}</th>)}</tr></thead>
                    <tbody>
                      {tableRows.slice(0, 300).map((row, i) => {
                        const hid = calc.ranked[i].hole.id;
                        return (
                          <tr key={i} onClick={() => setSelected(hid)} className={`cursor-pointer border-t border-gray-800/70 ${hid === selHole?.id ? "bg-emerald-950/60" : "hover:bg-gray-800/50"}`}>
                            {row.map((v, j) => <td key={j} className="whitespace-nowrap px-2 py-1 text-gray-200">{v === null ? "" : String(v)}</td>)}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Notice>No intercepts at this cut-off. Lower the cut-off or the minimum width, or allow more dilution.</Notice>
              )}
              {tableRows.length > 300 && <p className="text-xs text-gray-500">Showing the first 300 of {tableRows.length}; the download includes every row.</p>}
              <p className="text-[11px] text-gray-500">Click a row (or a collar on the map) to see that hole&apos;s strip log. Lengths are downhole, not true widths. Below-detection and unsampled core count as zero grade.</p>
            </div>

            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              <div className={`${card} space-y-2`}>
                <div className="flex items-center gap-2">
                  <h3 className={`${heading} flex-1`}>Strip log</h3>
                  <select className={`${input} w-48`} value={selHole?.id ?? ""} onChange={(e) => setSelected(e.target.value)}>
                    {loaded.holes.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
                  </select>
                  <button className={`${btn} bg-gray-700 text-white hover:bg-gray-600`} disabled={!selData} onClick={() => downloadSvgPng(stripRef.current, `striplog_${selHole?.name ?? "hole"}.png`)}>PNG</button>
                </div>
                {selHole && selData ? (
                  <>
                    <p className="text-xs text-gray-400">{[selHole.prospect, selHole.company, selHole.year].filter(Boolean).join(" · ")}{selHole.partial ? ` · ${selHole.partial} assays by partial digestion` : ""}</p>
                    <StripLog ref={stripRef} hole={selHole.name} segs={selData.segs} comps={selData.comps} d={d} cutPpm={toPpm(d, cutoff)} ratio={ratio} eqLabel={eqLabel} credit={credits.length ? `Data: ${credits.join("; ")}` : undefined} />
                  </>
                ) : (
                  <p className="text-xs text-gray-500">Choose a hole.</p>
                )}
              </div>
              <div className={`${card} space-y-2`}>
                <h3 className={heading}>Collars</h3>
                {collars.length ? (
                  <>
                    <InterceptMap points={collars} onSelect={setSelected} />
                    <p className="text-[11px] text-gray-500">Orange = hole with an intercept, sized by its best grade x length; grey = none at this cut-off. Collar positions only (no downhole traces).</p>
                  </>
                ) : (
                  <Notice>No collar positions{loaded.fromDb ? "" : ": choose latitude and longitude columns to see a map"}.</Notice>
                )}
              </div>
            </div>
          </>
        )}

        {!loaded && (
          <div className={card}>
            <DataGrid columns={["What it does"]} raw={false} rows={[
              ["Finds the intervals at or above the cut-off grade in each hole and joins them across low-grade or unsampled core, up to the dilution limit, as long as the whole intercept still averages the cut-off."],
              ["Drops intercepts shorter than the minimum width; grades are length-weighted; an optional higher cut-off reports the best 'including' part."],
              ["Optional metal equivalent from two prices and recoveries (for example gold with silver). Exceptional assays are held back for checking."],
              ["Same method as the assistant's drill-intercept answers and the earlier Grade Width Intercepts app."],
            ]} />
          </div>
        )}
        <p className="text-[11px] text-gray-500">Do not use these results in public reporting without independent verification and validation. They are calculated from compiled assays, not company-reported intercepts or resource estimates.</p>
      </main>
    </div>
  );
}

function downloadIntervals(l: Loaded, d: ElDef, d2: ElDef | null, credits: string[]) {
  const cols = ["Hole", "Prospect", "From (m)", "To (m)", `${d.reportAs} (${unitLabel(d)})`, `${d.reportAs} below detection`, ...(d2 ? [`${d2.reportAs} (${unitLabel(d2)})`, `${d2.reportAs} below detection`] : []), "Latitude", "Longitude"];
  const rows = l.holes.flatMap((h) =>
    h.intervals.map((x) => [
      h.name, h.prospect, x.from, Number.isFinite(x.to) ? x.to : null, x.g == null ? null : r(fromPpm(d, x.g), 4), x.bdl ? "yes" : "",
      ...(d2 ? [x.g2 == null ? null : r(fromPpm(d2, x.g2), 4), x.bdl2 ? "yes" : ""] : []), h.lat, h.lon,
    ]),
  );
  downloadCsv(`intervals_${d.reportAs}.csv`, cols, rows, credits);
}
