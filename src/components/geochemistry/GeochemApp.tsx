"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Options } from "@/lib/geochem-extract";
import {
  MAX_METHODS_PER_RUN, METHODS, METHOD_GROUPS, MIN_USABLE_SAMPLES, SAMPLE_LIMITS, datasetName, isRockSampleType, type Selection,
} from "@/lib/geochem-methods";
import { Check, Notice, btnGreen, btnRun, card, heading, input, label } from "@/components/multivariate/ui";

// Geochemistry page (/tools/geochemistry): choose samples from the database, choose standard diagrams and indices, run them, and get a written
// interpretation of the results. Charts come from the vetted analytics scripts (src/lib/sandbox.ts); the interpretation from the model, given
// each chart and its numbers (src/app/api/geochem/analyse/route.ts).

type Result = { id: string; label: string; image?: string; summary?: string; error?: string };
const pct = (n: number, d: number) => (d > 0 ? Math.round((100 * n) / d) : 0);

const md = {
  h2: (p: { children?: React.ReactNode }) => <h2 className="mt-4 mb-1 text-sm font-semibold text-emerald-300 first:mt-0">{p.children}</h2>,
  h3: (p: { children?: React.ReactNode }) => <h3 className="mt-3 mb-1 text-sm font-semibold text-gray-200">{p.children}</h3>,
  p: (p: { children?: React.ReactNode }) => <p className="mb-2 text-sm leading-relaxed text-gray-200">{p.children}</p>,
  ul: (p: { children?: React.ReactNode }) => <ul className="mb-2 list-disc space-y-1 pl-5 text-sm text-gray-200">{p.children}</ul>,
  ol: (p: { children?: React.ReactNode }) => <ol className="mb-2 list-decimal space-y-1 pl-5 text-sm text-gray-200">{p.children}</ol>,
  strong: (p: { children?: React.ReactNode }) => <strong className="font-semibold text-gray-50">{p.children}</strong>,
};

