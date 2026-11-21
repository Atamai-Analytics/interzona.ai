"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { btnRun, card, downloadCsv, heading, input, label } from "@/components/multivariate/ui";
import type { RiskPoint } from "@/components/risk/RiskMap";

const RiskMap = dynamic(() => import("@/components/risk/RiskMap"), { ssr: false, loading: () => <p className="text-sm text-gray-400">Loading map…</p> });

// Supply-risk page (/tools/risk): the league table of critical-mineral stages by concentration and export controls in force (OECD 2024),
// one mineral's producers and an importer's exposure, and a scenario builder for "what if country X cuts mineral Y". The figures come from
// the same code as the chat tools supply_risk and supply_disruption (src/lib/risk.ts, src/lib/disruption.ts) via /api/risk and
// /api/risk/scenario; nothing is computed in the browser except sorting.

type Dataset = { id: string; title: string; columns: string[]; rows: (string | number | null)[][] };
type LeagueRow = {
  mineral_key: string; mineral: string; stage: string; year: number; top_producer: { country: string; share_pct: number } | null; hhi: number;
  supply_under_export_controls_pct: number | null; of_which_bans_or_quotas_pct: number | null; under_any_measure_incl_taxes_pct: number | null;
  restriction_weighted_hhi: number; controlled_producers: string[]; new_measures_2020_2024: number;
  stability_weighted_hhi: number; low_stability_share_pct: number | null; supply_weighted_stability: number | null;
};
type Producer = { country: string; share_pct: number; export_controls: boolean; ban_or_quota: boolean; export_taxes: boolean; measures: string | null; new_measures_2020_2024: number; political_stability_score: number | null };
type Detail = {
  mineral_key: string; mineral: string; statements: string[]; notes: string[];
  stages: { stage: string; year: number; hhi: number; top_producer: { country: string; share_pct: number } | null; supply_under_export_controls_pct: number | null; of_which_bans_or_quotas_pct: number | null; restriction_weighted_hhi: number; producers: Producer[] }[];
};
type Scenario = { data: { what: string; statements: string[]; caveats: string[]; other_stages_available: string[]; credits: string[] }; datasets: Dataset[]; maps: { points: RiskPoint[] }[] };

const RANKS = [
  { key: "restriction_weighted_hhi", label: "Risk score", note: "concentration among producers with export controls in force (0-10,000)" },
  { key: "controlled_share", label: "Share under controls", note: "share of world supply from producers with export controls in force" },
  { key: "hhi", label: "Concentration (HHI)", note: "Herfindahl-Hirschman index of production (0-10,000)" },
  { key: "stability_weighted_hhi", label: "Stability-weighted", note: "concentration weighted by producers' political instability (World Bank WGI, 0-10,000)" },
  { key: "low_stability_share", label: "Low-stability supply", note: "share of world supply from producers with low political stability (World Bank WGI estimate below -1)" },
] as const;
const IMPORTERS = ["", "EU", "United States", "Japan", "South Korea", "India", "China", "United Kingdom"];
const STAGES = [
  { key: "", label: "Largest share (default)" },
  { key: "mine", label: "Mining" },
  { key: "refined", label: "Refined / processed" },
  { key: "intermediate", label: "Intermediate" },
];
const CREDITS = [
  "U.S. Geological Survey, Mineral Commodity Summaries 2026 (public domain)",
  "OECD Inventory of Export Restrictions on Industrial Raw Materials (2009-2024)",
  "CEPII BACI (version 202601, HS12), Gaulier and Zignago (2010), Etalab Open Licence 2.0",
  "Worldwide Governance Indicators, 2026 Update, World Bank (www.govindicators.org), CC BY 4.0",
];
const fmt = (v: number | null | undefined) => (v === null || v === undefined ? "–" : v.toLocaleString("en-US"));
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

function Bar({ value, max, tone }: { value: number; max: number; tone: string }) {
  return (
    <span className="inline-block h-2 w-24 rounded bg-gray-800 align-middle">
      <span className={`block h-2 rounded ${tone}`} style={{ width: `${Math.max(0, Math.min(100, (100 * value) / max))}%` }} />
    </span>
  );
}