export function GeochemApp() {
  const [options, setOptions] = useState<Options | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [groups, setGroups] = useState<Set<string>>(new Set());
  const [lith, setLith] = useState<Set<string>>(new Set());
  const [useBox, setUseBox] = useState(false);
  const [box, setBox] = useState({ w: "", s: "", e: "", n: "" });
  const [limit, setLimit] = useState<number>(1000);
  const [selecting, setSelecting] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<Result[]>([]);
  const [pending, setPending] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [credits, setCredits] = useState<string[]>([]);
  const [runError, setRunError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

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
  const chosenGroups = useMemo(() => options?.groups.filter((g) => groups.has(key(g.source, g.sampleType))) ?? [], [options, groups]);
  const groupTotal = chosenGroups.reduce((a, g) => a + g.n, 0);

  function toggle<T>(set: Set<T>, v: T) {
    const n = new Set(set);
    if (n.has(v)) n.delete(v); else n.add(v);
    return n;
  }
  function toggleSource(source: string, list: Options["groups"]) {
    const keys = list.map((g) => key(source, g.sampleType));
    const allOn = keys.every((k) => groups.has(k));
    const next = new Set(groups);
    keys.forEach((k) => (allOn ? next.delete(k) : next.add(k)));
    setGroups(next);
  }

  async function select() {
    const bbox = useBox ? [box.w, box.s, box.e, box.n].map(Number) : null;
    if (bbox && bbox.some((v) => !Number.isFinite(v))) { setError("Fill in all four edges of the area, in decimal degrees."); return; }
    setSelecting(true);
    setError(null);
    try {
      const res = await fetch("/api/geochem/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groups: chosenGroups.map((g) => ({ source: g.source, sampleType: g.sampleType })), lithologyCategories: [...lith], bbox, limit, seed: Math.floor(Math.random() * 1e9) }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "The samples could not be selected.");
      const s = j as Selection;
      if (s.ids.length === 0) throw new Error("No samples in that selection have the elements these analyses need. Try other datasets or a wider area.");
      setSelection(s);
      setChosen((c) => c.filter((id) => (s.usable[id] ?? 0) >= MIN_USABLE_SAMPLES));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSelecting(false);
    }
  }

  async function run() {
    if (!selection || chosen.length === 0) return;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setRunning(true);
    setRunError(null);
    setResults([]);
    setText("");
    setCredits(selection.credits);
    setPending(chosen);
    try {
      const res = await fetch("/api/geochem/analyse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: selection.ids, methods: chosen }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        throw new Error((j as { error?: string }).error ?? "The analysis could not start.");
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
          if (e.type === "meta" && Array.isArray(e.credits)) setCredits(e.credits as string[]);
          else if (e.type === "result" || e.type === "failed") {
            const r: Result = { id: String(e.id), label: String(e.label), image: e.image as string | undefined, summary: e.summary as string | undefined, error: e.type === "failed" ? String(e.message) : undefined };
            setResults((prev) => [...prev, r].sort((a, b) => chosen.indexOf(a.id) - chosen.indexOf(b.id)));
            setPending((p) => p.filter((id) => id !== r.id));
          } else if (e.type === "text") setText((t) => t + String(e.text));
          else if (e.type === "error") setRunError(String(e.message));
        }
      }
    } catch (e) {
      if (!ac.signal.aborted) setRunError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
      setPending([]);
    }
  }

  function toggleMethod(id: string) {
    setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : c.length >= MAX_METHODS_PER_RUN ? c : [...c, id]));
  }

  const n = selection?.ids.length ?? 0;
  const nonRockShare = selection ? pct(selection.nonRock, n) : 0;
  const chartsDone = results.filter((r) => r.image).length;

  return (
    <div className="min-h-dvh bg-gray-950 text-gray-100">
      <header className="flex flex-wrap items-center gap-3 border-b border-gray-800 px-4 py-3 print:hidden">
        <Link href="/" className="text-sm text-gray-400 hover:text-gray-200">← Assistant</Link>
        <h1 className="text-lg font-semibold">Geochemistry</h1>
        <p className="text-xs text-gray-400">Choose samples, choose diagrams and indices, and get an interpretation. Classification diagrams assume fresh igneous rocks.</p>
        <div className="ml-auto flex gap-3 text-xs">
          <Link href="/tools/multivariate" className="text-emerald-300 hover:underline">Multivariate tools</Link>
          <Link href="/tools/intercepts" className="text-orange-300 hover:underline">Drill intercepts</Link>
          <Link href="/tools/geostatistics" className="text-violet-300 hover:underline">Geostatistics</Link>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-4 p-4">
        {/* Step 1: samples */}
        <section className={`${card} space-y-4 print:hidden`}>
          <h2 className={heading}>1. Samples</h2>
          {error && <Notice tone="error">{error}</Notice>}
          {!options ? (
            !error && <p className="text-sm text-gray-400">Loading what the database holds…</p>
          ) : (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <div className="space-y-2">
                <span className={label}>Datasets and sample types</span>
                <div className="max-h-80 space-y-2 overflow-auto pr-1">
                  {bySource.map(([source, list]) => (
                    <div key={source} className="rounded border border-gray-800 p-2">
                      <button className="text-left text-sm font-medium text-gray-100 hover:underline" onClick={() => toggleSource(source, list)}>
                        {datasetName(source)} <span className="text-xs font-normal text-gray-500">({list.reduce((a, g) => a + g.n, 0).toLocaleString()})</span>
                      </button>
                      <div className="mt-1 space-y-0.5">
                        {list.map((g) => (
                          <label key={g.sampleType} className="flex items-center gap-2 text-xs text-gray-300">
                            <input type="checkbox" className="accent-emerald-500" checked={groups.has(key(source, g.sampleType))} onChange={() => setGroups(toggle(groups, key(source, g.sampleType)))} />
                            {g.sampleType} <span className="text-gray-500">{g.n.toLocaleString()}</span>
                            {!isRockSampleType(g.sampleType) && <span className="text-[10px] text-amber-400/80">not rock</span>}
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="space-y-3">
                <div>
                  <span className={label}>Lithology (optional; mostly recorded for rock samples)</span>
                  <div className="flex flex-wrap gap-1.5">
                    {options.lithologyCategories.map((c) => {
                      const on = lith.has(c);
                      return (
                        <button key={c} onClick={() => setLith(toggle(lith, c))} className={`rounded-full border px-2 py-0.5 text-[11px] ${on ? "border-emerald-500 bg-emerald-900/50 text-emerald-100" : "border-gray-700 text-gray-400 hover:text-gray-200"}`}>
                          {c.replace(/_/g, " ").toLowerCase()}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div className="space-y-2">
                  <Check name="Limit to an area (decimal degrees)" value={useBox} set={setUseBox} />
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
                <label className="block">
                  <span className={label}>Maximum samples (a random draw when more match)</span>
                  <select className={input} value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
                    {SAMPLE_LIMITS.map((v) => <option key={v} value={v}>{v.toLocaleString()}</option>)}
                  </select>
                </label>
                <button className={btnGreen} disabled={selecting || chosenGroups.length === 0} onClick={select}>
                  {selecting ? "Selecting…" : selection ? "Select again" : "Select samples"}
                </button>
                {groupTotal > 0 && !selection && <p className="text-xs text-gray-500">{groupTotal.toLocaleString()} samples in the chosen datasets before the lithology and area filters.</p>}
              </div>
              <div className="space-y-2 text-xs text-gray-300">
                <span className={label}>Selection</span>
                {!selection ? (
                  <p className="text-gray-500">Choose datasets and sample types, then select. Only samples with at least some of the elements the analyses need are drawn.</p>
                ) : (
                  <>
                    <p className="text-sm text-gray-100">
                      {n.toLocaleString()} samples{selection.matching > n ? ` (random draw from ${selection.matching.toLocaleString()} matching)` : ""}
                    </p>
                    <p><span className="text-gray-500">Datasets:</span> {selection.bySource.map((s) => `${datasetName(s.source)} ${s.n.toLocaleString()}`).join("; ")}</p>
                    <p><span className="text-gray-500">Sample types:</span> {selection.bySampleType.slice(0, 6).map((s) => `${s.type} ${s.n.toLocaleString()}`).join("; ")}{selection.bySampleType.length > 6 ? "; …" : ""}</p>
                    <p><span className="text-gray-500">Lithology:</span> {selection.byLithology.slice(0, 6).map((s) => `${s.category.replace(/_/g, " ").toLowerCase()} ${s.n.toLocaleString()}`).join("; ")}</p>
                    {selection.nonRock > 0 && <Notice tone="warn">{nonRockShare}% of these are not rock samples (soil, sediment, till…). Igneous classification diagrams do not apply to them.</Notice>}
                    {selection.bySource.length > 1 && <p className="text-amber-300/90">Several surveys mixed: labs and methods differ.</p>}
                  </>
                )}
              </div>
            </div>
          )}
        </section>

        {/* Step 2: analyses */}
        <section className={`${card} space-y-3 print:hidden`}>
          <div className="flex flex-wrap items-baseline gap-3">
            <h2 className={heading}>2. Analyses</h2>
            <span className="text-xs text-gray-400">Up to {MAX_METHODS_PER_RUN} per run. The number is how many selected samples each one can use.</span>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-5">
            {METHOD_GROUPS.map((g) => (
              <div key={g} className="space-y-1.5">
                <span className={label}>{g}</span>
                {METHODS.filter((m) => m.group === g).map((m) => {
                  const usable = selection?.usable[m.id] ?? 0;
                  const disabled = !selection || usable < MIN_USABLE_SAMPLES;
                  const on = chosen.includes(m.id);
                  const rockWarn = m.rockOnly && selection && selection.nonRock > 0;
                  return (
                    <label key={m.id} title={m.blurb} className={`block rounded border p-2 text-xs ${on ? "border-orange-500 bg-orange-950/30" : "border-gray-800"} ${disabled ? "opacity-40" : "cursor-pointer hover:border-gray-600"}`}>
                      <span className="flex items-start gap-2">
                        <input type="checkbox" className="mt-0.5 accent-orange-500" disabled={disabled || (!on && chosen.length >= MAX_METHODS_PER_RUN)} checked={on} onChange={() => toggleMethod(m.id)} />
                        <span className="min-w-0">
                          <span className="block font-medium text-gray-100">{m.label}</span>
                          <span className="block text-gray-400">{m.blurb}</span>
                          {selection && (
                            <span className={`block ${usable < MIN_USABLE_SAMPLES ? "text-gray-500" : "text-emerald-300/90"}`}>
                              {usable < MIN_USABLE_SAMPLES ? "Not enough samples with the elements needed" : `${usable.toLocaleString()} usable (${pct(usable, n)}%)`}
                              {rockWarn && usable >= MIN_USABLE_SAMPLES ? <span className="text-amber-300/90"> · rocks only</span> : null}
                            </span>
                          )}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3 border-t border-gray-800 pt-3">
            <button className={btnRun} disabled={running || !selection || chosen.length === 0} onClick={run}>
              {running ? "Running…" : `Run ${chosen.length || ""} ${chosen.length === 1 ? "analysis" : "analyses"} and interpret`}
            </button>
            {running && <button className="text-xs text-gray-400 underline" onClick={() => abortRef.current?.abort()}>Stop</button>}
            <span className="text-xs text-gray-500">Each run counts as one question. Charts take about 10–40 seconds; the interpretation follows.</span>
          </div>
        </section>

        {/* Step 3: results */}
        {(running || results.length > 0 || text || runError) && (
          <section className="space-y-4">
            {runError && <Notice tone="error">{runError}</Notice>}
            <div className={`${card} space-y-2`}>
              <div className="flex flex-wrap items-center gap-3 print:hidden">
                <h2 className={heading}>Interpretation</h2>
                {text && !running && (
                  <>
                    <button className="text-xs text-gray-300 underline" onClick={() => { navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => undefined); }}>{copied ? "Copied" : "Copy"}</button>
                    <button className="text-xs text-gray-300 underline" onClick={() => window.print()}>Print / save as PDF</button>
                  </>
                )}
              </div>
              <h2 className="hidden text-base font-semibold print:block">Geochemistry interpretation: {n.toLocaleString()} samples ({selection?.bySource.map((s) => datasetName(s.source)).join(", ")})</h2>
              {text ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={md}>{text}</ReactMarkdown>
              ) : (
                <p className="text-sm text-gray-400">{pending.length > 0 ? `Running ${pending.length} ${pending.length === 1 ? "analysis" : "analyses"}… (${chartsDone} done)` : running ? "Writing the interpretation…" : ""}</p>
              )}
              <p className="text-[11px] text-gray-500">AI-written from the charts and numbers below; check it against them. Not a resource estimate or investment advice.</p>
            </div>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {results.map((r) => (
                <figure key={r.id} className={`${card} space-y-2 break-inside-avoid`}>
                  <figcaption className="flex items-center gap-3">
                    <span className="text-sm font-semibold text-gray-100">{r.label}</span>
                    {r.image && (
                      <a className="ml-auto text-xs text-gray-400 underline print:hidden" href={`data:image/png;base64,${r.image}`} download={`${r.id}.png`}>PNG</a>
                    )}
                  </figcaption>
                  {r.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={`data:image/png;base64,${r.image}`} alt={r.label} className="w-full rounded bg-white" />
                  ) : (
                    <Notice tone="warn">Could not run: {r.error}</Notice>
                  )}
                  {r.summary && (
                    <details className="text-xs text-gray-400 print:hidden">
                      <summary className="cursor-pointer">Numbers behind the interpretation</summary>
                      <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-gray-950 p-2 text-[11px]">{r.summary}</pre>
                    </details>
                  )}
                </figure>
              ))}
              {pending.map((id) => (
                <div key={id} className={`${card} animate-pulse text-sm text-gray-500 print:hidden`}>{METHODS.find((m) => m.id === id)?.label}: running…</div>
              ))}
            </div>
            {credits.length > 0 && <p className="text-xs text-gray-500">Data: {credits.join("; ")}</p>}
          </section>
        )}
      </main>
    </div>
  );
}