function DataTable({ d, max = 40 }: { d: Dataset; max?: number }) {
  return (
    <div>
      <div className="mb-1 flex items-baseline gap-3">
        <p className="text-xs font-medium text-gray-300">{d.title}</p>
        <button onClick={() => downloadCsv(`interzona_${slug(d.title)}.csv`, d.columns, d.rows, CREDITS)} className="ml-auto shrink-0 text-xs text-emerald-300 underline hover:text-emerald-200">Download CSV</button>
      </div>
      <div className="max-h-[320px] overflow-auto rounded border border-gray-800">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-gray-900 text-gray-400">
            <tr>{d.columns.map((c) => <th key={c} className="px-2 py-1 text-left font-medium">{c}</th>)}</tr>
          </thead>
          <tbody>
            {d.rows.slice(0, max).map((r, i) => (
              <tr key={i} className="border-t border-gray-800">
                {r.map((v, j) => <td key={j} className={`px-2 py-1 ${typeof v === "number" ? "text-right tabular-nums" : ""}`}>{typeof v === "number" ? fmt(v) : v ?? "–"}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {d.rows.length > max && <p className="mt-1 text-xs text-gray-500">Showing {max} of {d.rows.length} rows; the CSV holds up to 100.</p>}
    </div>
  );
}

/** Plain-language guide to the numbers on this page (collapsed by default). */
function HowToRead() {
  const h3 = "mt-4 text-sm font-semibold text-gray-100";
  const p = "mt-1 text-sm leading-relaxed text-gray-300";
  const li = "text-sm leading-relaxed text-gray-300";
  return (
    <details className={`${card} group`}>
      <summary className="cursor-pointer list-none text-sm font-semibold text-rose-300 hover:text-rose-200">
        <span className="mr-1 inline-block transition-transform group-open:rotate-90">▸</span> How to read this page
      </summary>
      <div className="mt-2 max-w-4xl">
        <p className={p}>
          The page answers one question: <b>how easily could supply of a mineral, at one stage, be disrupted by the countries that produce it?</b> Each number looks at a different part of that.
        </p>

        <h3 className={h3}>The numbers</h3>
        <ul className="mt-1 list-disc space-y-2 pl-5">
          <li className={li}>
            <b>Concentration (HHI, 0–10,000)</b>: how few countries produce it (the sum of each producer&apos;s squared percentage share). Under 1,500 is spread out (copper mining, about 1,000);
            over 2,500 is highly concentrated; 10,000 means one country makes everything (gallium, about 9,800). It asks: if one country stops, how much is lost?
          </li>
          <li className={li}>
            <b>Supply under export controls (%)</b>: how much of world supply comes from countries that already have an export ban, quota or licence on it (in force in 2024).
            <span className="mx-1 rounded bg-rose-900/60 px-1.5 text-rose-100">ban or quota</span> is a hard restriction (for example the DRC on cobalt).
            <span className="mx-1 rounded bg-amber-900/60 px-1.5 text-amber-100">licensing only</span> is ambiguous: it can be a routine permit (South Africa&apos;s precious-metal export approvals, Brazil&apos;s niobium
            authorisations) or work as a ban (China&apos;s gallium and graphite controls; Indonesia&apos;s nickel-ore ban, which the data record as licensing). When a high number rests on licensing only, check the documents.
          </li>
          <li className={li}>
            <b>Risk score (restriction-weighted HHI, 0–10,000)</b>, the main ranking: concentration counted only over producers that have export controls. High means supply sits in a few countries that have already
            shown they will control exports. Gallium scores 9,803 (China makes 99% and has licensing controls); magnesium scores almost nothing although China makes 86%, because the record shows no Chinese export controls on it.
          </li>
          <li className={li}>
            <b>Political stability</b> (World Bank Worldwide Governance Indicators): each producer&apos;s score from 0 to 100 (DR Congo 28, Russia 49, China 66, Australia 79), which measures perceived risk of
            instability, conflict or terrorism. <b>Low-stability supply</b> is the share of world supply from countries well below the world average (a stability estimate below −1, about one standard deviation;
            27 of 207 countries); for example cobalt 73% (DRC) and tantalum 69%. The <b>stability-weighted</b> score is concentration weighted by how unstable each producer is. This catches a different risk from
            export controls: disruption by conflict or a coup rather than by policy.
          </li>
          <li className={li}><b>New measures 2020–24</b>: how many restrictions producers introduced or tightened recently, a rough trend signal.</li>
        </ul>

        <h3 className={h3}>Reading the combinations</h3>
        <div className="mt-1 overflow-auto rounded border border-gray-800">
          <table className="w-full text-sm">
            <thead className="bg-gray-900 text-xs text-gray-400">
              <tr><th className="px-2 py-1 text-left font-medium">Concentration</th><th className="px-2 py-1 text-left font-medium">Controls or instability</th><th className="px-2 py-1 text-left font-medium">What it means</th><th className="px-2 py-1 text-left font-medium">Examples</th></tr>
            </thead>
            <tbody className="text-gray-300">
              <tr className="border-t border-gray-800"><td className="px-2 py-1">High</td><td className="px-2 py-1">High</td><td className="px-2 py-1">The real chokepoints: few suppliers who already restrict or are unstable</td><td className="px-2 py-1">Gallium, graphite, tungsten, rare earths (China); cobalt (DRC)</td></tr>
              <tr className="border-t border-gray-800"><td className="px-2 py-1">High</td><td className="px-2 py-1">Low</td><td className="px-2 py-1">Concentrated but no record of restricting: a latent risk if policy changes</td><td className="px-2 py-1">Magnesium (China), tellurium</td></tr>
              <tr className="border-t border-gray-800"><td className="px-2 py-1">Low</td><td className="px-2 py-1">High</td><td className="px-2 py-1">Many suppliers, several restrict: manageable by diversifying</td><td className="px-2 py-1">Copper mining</td></tr>
              <tr className="border-t border-gray-800"><td className="px-2 py-1">Low</td><td className="px-2 py-1">Low</td><td className="px-2 py-1">Lowest risk</td><td className="px-2 py-1">Barite, zirconium</td></tr>
            </tbody>
          </table>
        </div>

        <h3 className={h3}>For a specific buyer: the importer view</h3>
        <p className={p}>
          Pick an importer to see how much of its own imports come from controlled or unstable suppliers. This can differ a lot from the world picture. For EU cobalt, 90% of world mine supply is under
          controls, but only about 20% of the EU&apos;s direct imports of cobalt intermediates come from controlled exporters, because the EU buys mostly refined cobalt, much of it refined in China; its real
          exposure is indirect and direct trade understates it. For US natural graphite, 63% of imports come from China, which has controls: high and direct.
        </p>

        <h3 className={h3}>Then ask &ldquo;what if?&rdquo;</h3>
        <p className={p}>
          The scenario builder below takes one country and mineral and shows world supply lost, who is exposed, who else produces, the project pipeline in our records, and what prices did after the
          country&apos;s past restrictions. The risk table tells you where to look; the scenario tells you how much it matters.
        </p>

        <h3 className={h3}>What it does not tell you</h3>
        <ul className="mt-1 list-disc space-y-1 pl-5">
          <li className={li}><b>Not a forecast</b>: it is recorded behaviour and perceptions, not a prediction that anything will happen.</li>
          <li className={li}>
            <b>Export controls are counted to 2024</b>. Later moves, such as China&apos;s 2025 rare-earth and magnet controls or the DRC&apos;s 2025 cobalt ban and quotas, are not in the score, so cobalt and rare earths
            are probably understated. Ask in the chat, which searches the document library for them.
          </li>
          <li className={li}><b>Production location, not ownership</b>: a mine in Chile owned by a Chinese company counts as Chile.</li>
          <li className={li}><b>Mostly mining</b>: processing stages are covered only where USGS publishes them (copper refining, alumina, gallium, titanium sponge and a few others).</li>
          <li className={li}><b>Stability scores are perception surveys</b>; the World Bank advises they are not definitive criteria for investment or other critical financial decisions.</li>
        </ul>

        <h3 className={h3}>A good way to use it</h3>
        <ol className="mt-1 list-decimal space-y-1 pl-5">
          <li className={li}>Rank by risk score, then by low-stability supply, to shortlist minerals.</li>
          <li className={li}>Open a mineral to see who produces it and why they are flagged, especially &ldquo;licensing only&rdquo; against &ldquo;ban or quota&rdquo;.</li>
          <li className={li}>Add your importer to see your own exposure.</li>
          <li className={li}>Run a scenario on the main producer.</li>
          <li className={li}>Ask the chat about measures since 2024.</li>
        </ol>
      </div>
    </details>
  );
}

export function RiskApp() {
  const [rankBy, setRankBy] = useState<(typeof RANKS)[number]["key"]>("restriction_weighted_hhi");
  const [league, setLeague] = useState<{ rows: LeagueRow[]; statements: string[]; dataset?: Dataset } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mineral, setMineral] = useState<string>("");
  const [importer, setImporter] = useState<string>("");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [country, setCountry] = useState("");
  const [stage, setStage] = useState("");
  const [cut, setCut] = useState(100);
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [scenarioBusy, setScenarioBusy] = useState(false);
  const [scenarioError, setScenarioError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLeague(null);
    fetch(`/api/risk?rank_by=${rankBy}`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (j.error) setError(j.error);
        else setLeague({ rows: j.data.rows, statements: j.data.statements, dataset: j.datasets?.[0] });
      })
      .catch(() => !cancelled && setError("Could not load the risk table. Please reload the page."));
    return () => { cancelled = true; };
  }, [rankBy]);

  useEffect(() => {
    if (!mineral) { setDetail(null); return; }
    let cancelled = false;
    setDetailBusy(true);
    fetch(`/api/risk?mineral=${encodeURIComponent(mineral)}${importer ? `&importer=${encodeURIComponent(importer)}` : ""}`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (j.error) { setDetail(null); setError(j.error); }
        else {
          setDetail(j.data);
          const top = j.data.stages?.[0]?.producers?.[0]?.country;
          setCountry((c) => (c && j.data.stages?.some((s: Detail["stages"][number]) => s.producers.some((p) => p.country === c)) ? c : top ?? ""));
        }
      })
      .catch(() => !cancelled && setError("Could not load that mineral."))
      .finally(() => !cancelled && setDetailBusy(false));
    return () => { cancelled = true; };
  }, [mineral, importer]);

  const minerals = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of league?.rows ?? []) if (!m.has(r.mineral_key)) m.set(r.mineral_key, r.mineral);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [league]);
  const producers = useMemo(() => {
    const s = new Set<string>();
    for (const st of detail?.stages ?? []) for (const p of st.producers) s.add(p.country);
    return [...s];
  }, [detail]);
  const maxScore = useMemo(() => Math.max(1, ...(league?.rows ?? []).map((r) => r.restriction_weighted_hhi)), [league]);

  const runScenario = async () => {
    if (!mineral || !country.trim()) return;
    setScenarioBusy(true);
    setScenarioError(null);
    setScenario(null);
    try {
      const r = await fetch("/api/risk/scenario", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ commodity: mineral.replace(/_/g, " "), country: country.trim(), stage, cut_pct: cut }) });
      const j = await r.json();
      if (j.error) setScenarioError(j.error);
      else setScenario(j);
    } catch {
      setScenarioError("The scenario could not be run. Please try again.");
    } finally {
      setScenarioBusy(false);
    }
  };

  const pick = (key: string) => {
    setMineral(key);
    setScenario(null);
    setTimeout(() => document.getElementById("mineral-panel")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  };
  const rankInfo = RANKS.find((r) => r.key === rankBy)!;

  return (
    <div className="min-h-dvh bg-gray-950 text-gray-100">
      <header className="flex flex-wrap items-center gap-3 border-b border-gray-800 px-4 py-3">
        <Link href="/" className="text-sm text-gray-400 hover:text-gray-200">← Platform</Link>
        <h1 className="text-lg font-semibold">Supply risk</h1>
        <p className="text-xs text-gray-400">Concentration and export controls by mineral, importer exposure, and what-if scenarios.</p>
        <div className="ml-auto flex gap-3 text-xs">
          <Link href="/tools/coverage" className="text-teal-300 hover:underline">World coverage</Link>
          <Link href="/" className="text-emerald-300 hover:underline">Ask in chat</Link>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-4 p-4">
        {error && <p className="rounded border border-red-800 bg-red-950/40 px-3 py-2 text-sm text-red-200">{error}</p>}
        <HowToRead />

        {/* ---- league table ---- */}
        <section className={`${card} space-y-3`}>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className={heading}>Which mineral stages are most exposed</h2>
            <div className="ml-auto flex flex-wrap gap-2" role="radiogroup" aria-label="Rank by">
              {RANKS.map((r) => (
                <button key={r.key} role="radio" aria-checked={rankBy === r.key} onClick={() => setRankBy(r.key)} title={r.note}
                  className={`rounded-md border px-2.5 py-1 text-xs ${rankBy === r.key ? "border-rose-500 bg-rose-900/40 text-rose-100" : "border-gray-700 text-gray-300 hover:border-gray-500"}`}>
                  {r.label}
                </button>
              ))}
            </div>
          </div>
          <p className="text-xs text-gray-400">
            Ranked by {rankInfo.note}. Export controls are bans, quotas or licensing in force in 2024 (OECD inventory); licensing can be a routine permit or work as a ban, so the share under bans or quotas is shown separately.
            Click a row to see the producers, an importer&apos;s exposure and a scenario.
          </p>
          {!league && !error && <p className="text-sm text-gray-400">Loading…</p>}
          {league && (
            <>
              <ul className="list-disc space-y-1 pl-5 text-xs text-gray-300">{league.statements.filter((s) => /both highly concentrated|licensing only|Political stability/.test(s)).map((s, i) => <li key={i}>{s}</li>)}</ul>
              <div className="max-h-[480px] overflow-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-gray-900 text-xs text-gray-400">
                    <tr>
                      <th className="py-1 text-left font-medium">#</th>
                      <th className="py-1 pr-3 text-left font-medium">Mineral</th>
                      <th className="py-1 pr-3 text-left font-medium">Stage</th>
                      <th className="py-1 text-left font-medium">Top producer</th>
                      <th className="py-1 pl-3 text-right font-medium">HHI</th>
                      <th className="py-1 pl-3 text-right font-medium">Under controls</th>
                      <th className="py-1 pl-3 text-right font-medium">Of which bans or quotas</th>
                      <th className="py-1 pl-3 text-left font-medium">Risk score</th>
                      <th className="py-1 pl-3 text-right font-medium">New measures 2020-24</th>
                      <th className="py-1 pl-3 text-right font-medium" title="Share of world supply from producers with a World Bank WGI political-stability estimate below -1">Low-stability supply</th>
                    </tr>
                  </thead>
                  <tbody>
                    {league.rows.map((r, i) => (
                      <tr key={`${r.mineral_key}-${r.stage}`} onClick={() => pick(r.mineral_key)} className={`cursor-pointer border-t border-gray-800 hover:bg-gray-800/50 ${mineral === r.mineral_key ? "bg-rose-900/20" : ""}`}>
                        <td className="py-1 text-gray-500 tabular-nums">{i + 1}</td>
                        <td className="py-1 pr-3">{r.mineral}</td>
                        <td className="py-1 pr-3 text-gray-400">{r.stage}</td>
                        <td className="py-1 text-gray-300">{r.top_producer ? `${r.top_producer.country} ${r.top_producer.share_pct}%` : "–"}</td>
                        <td className="py-1 pl-3 text-right tabular-nums">{fmt(r.hhi)}</td>
                        <td className="py-1 pl-3 text-right tabular-nums">{fmt(r.supply_under_export_controls_pct)}%</td>
                        <td className="py-1 pl-3 text-right tabular-nums text-gray-400">{fmt(r.of_which_bans_or_quotas_pct)}%</td>
                        <td className="py-1 pl-3 whitespace-nowrap tabular-nums"><Bar value={r.restriction_weighted_hhi} max={maxScore} tone="bg-rose-500" /> <span className="ml-1">{fmt(r.restriction_weighted_hhi)}</span></td>
                        <td className="py-1 pl-3 text-right tabular-nums text-gray-400">{r.new_measures_2020_2024}</td>
                        <td className="py-1 pl-3 text-right tabular-nums text-gray-400">{fmt(r.low_stability_share_pct)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {league.dataset && (
                <button onClick={() => downloadCsv("interzona_supply_risk_league.csv", league.dataset!.columns, league.dataset!.rows, CREDITS.slice(0, 2))} className="text-xs text-emerald-300 underline hover:text-emerald-200">Download CSV</button>
              )}
            </>
          )}
        </section>

        {/* ---- one mineral ---- */}
        <section id="mineral-panel" className={`${card} space-y-3`}>
          <div className="flex flex-wrap items-end gap-3">
            <h2 className={heading}>{detail?.mineral ?? "Pick a mineral"}</h2>
            <label className="ml-auto w-48">
              <span className={label}>Mineral</span>
              <select className={input} value={mineral} onChange={(e) => pick(e.target.value)}>
                <option value="">Choose…</option>
                {minerals.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </label>
            <label className="w-44">
              <span className={label}>Importer (optional)</span>
              <select className={input} value={importer} onChange={(e) => setImporter(e.target.value)}>
                {IMPORTERS.map((i) => <option key={i} value={i}>{i || "None"}</option>)}
              </select>
            </label>
          </div>
          {!mineral && <p className="text-sm text-gray-400">Choose a mineral here or click a row in the table above.</p>}
          {detailBusy && <p className="text-sm text-gray-400">Loading…</p>}
          {detail && !detailBusy && (
            <div className="space-y-3">
              <ul className="list-disc space-y-1 pl-5 text-sm text-gray-200">{detail.statements.map((s, i) => <li key={i}>{s}</li>)}</ul>
              {detail.stages.map((st) => (
                <div key={st.stage}>
                  <p className="mb-1 text-xs font-medium text-gray-300">{detail.mineral}, {st.stage} ({st.year}): producers and export measures in force in 2024</p>
                  <div className="overflow-auto rounded border border-gray-800">
                    <table className="w-full text-xs">
                      <thead className="bg-gray-900 text-gray-400">
                        <tr>
                          <th className="px-2 py-1 text-left font-medium">Producer</th>
                          <th className="px-2 py-1 text-right font-medium">Share</th>
                          <th className="px-2 py-1 text-left font-medium">Status</th>
                          <th className="px-2 py-1 text-left font-medium">Measures in force</th>
                          <th className="px-2 py-1 text-right font-medium">New 2020-24</th>
                          <th className="px-2 py-1 text-right font-medium" title="World Bank WGI Political Stability score, 0-100 (2025)">Political stability</th>
                        </tr>
                      </thead>
                      <tbody>
                        {st.producers.map((p) => (
                          <tr key={p.country} className="border-t border-gray-800">
                            <td className="px-2 py-1">{p.country}</td>
                            <td className="px-2 py-1 text-right tabular-nums">{p.share_pct}%</td>
                            <td className="px-2 py-1">
                              {p.ban_or_quota ? <span className="rounded bg-rose-900/60 px-1.5 text-rose-100">ban or quota</span>
                                : p.export_controls ? <span className="rounded bg-amber-900/60 px-1.5 text-amber-100">licensing only</span>
                                : p.export_taxes ? <span className="rounded bg-sky-900/60 px-1.5 text-sky-100">export taxes</span>
                                : <span className="text-gray-500">none recorded</span>}
                            </td>
                            <td className="px-2 py-1 text-gray-400">{p.measures ?? "–"}</td>
                            <td className="px-2 py-1 text-right tabular-nums text-gray-400">{p.new_measures_2020_2024}</td>
                            <td className={`px-2 py-1 text-right tabular-nums ${p.political_stability_score !== null && p.political_stability_score < 46 ? "text-rose-300" : "text-gray-400"}`}>{p.political_stability_score ?? "–"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
              {detail.notes?.length > 0 && <p className="text-xs text-gray-500">{detail.notes.join(" ")}</p>}
            </div>
          )}
        </section>

        {/* ---- scenario ---- */}
        <section className={`${card} space-y-3`}>
          <h2 className={heading}>What if a producer cuts supply?</h2>
          <p className="text-xs text-gray-400">Scenario arithmetic on recorded data: the share of world supply lost, which importers are exposed, who else produces, the project pipeline in our records, and what prices did after the country&apos;s past restrictions. Not a forecast of whether it will happen or of prices.</p>
          <div className="flex flex-wrap items-end gap-3">
            <label className="w-48">
              <span className={label}>Mineral</span>
              <select className={input} value={mineral} onChange={(e) => pick(e.target.value)}>
                <option value="">Choose…</option>
                {minerals.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </label>
            <label className="w-52">
              <span className={label}>Country that cuts supply</span>
              <input className={input} list="risk-producers" value={country} onChange={(e) => setCountry(e.target.value)} placeholder="e.g. China, DRC, Indonesia" />
              <datalist id="risk-producers">{producers.map((p) => <option key={p} value={p} />)}</datalist>
            </label>
            <label className="w-48">
              <span className={label}>Stage</span>
              <select className={input} value={stage} onChange={(e) => setStage(e.target.value)}>
                {STAGES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
            </label>
            <label className="w-56">
              <span className={label}>Cut: {cut}% of the country&apos;s supply</span>
              <input type="range" min={10} max={100} step={10} value={cut} onChange={(e) => setCut(Number(e.target.value))} className="w-full accent-rose-500" />
            </label>
            <button onClick={runScenario} disabled={!mineral || !country.trim() || scenarioBusy} className={btnRun}>{scenarioBusy ? "Running…" : "Run scenario"}</button>
          </div>
          {scenarioError && <p className="text-sm text-red-300">{scenarioError}</p>}
          {scenario && (
            <div className="space-y-4">
              <p className="text-sm font-medium text-gray-100">{scenario.data.what}</p>
              <ul className="list-disc space-y-1 pl-5 text-sm text-gray-200">{scenario.data.statements.map((s, i) => <li key={i}>{s}</li>)}</ul>
              {scenario.maps[0]?.points?.length > 0 && (
                <div>
                  <p className="mb-1 text-xs font-medium text-gray-300">Facilities outside the country at this stage (USGS facility lists; nameplate capacity, not spare capacity)</p>
                  <RiskMap points={scenario.maps[0].points} />
                </div>
              )}
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                {scenario.datasets.map((d) => <DataTable key={d.id} d={d} />)}
              </div>
              <div>
                <p className="mb-1 text-xs font-medium text-gray-300">Caveats</p>
                <ul className="list-disc space-y-1 pl-5 text-xs text-gray-400">{scenario.data.caveats.map((c, i) => <li key={i}>{c}</li>)}</ul>
              </div>
              <p className="text-xs text-gray-500">
                For measures since 2024 (for example China&apos;s 2025 rare-earth and magnet controls or the DRC&apos;s 2025 cobalt quotas) and the policy context, ask in the chat: it searches the document library.
                Data: {scenario.data.credits.join("; ")}.
              </p>
            </div>
          )}
        </section>

        <p className="text-xs text-gray-500">
          Sources: {CREDITS.join("; ")}; European Commission RMIS (EU import reliance and recycling rates). Production shares are USGS estimates and show where material is produced, not who owns it.
          The risk score reflects recorded export measures, not intentions; the OECD inventory ends in 2024. Political stability scores are the World Bank&apos;s Worldwide Governance Indicators (2026 update, 0-100, perception-based);
          the World Bank advises they are not definitive criteria for investment or other critical financial decisions.
        </p>
      </main>
    </div>
  );
}
