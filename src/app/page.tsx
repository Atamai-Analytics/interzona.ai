"use client";

import { createContext, useContext, useState, useRef, useEffect, useMemo } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import type { Conversation, ConversationMeta, Dataset, Evidence, ImageAttachment, MapData, Message, Step } from "@/lib/types";
import { chartLayout, fmtValue, SERIES_COLORS, W, H } from "@/lib/chart";
import { deleteConversation, exportAll, getConversation, importAll, listConversations, renameConversation, saveConversation } from "@/lib/store";
import { downloadText, slug, toMarkdown } from "@/lib/export";
import { DEMO_CARDS } from "@/lib/demo-cards";
import { csvWithCredits } from "@/lib/csv";
import { IntroPanel } from "@/components/IntroPanel";
import { FeedbackBar } from "@/components/FeedbackBar";
import { ShareAnswer } from "@/components/ShareAnswer";
import { HistoryPanel } from "@/components/HistoryPanel";
import { PrintView } from "@/components/PrintView";

// Leaflet touches window on import, so the map is loaded in the browser only.
const MapView = dynamic(() => import("@/components/MapView"), { ssr: false });

type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "turn_end"; final: boolean }
  | { type: "step_start"; id: string; label: string }
  | { type: "step_end"; id: string; ok: boolean; ms: number }
  | { type: "image"; image: ImageAttachment }
  | { type: "evidence"; items: Evidence[] }
  | { type: "dataset"; dataset: Dataset }
  | { type: "map"; map: MapData }
  | { type: "notice"; message: string }
  | { type: "answer"; id: string }
  | { type: "error"; message: string }
  | { type: "done" };

const evidenceKey = (e: Evidence) =>
  e.kind === "document" ? `d|${e.title}|${e.page ?? ""}` : e.kind === "web" ? `w|${e.url}` : `x|${e.label}|${e.detail ?? ""}`;

// The publishers behind an answer (from its data sources), repeated at the end of every CSV the answer offers.
const CreditsCtx = createContext<string[]>([]);
const creditsOf = (m: Message) => (m.evidence ?? []).filter((e) => e.kind === "data").map((e) => (e.kind === "data" ? e.label : ""));

function downloadCsv(filename: string, columns: string[], rows: (string | number | null)[][], credits: string[] = []) {
  // csvWithCredits adds the BOM (so Excel reads UTF-8 correctly) and the credits block.
  const blob = new Blob([csvWithCredits(columns, rows, credits)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.replace(/[^a-z0-9._-]+/gi, "_").slice(0, 80) + ".csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function LineChart({ chart, title }: { chart: NonNullable<Dataset["chart"]>; title: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const lay = chartLayout(chart);
  if (!lay) return null;
  const { pts, x, y, yTicks, xTicks, paths, plot } = lay;
  const base = pts[0];
  const hp = hover !== null ? base[hover] : null;
  const t0 = Math.min(...pts.flat().map((p) => p.t));
  const t1 = Math.max(...pts.flat().map((p) => p.t));
  const nearest = (sp: { t: number; v: number }[], t: number) => sp.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a), sp[0]);
  return (
    <div className="mt-3">
      <div className="mb-1 text-xs text-gray-400">
        {title} <span className="text-gray-600">· {chart.unit}</span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full max-w-[640px] rounded border border-gray-700 bg-gray-900"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          const t = t0 + ((px - plot.L) / (W - plot.L - plot.R)) * (t1 - t0);
          let best = 0;
          for (let i = 1; i < base.length; i++) if (Math.abs(base[i].t - t) < Math.abs(base[best].t - t)) best = i;
          setHover(best);
        }}
      >
        {yTicks.map((tv, i) => (
          <g key={i}>
            <line x1={plot.L} x2={W - plot.R} y1={y(tv)} y2={y(tv)} stroke="#374151" strokeWidth="0.5" />
            <text x={plot.L - 6} y={y(tv) + 3} textAnchor="end" fontSize="10" fill="#9ca3af">
              {fmtValue(tv)}
            </text>
          </g>
        ))}
        {xTicks.map((tt) => (
          <text key={tt} x={x(tt)} y={H - 8} textAnchor="middle" fontSize="10" fill="#9ca3af">
            {new Date(tt).getUTCFullYear()}
          </text>
        ))}
        {paths.map((d, si) => (
          <path key={si} d={d} fill="none" stroke={SERIES_COLORS[si % SERIES_COLORS.length]} strokeWidth="1.6" />
        ))}
        {hp && (
          <g>
            <line x1={x(hp.t)} x2={x(hp.t)} y1={plot.T} y2={H - plot.B} stroke="#6b7280" strokeWidth="0.7" strokeDasharray="3 3" />
            {pts.map((sp, si) => {
              const near = nearest(sp, hp.t);
              return <circle key={si} cx={x(near.t)} cy={y(near.v)} r="3" fill={SERIES_COLORS[si % SERIES_COLORS.length]} />;
            })}
          </g>
        )}
      </svg>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-gray-300">
        {chart.series.map((s, i) => {
          const near = hp ? nearest(pts[i], hp.t) : pts[i][pts[i].length - 1];
          return (
            <span key={s.name}>
              <span style={{ color: SERIES_COLORS[i % SERIES_COLORS.length] }}>●</span> {s.name}: {fmtValue(near.v)}{" "}
              <span className="text-gray-500">({new Date(near.t).toISOString().slice(0, 7)})</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

function BarsView({ title, bars }: { title: string; bars: NonNullable<Dataset["bars"]> }) {
  const max = Math.max(1, ...bars.items.flatMap((i) => [i.value, i.compare ?? 0]));
  return (
    <div className="my-2 rounded border border-gray-700 p-3">
      <p className="mb-2 text-xs text-gray-400">
        {title} <span className="text-gray-500">({bars.unit})</span>
      </p>
      <div className="space-y-2">
        {bars.items.map((i) => (
          <div key={i.label}>
            <div className="flex justify-between text-xs text-gray-300">
              <span>{i.label}</span>
              <span className="text-gray-400">
                {i.value}%{i.compare !== undefined ? ` · ${i.compare}%` : ""}
              </span>
            </div>
            <div className="mt-0.5 h-2 rounded bg-gray-900">
              <div className="h-2 rounded bg-blue-400" style={{ width: `${(i.value / max) * 100}%` }} />
            </div>
            {i.compare !== undefined && (
              <div className="mt-0.5 h-1.5 rounded bg-gray-900">
                <div className="h-1.5 rounded bg-gray-500" style={{ width: `${(i.compare / max) * 100}%` }} />
              </div>
            )}
          </div>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-gray-500">
        <span className="text-blue-400">▬</span> {bars.legend[0]}
        {bars.legend[1] && (
          <>
            {" "}
            <span className="text-gray-400">▬</span> {bars.legend[1]}
          </>
        )}
      </p>
    </div>
  );
}

function DatasetView({ ds, credits }: { ds: Dataset; credits: string[] }) {
  return (
    <div>
      {ds.chart && <LineChart chart={ds.chart} title={ds.title} />}
      {ds.bars && <BarsView title={ds.title} bars={ds.bars} />}
      <button
        onClick={() => downloadCsv(ds.title, ds.columns, ds.rows, credits)}
        className="mt-2 rounded border border-gray-600 px-2 py-1 text-xs text-gray-300 hover:border-blue-500 hover:text-white"
      >
        ⬇ Download {ds.chart ? "data" : "table"} (CSV, {ds.rows.length.toLocaleString("en-US")} rows)
      </button>
    </div>
  );
}

function MdTable(props: React.ComponentProps<"table">) {
  const ref = useRef<HTMLTableElement>(null);
  const credits = useContext(CreditsCtx);
  const download = () => {
    const rows = Array.from(ref.current?.querySelectorAll("tr") ?? []).map((tr) => Array.from(tr.children).map((c) => (c.textContent ?? "").trim()));
    if (rows.length) downloadCsv("table", rows[0], rows.slice(1), credits);
  };
  return (
    <div className="my-2">
      <div className="overflow-x-auto">
        <table ref={ref} className="border-collapse border border-gray-700 text-sm" {...props} />
      </div>
      <button onClick={download} className="mt-1 text-[11px] text-gray-500 hover:text-gray-200">
        ⬇ CSV
      </button>
    </div>
  );
}

function Sources({ evidence }: { evidence: Evidence[] }) {
  if (evidence.length === 0) return null;
  const docs = evidence.filter((e): e is Extract<Evidence, { kind: "document" }> => e.kind === "document");
  const web = evidence.filter((e): e is Extract<Evidence, { kind: "web" }> => e.kind === "web");
  const data = evidence.filter((e): e is Extract<Evidence, { kind: "data" }> => e.kind === "data");
  // One line per document, listing the pages that were used.
  const byTitle = new Map<string, number[]>();
  for (const d of docs) {
    const pages = byTitle.get(d.title) ?? [];
    if (d.page !== undefined && !pages.includes(d.page)) pages.push(d.page);
    byTitle.set(d.title, pages);
  }
  const heading = "mt-2 mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500";
  return (
    <details className="mt-3 border-t border-gray-700 pt-2 text-xs text-gray-400">
      <summary className="cursor-pointer select-none hover:text-gray-200">Sources ({byTitle.size + web.length + data.length})</summary>
      {data.length > 0 && (
        <>
          <div className={heading}>Data used</div>
          <ul className="space-y-0.5">
            {data.map((d, i) => (
              <li key={i}>
                {d.label}
                {d.detail ? <span className="text-gray-600"> · {d.detail}</span> : null}
              </li>
            ))}
          </ul>
        </>
      )}
      {byTitle.size > 0 && (
        <>
          <div className={heading}>Documents</div>
          <ul className="space-y-0.5">
            {[...byTitle.entries()].map(([title, pages]) => (
              <li key={title}>
                {title}
                {pages.length > 0 ? <span className="text-gray-600"> · p. {pages.sort((a, b) => a - b).join(", ")}</span> : null}
              </li>
            ))}
          </ul>
        </>
      )}
      {web.length > 0 && (
        <>
          <div className={heading}>Web</div>
          <ul className="space-y-0.5">
            {web.map((w) => (
              <li key={w.url}>
                <a className="text-blue-400 underline" href={w.url} target="_blank" rel="noopener noreferrer">
                  {w.title}
                </a>
              </li>
            ))}
          </ul>
        </>
      )}
    </details>
  );
}

function Steps({ steps, streaming }: { steps: Step[]; streaming: boolean }) {
  if (steps.length === 0) return null;
  const line = (s: Step) => (
    <li key={s.id} className="flex items-start gap-2">
      <span className="mt-0.5 w-3 shrink-0 text-center">
        {s.status === "running" ? (
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-blue-400" />
        ) : s.status === "done" ? (
          <span className="text-green-500">✓</span>
        ) : (
          <span className="text-amber-500">!</span>
        )}
      </span>
      <span className={s.status === "running" ? "text-gray-200" : "text-gray-400"}>
        {s.label}
        {s.status !== "running" && s.ms ? <span className="text-gray-600"> · {(s.ms / 1000).toFixed(1)}s</span> : null}
      </span>
    </li>
  );
  if (streaming) {
    return <ul className="mb-2 space-y-1 text-xs">{steps.map(line)}</ul>;
  }
  return (
    <details className="mb-2 text-xs text-gray-400">
      <summary className="cursor-pointer select-none hover:text-gray-200">
        {steps.length} step{steps.length === 1 ? "" : "s"} taken
      </summary>
      <ul className="mt-1 space-y-1">{steps.map(line)}</ul>
    </details>
  );
}

const markdownComponents = {
  table: MdTable,
  th: (props: React.ComponentProps<"th">) => (
    <th className="border border-gray-700 bg-gray-800 px-2 py-1 text-left font-semibold" {...props} />
  ),
  td: (props: React.ComponentProps<"td">) => (
    <td className="border border-gray-700 px-2 py-1 align-top" {...props} />
  ),
  code: (props: React.ComponentProps<"code">) => (
    <code className="bg-gray-800 text-gray-200 rounded px-1 py-0.5 text-xs" {...props} />
  ),
  ul: (props: React.ComponentProps<"ul">) => <ul className="list-disc list-inside my-1" {...props} />,
  ol: (props: React.ComponentProps<"ol">) => <ol className="list-decimal list-inside my-1" {...props} />,
  a: (props: React.ComponentProps<"a">) => (
    <a className="text-blue-400 underline" target="_blank" rel="noopener noreferrer" {...props} />
  ),
  p: (props: React.ComponentProps<"p">) => <p className="mb-2 last:mb-0" {...props} />,
};

type Capability = {
  icon: string;
  domain: string;
  title: string;
  description: string;
  prompt: string;
};

// This list is expected to grow substantially — adding a new domain is just using a new `domain`
// string here, the filter row above the list picks it up automatically, no other code changes.
const DEMO_DOMAIN = "Demo flows";
const CAPABILITIES: Capability[] = [
  // Cross-domain flows: each one joins geology, companies, prices and the document library in a single question (see src/lib/demo-cards.ts).
  ...DEMO_CARDS.map((c) => ({ ...c, domain: DEMO_DOMAIN })),
  {
    icon: "🔎",
    domain: "Database",
    title: "Structured data queries",
    description: "Ask anything about occurrences, samples, and analytical results directly.",
    prompt: "How many occurrences are in Argentina, and what are the top 3 commodities by number of occurrences?",
  },
  {
    icon: "📄",
    domain: "Documents",
    title: "Document search",
    description: "Semantic search over ingested reports, filings, and investor decks.",
    prompt: "What does the literature say about lithium processing from brine deposits?",
  },
  {
    icon: "🕸️",
    domain: "Geochemistry",
    title: "REE spider diagrams",
    description: "Chondrite or primitive-mantle normalized multi-element pattern plots — works on a single occurrence or a whole discovered set.",
    prompt: "What LCT pegmatite occurrences are in Argentina? Generate a combined REE spider diagram for their samples.",
  },
  {
    icon: "🧭",
    domain: "Structural Geology",
    title: "Structural / lineament analysis",
    description: "Fault network statistics and rose diagrams around a specific occurrence. Ask for an interpretation of the dominant trend.",
    prompt: "Pick a gold occurrence in Argentina and show me the structural setting around it — fault statistics plus a rose diagram — and interpret the dominant trend.",
  },
  {
    icon: "📊",
    domain: "Geochemistry",
    title: "Compositional statistics",
    description: "Statistically correct (CLR-transformed) element correlation analysis — one occurrence or a discovered, filtered set of samples.",
    prompt: "Pick a sample of stream-sediment samples from Greenland and tell me which elements are most strongly correlated, accounting for the compositional data problem.",
  },
  {
    icon: "🌋",
    domain: "Geochemistry",
    title: "Tectonic discrimination",
    description: "Pearce Th/Yb-Nb/Yb diagrams for magma source / tectonic setting. Ask for an interpretation, not just the plot.",
    prompt: "Find an occurrence in Argentina with enough Th, Nb, and Yb data to run a Pearce tectonic discrimination plot, then interpret what it suggests about the magma source.",
  },
  {
    icon: "🧪",
    domain: "Geochemistry",
    title: "Hydrothermal alteration vectoring",
    description: "Large et al. alteration box plot (CCPI vs. Ishikawa Index) from major-oxide data — works for Finland, Greenland, Sweden and USGS rock samples. Ask for an interpretation, not just the plot.",
    prompt: "What does the alteration pattern look like at the Black Angel Mine in Greenland? Run the alteration box plot and interpret it.",
  },
  {
    icon: "🪞",
    domain: "Geochemistry",
    title: "REE pattern shape comparison",
    description: "Fits REE pattern shape coefficients per sample (not just one averaged pattern) and plots them together — reveals whether a discovered group of occurrences shares one geochemical story or splits into distinct ones.",
    prompt: "What LCT pegmatite occurrences are in Argentina? Run the REE lambda shape plot across their samples and tell me whether they share one pattern shape or split into distinct groups.",
  },
  {
    icon: "🌋",
    domain: "Geochemistry",
    title: "Igneous rock classification",
    description: "TAS (Total Alkali-Silica) diagram — classifies whole-rock samples into standard igneous rock names (basalt, andesite, rhyolite, etc.) from major-oxide data. Works for Finland, Greenland, Sweden and USGS rock samples.",
    prompt: "Run a TAS classification diagram on a batch of Swedish (SGU) rock samples and summarize what rock types are present.",
  },
  {
    icon: "🌍",
    domain: "Database",
    title: "Global occurrence search",
    description: "About 285,000 mineral sites in 165 countries (USGS MRDS, Washington, SEGEMAR and others). Filter by commodity, status and country — quality varies by source.",
    prompt: "Which countries have the most producing or past-producing lithium, cobalt or graphite occurrences in the mineral occurrence data? Show the top 10 and tell me how reliable this data is.",
  },
  {
    icon: "🎯",
    domain: "Geochemistry",
    title: "Screening samples against known deposits",
    description: "Combines multi-element sample chemistry with the sample-to-occurrence links: find anomalous samples and see which known occurrence is nearest and how far away it is.",
    prompt: "Find rock samples in the United States with lithium above 3,000 ppm and tell me, for the five main clusters, which known lithium occurrence is nearest and how far away it is.",
  },
  {
    icon: "🧭",
    domain: "Geochemistry",
    title: "Where to explore",
    description: "Screens the sample geochemistry itself for anomalies (ranked within each sample type), then shows which are new leads and which sit beside known deposits — for rare earths or any element, in any of the six geochemical datasets.",
    prompt: "Where should I explore for rare earth elements in Greenland? Start from the geochemical data and separate new leads from areas that already have known deposits, and keep it to the top five leads with a short table (no plots needed).",
  },
  {
    icon: "🏭",
    domain: "Database",
    title: "US processing capacity",
    description: "Annual capacity, status and owners of US mines, smelters and refineries (USGS 2026 facilities release) — for example who could supply lithium or rare earths, and where.",
    prompt: "Which US facilities mine or process lithium, and what is each one's annual capacity, stage, status and owner? Compare like with like and tell me what the figures can and cannot be added up to.",
  },
  {
    icon: "⛏️",
    domain: "Geochemistry",
    title: "Chemistry around producing mines",
    description: "Compares element levels in samples within 500 m of producing or past-producing occurrences against all other samples — a quick way to see a deposit's geochemical footprint.",
    prompt: "Compare copper, lead, zinc and silver in USGS samples within 500 m of producing or past-producing copper occurrences against all other USGS samples, and tell me how much higher they are.",
  },
  {
    icon: "⏳",
    domain: "Geochronology",
    title: "Bedrock ages",
    description: "Radiometric ages (U-Pb, Ar-Ar, Rb-Sr and others) with their literature references — currently the Swedish bedrock age database and some Argentine and Washington ages.",
    prompt: "Summarise the Swedish bedrock ages by interpretation (magmatic, metamorphic, cooling) and dating method, and list the ten oldest dated localities with their literature references.",
  },
  {
    icon: "💰",
    domain: "Financial Modeling",
    title: "Project economics (DCF)",
    description: "NPV, IRR, payback, and a one-way sensitivity ranking from assumptions you supply — there is no built-in project-economics data, so give it real numbers (or ask for a fully worked illustrative example like this one).",
    prompt: "Run a DCF model for an illustrative 10-year lithium project with these assumptions, all in $M scale: recovered lithium carbonate tonnes per year: 0,0,8000,12000,12000,12000,12000,10000,8000,0. Price per tonne: 0.014 $M. Operating costs per year ($M): 2,3,60,85,85,85,85,75,60,5. Capex per year ($M): 40,60,20,10,10,10,10,10,5,5. Tax rate 30%, discount rate 8%, royalty 2%. Give me NPV, IRR, payback, and tell me which assumption matters most.",
  },
  {
    icon: "🧂",
    domain: "Financial Modeling",
    title: "Validate DCF against a real feasibility study",
    description: "Pulls the real assumptions and results out of Albemarle's own Salar de Atacama prefeasibility study (ingested from its 10-K) and checks whether the DCF tool reproduces SRK's reported NPV.",
    prompt: "Search the documents for Albemarle's Salar de Atacama prefeasibility study and find its modeled assumptions (lithium price, discount rate, tax/royalty rates, annual production, operating costs, and capex schedule) and its reported NPV results. Then run the DCF model using those real assumptions and tell me how closely it matches the study's own reported after-tax NPV.",
  },
];

const ALL_DOMAINS = "All";

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [selectedDomain, setSelectedDomain] = useState<string>(DEMO_DOMAIN);
  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [history, setHistory] = useState<ConversationMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const createdAtRef = useRef(0);
  const titleRef = useRef("");
  const [tab, setTab] = useState<"tools" | "history">("tools");
  // On a phone one pane shows at a time: the chat, or the examples and history. From md up both show side by side and this is ignored.
  const [pane, setPane] = useState<"chat" | "explore">("chat");
  const [printConv, setPrintConv] = useState<Conversation | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [snapCompanies, setSnapCompanies] = useState<{ name: string; ticker: string | null; years: number }[]>([]);
  const [snapPick, setSnapPick] = useState("");
  // Who is signed in: the owner, or a guest on a personal invitation (with today's remaining questions).
  type Who = { role: "owner" | "guest"; name?: string; left?: number; limit?: number; expires?: number; ended?: string };
  const [who, setWho] = useState<Who | null>(null);
  const refreshWho = () =>
    fetch("/api/session")
      .then((r) => (r.status === 401 ? (window.location.assign("/access"), null) : r.ok ? r.json() : null))
      .then((d) => d && setWho(d as Who))
      .catch(() => {});
  useEffect(() => {
    refreshWho();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  async function signOut() {
    await fetch("/api/access/logout", { method: "POST" }).catch(() => {});
    window.location.assign("/access");
  }
  useEffect(() => {
    fetch("/api/snapshot")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j && setSnapCompanies(j.companies ?? []))
      .catch(() => {});
  }, []);

  const notify = (t: string) => {
    setToast(t);
    setTimeout(() => setToast(null), 4000);
  };
  const refreshHistory = async () => setHistory(await listConversations());

  // Questions stopped before any answer came back are not worth keeping.
  const answeredOnly = (msgs: Message[]) =>
    msgs.filter((m, i) => {
      if (m.role === "assistant") return m.content.trim() || m.images?.length;
      const reply = msgs[i + 1];
      return !(reply?.role === "assistant" && reply.stopped && !reply.content.trim() && !reply.images?.length);
    });

  const titleFrom = (msgs: Message[]) => {
    const first = msgs.find((m) => m.role === "user")?.content.replace(/\s+/g, " ").trim() ?? "Conversation";
    return first.length > 60 ? first.slice(0, 57).trimEnd() + "…" : first;
  };

  const buildConversation = (): Conversation => ({
    id: activeIdRef.current ?? "unsaved",
    title: titleRef.current || titleFrom(messages),
    createdAt: createdAtRef.current || Date.now(),
    updatedAt: Date.now(),
    messages: answeredOnly(messages),
  });

  async function persistNow(msgs: Message[]) {
    const kept = answeredOnly(msgs);
    if (kept.length === 0) return;
    if (!activeIdRef.current) {
      activeIdRef.current = crypto.randomUUID();
      createdAtRef.current = Date.now();
      titleRef.current = titleFrom(kept);
      setActiveId(activeIdRef.current);
    }
    await saveConversation({ id: activeIdRef.current, title: titleRef.current, createdAt: createdAtRef.current, updatedAt: Date.now(), messages: kept });
    await refreshHistory();
  }

  useEffect(() => {
    refreshHistory();
  }, []);

  // Keeps a thumbs up/down on the answer at index i and saves it with the conversation.
  function rate(i: number, f: NonNullable<Message["feedback"]>) {
    const next = messages.map((m, j) => (j === i ? { ...m, feedback: f } : m));
    setMessages(next);
    persistNow(next);
  }

  // Save after each answer finishes (or is stopped), not while it is streaming.
  useEffect(() => {
    if (!loading && messages.length > 0) persistNow(messages);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  function newConversation() {
    if (loading) return;
    activeIdRef.current = null;
    createdAtRef.current = 0;
    titleRef.current = "";
    setActiveId(null);
    setMessages([]);
    setInput("");
    setPane("chat");
  }

  async function openConversation(id: string) {
    if (loading) return;
    const c = await getConversation(id);
    if (!c) {
      notify("Could not open that conversation.");
      return;
    }
    activeIdRef.current = c.id;
    createdAtRef.current = c.createdAt;
    titleRef.current = c.title;
    setActiveId(c.id);
    setMessages(c.messages);
    setPane("chat");
  }

  async function removeConversation(id: string) {
    await deleteConversation(id);
    if (id === activeIdRef.current) newConversation();
    await refreshHistory();
  }

  async function renameItem(id: string, title: string) {
    await renameConversation(id, title);
    if (id === activeIdRef.current) titleRef.current = title;
    await refreshHistory();
  }

  async function backupAll() {
    const data = await exportAll();
    downloadText(`critical-minerals-assistant-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data), "application/json");
  }

  async function restoreFrom(file: File) {
    try {
      const n = await importAll(JSON.parse(await file.text()));
      await refreshHistory();
      notify(`Restored ${n} conversation${n === 1 ? "" : "s"}.`);
    } catch (e) {
      notify(e instanceof Error ? e.message : "That file could not be read.");
    }
  }

  function exportMarkdown() {
    const c = buildConversation();
    downloadText(`${slug(c.title)}.md`, toMarkdown(c), "text/markdown;charset=utf-8");
  }

  function exportPdf() {
    setPrintConv(buildConversation());
  }

  // Print the export view once it has rendered; "Save as PDF" in the print dialog makes the file.
  useEffect(() => {
    if (!printConv) return;
    const previousTitle = document.title;
    document.title = printConv.title;
    const after = () => {
      document.title = previousTitle;
      setPrintConv(null);
    };
    window.addEventListener("afterprint", after, { once: true });
    const t = setTimeout(() => window.print(), 250);
    return () => {
      clearTimeout(t);
      window.removeEventListener("afterprint", after);
      document.title = previousTitle;
    };
  }, [printConv]);

  const domains = useMemo(
    () => [ALL_DOMAINS, ...Array.from(new Set(CAPABILITIES.map((c) => c.domain)))],
    []
  );
  const visibleCapabilities = useMemo(
    () => (selectedDomain === ALL_DOMAINS ? CAPABILITIES : CAPABILITIES.filter((c) => c.domain === selectedDomain)),
    [selectedDomain]
  );

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function stop() {
    abortRef.current?.abort();
  }

  async function send(promptOverride?: string) {
    const text = promptOverride ?? input;
    if (!text.trim() || loading) return;
    setPane("chat");
    // Drop questions that were stopped before any answer came back, so the next question does not also re-ask them.
    const history = messages.filter((m, i) => {
      if (!m.content.trim()) return false;
      const reply = messages[i + 1];
      return !(m.role === "user" && reply?.role === "assistant" && reply.stopped && !reply.content.trim());
    });
    const userMsg: Message = { role: "user", content: text };
    const next = [...history, userMsg];
    // Only role + content go to the server; steps/images are display-only.
    const payload = next.map((m) => ({ role: m.role, content: m.content }));
    setMessages([...next, { role: "assistant", content: "", steps: [], streaming: true }]);
    setInput("");
    setLoading(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    // Update the in-progress assistant message (always the last one).
    const patch = (fn: (m: Message) => Message) =>
      setMessages((prev) => {
        const copy = prev.slice();
        copy[copy.length - 1] = fn(copy[copy.length - 1]);
        return copy;
      });

    // Text from a turn that ends in tool calls is narration; keep it separate until we know whether the turn was final.
    let turnText = "";
    const apply = (ev: StreamEvent) => {
      switch (ev.type) {
        case "text":
          turnText += ev.delta;
          patch((m) => ({ ...m, content: turnText }));
          break;
        case "turn_end":
          if (!ev.final) {
            turnText = "";
            patch((m) => ({ ...m, content: "" }));
          }
          break;
        case "step_start":
          patch((m) => ({ ...m, steps: [...(m.steps ?? []), { id: ev.id, label: ev.label, status: "running" }] }));
          break;
        case "step_end":
          patch((m) => ({
            ...m,
            steps: (m.steps ?? []).map((s) => (s.id === ev.id ? { ...s, status: ev.ok ? "done" : "error", ms: ev.ms } : s)),
          }));
          break;
        case "image":
          patch((m) => ({ ...m, images: [...(m.images ?? []), ev.image] }));
          break;
        case "dataset":
          patch((m) => ({ ...m, datasets: [...(m.datasets ?? []), ev.dataset] }));
          break;
        case "map":
          // At most one map per kind: exploration leads, company assets, or other places. Follow-up lookups often repeat the same places, so within a
          // kind the larger map wins, and a map of other places is shown only when there is neither a leads map nor an assets map.
          patch((m) => {
            const kindOf = (x: MapData) => (x.title.startsWith("Anomaly screen") ? "leads" : /assets with a known position/.test(x.title) ? "assets" : "places");
            const byKind = new Map<string, MapData>();
            for (const x of [...(m.maps ?? []), ev.map]) {
              const cur = byKind.get(kindOf(x));
              if (!cur || x.points.length > cur.points.length) byKind.set(kindOf(x), x);
            }
            const out = (["leads", "assets"] as const).map((k) => byKind.get(k)).filter((x): x is MapData => !!x);
            if (out.length === 0 && byKind.get("places")) out.push(byKind.get("places")!);
            return { ...m, maps: out };
          });
          break;
        case "evidence":
          patch((m) => {
            const seen = new Set((m.evidence ?? []).map(evidenceKey));
            const fresh = ev.items.filter((e) => !seen.has(evidenceKey(e)) && seen.add(evidenceKey(e)));
            return { ...m, evidence: [...(m.evidence ?? []), ...fresh] };
          });
          break;
        case "notice":
          patch((m) => ({ ...m, notice: ev.message }));
          break;
        case "answer":
          patch((m) => ({ ...m, answerId: ev.id }));
          break;
        case "error":
          patch((m) => ({ ...m, content: m.content ? m.content : ev.message, notice: m.content ? ev.message : undefined }));
          break;
        case "done":
          break;
      }
    };

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: payload }),
        signal: ctrl.signal,
      });
      if (res.status === 401) {
        window.location.assign("/access");
        return;
      }
      if (!res.ok || !res.body) {
        // The server refuses with a plain-language reason when a limit is reached (too many questions, question too long, daily capacity).
        let reason = "";
        try {
          reason = String(((await res.json()) as { error?: string })?.error ?? "");
        } catch {
          /* not JSON */
        }
        if (reason) {
          patch((m) => ({ ...m, streaming: false, content: reason, steps: [] }));
          return;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            apply(JSON.parse(line) as StreamEvent);
          } catch {
            /* ignore a malformed line */
          }
        }
      }
      patch((m) => ({
        ...m,
        streaming: false,
        content: m.content || (m.notice ? "" : "I wasn't able to produce an answer. Please try again."),
        steps: (m.steps ?? []).map((s) => (s.status === "running" ? { ...s, status: "done" } : s)),
      }));
    } catch (err) {
      const aborted = (err as Error)?.name === "AbortError" || ctrl.signal.aborted;
      patch((m) => ({
        ...m,
        streaming: false,
        stopped: aborted,
        content: m.content || (aborted ? "" : "The request failed. Please try again."),
        steps: (m.steps ?? []).map((s) => (s.status === "running" ? { ...s, status: "error" } : s)),
      }));
    } finally {
      abortRef.current = null;
      setLoading(false);
      refreshWho();
    }
  }

  return (
    <>
    <div className="flex flex-col h-dvh bg-gray-950 text-gray-100 print:hidden">
      <header className="border-b border-gray-800 px-3 py-2 md:px-4 md:py-3 shrink-0 flex flex-wrap md:flex-nowrap items-center gap-x-3 gap-y-1">
        {/* Interzona mark: transparent, light ink so the brushwork reads on the dark theme */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/interzona-mark.png" alt="Interzona" width={56} height={56} className="h-9 w-9 md:h-14 md:w-14 shrink-0 select-none" />
        <div className="min-w-0 flex-1">
          <h1 className="text-base md:text-xl font-semibold leading-tight">Critical Minerals AI Assistant</h1>
          <p className="hidden md:block text-xs text-gray-400">
            Ask about mineral deposits, geochemistry and exploration targets, company financials, commodity prices and exchange rates, and the research, policy and industry literature — with analyses, charts and sources.
          </p>
        </div>
        {who && !(who.role === "guest" && who.ended) && (
          <Link
            href="/tools/multivariate"
            className="shrink-0 md:self-center flex items-center gap-1.5 rounded-lg border border-emerald-600 bg-emerald-900/40 px-2.5 py-1.5 text-xs md:text-sm font-medium text-emerald-100 hover:bg-emerald-800/60"
            title="Correlation, PCA, clustering, maps, UMAP and t-SNE on database samples or your own CSV"
          >
            <svg aria-hidden viewBox="0 0 16 16" className="h-4 w-4" fill="currentColor"><circle cx="3.5" cy="11" r="1.6" /><circle cx="6.5" cy="6" r="1.6" /><circle cx="10" cy="9" r="1.6" /><circle cx="12.5" cy="4" r="1.6" /></svg>
            Multivariate tools
          </Link>
        )}
        {who && !(who.role === "guest" && who.ended) && (
          <Link
            href="/tools/intercepts"
            className="shrink-0 md:self-center flex items-center gap-1.5 rounded-lg border border-orange-600 bg-orange-900/30 px-2.5 py-1.5 text-xs md:text-sm font-medium text-orange-100 hover:bg-orange-800/50"
            title="Significant drill intercepts from downhole assays: cut-off, width, dilution, including and metal equivalent, on database holes or your own CSV"
          >
            <svg aria-hidden viewBox="0 0 16 16" className="h-4 w-4" fill="currentColor"><rect x="7" y="1" width="2" height="14" rx="0.5" /><rect x="5" y="6" width="6" height="3" rx="0.5" /></svg>
            Drill intercepts
          </Link>
        )}
        {who && !(who.role === "guest" && who.ended) && (
          <Link
            href="/tools/geochemistry"
            className="shrink-0 md:self-center flex items-center gap-1.5 rounded-lg border border-sky-600 bg-sky-900/30 px-2.5 py-1.5 text-xs md:text-sm font-medium text-sky-100 hover:bg-sky-800/50"
            title="Classification diagrams, norms, alteration, fertility and REE plots on chosen samples, with a written interpretation"
          >
            <svg aria-hidden viewBox="0 0 16 16" className="h-4 w-4" fill="currentColor"><path d="M8 1.5 14.5 13h-13z" fillOpacity="0.35" /><circle cx="6" cy="10" r="1.3" /><circle cx="9" cy="8" r="1.3" /><circle cx="10.5" cy="11" r="1.3" /></svg>
            Geochemistry
          </Link>
        )}
        {who && (
          <div className="order-last md:order-none w-full md:w-auto md:ml-auto shrink-0 md:self-start text-left md:text-right text-xs text-gray-400 flex flex-wrap items-baseline gap-x-3 gap-y-0 md:block">
            {who.role === "guest" ? (
              who.ended ? (
                <p className="text-amber-300">Your invitation has {who.ended === "expired" ? "expired" : "ended"}.</p>
              ) : (
                <>
                  <p className="text-gray-200">Welcome, {who.name}</p>
                  {typeof who.left === "number" && typeof who.limit === "number" && (
                    <p>
                      {who.left} of {who.limit} questions left today
                    </p>
                  )}
                  <p className="text-[11px] text-gray-500 w-full md:w-auto order-last md:order-none">Questions you ask are logged for the host.</p>
                </>
              )
            ) : (
              <span className="flex gap-3 md:justify-end">
                <Link href="/admin/activity" className="underline">
                  Activity
                </Link>
                <Link href="/admin/invites" className="underline">
                  Invitations
                </Link>
              </span>
            )}
            <button onClick={signOut} className="md:mt-1 md:block md:ml-auto ml-auto underline">
              Sign out
            </button>
          </div>
        )}
      </header>

      {/* 12-column split: left panel for reference/capability content (grows over time),
          right panel for the actual chat. Stacks on mobile, side-by-side from md up. */}
      <div className="flex shrink-0 gap-1 border-b border-gray-800 bg-gray-950 px-3 py-2 text-sm md:hidden">
        {(["chat", "explore"] as const).map((p) => (
          <button
            key={p}
            onClick={() => setPane(p)}
            className={"flex-1 rounded-md px-3 py-2 " + (pane === p ? "bg-gray-700 text-white" : "bg-gray-900 text-gray-400")}
          >
            {p === "chat" ? "Ask" : "Examples & history"}
          </button>
        ))}
      </div>
      <div className="flex-1 grid grid-cols-12 gap-0 overflow-hidden">
        <aside className={(pane === "explore" ? "block" : "hidden") + " md:block col-span-12 md:col-span-4 lg:col-span-3 border-b md:border-b-0 md:border-r border-gray-800 overflow-y-auto p-4"}>
          <div className="mb-4 flex gap-1 rounded-lg bg-gray-900 p-1 text-xs">
            {(["tools", "history"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={"flex-1 rounded-md px-2 py-1.5 " + (tab === t ? "bg-gray-700 text-white" : "text-gray-400 hover:text-gray-200")}
              >
                {t === "tools" ? "What can I ask?" : `History${history.length ? ` (${history.length})` : ""}`}
              </button>
            ))}
          </div>

          {tab === "history" && (
            <HistoryPanel
              items={history}
              activeId={activeId}
              busy={loading}
              onOpen={openConversation}
              onDelete={removeConversation}
              onRename={renameItem}
              onNew={newConversation}
              onBackup={backupAll}
              onImport={restoreFrom}
            />
          )}

          {tab === "tools" && (
          <>
          <div className="flex flex-wrap gap-1.5 mb-4">
            {domains.map((d) => (
              <button
                key={d}
                onClick={() => setSelectedDomain(d)}
                className={
                  "text-xs px-2.5 py-1 rounded-full border transition-colors " +
                  (d === selectedDomain
                    ? "bg-blue-600 border-blue-600 text-white"
                    : "border-gray-700 text-gray-300 hover:border-blue-500 hover:text-white")
                }
              >
                {d}
              </button>
            ))}
          </div>

          {snapCompanies.length > 0 && (
            <div className="mb-3 rounded-lg border border-blue-900 bg-gray-900 p-3">
              <div className="mb-1 flex items-center gap-2">
                <span className="text-lg">📄</span>
                <span className="text-sm font-medium text-gray-100">Company snapshot</span>
              </div>
              <p className="mb-2 text-xs text-gray-400">A shareable one-to-two page profile: financials, charts, price link, assets and sources. Print to PDF or send a link.</p>
              <div className="flex gap-2">
                <select
                  value={snapPick}
                  onChange={(e) => setSnapPick(e.target.value)}
                  className="min-w-0 flex-1 rounded border border-gray-700 bg-gray-950 px-2 py-1 text-xs text-gray-200"
                >
                  <option value="">Choose a company…</option>
                  {snapCompanies.map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name} ({c.years} yrs)
                    </option>
                  ))}
                </select>
                <button
                  disabled={!snapPick}
                  onClick={() => window.open(`/snapshot/${encodeURIComponent(snapPick)}`, "_blank")}
                  className="rounded border border-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-600 disabled:opacity-40"
                >
                  Open
                </button>
              </div>
            </div>
          )}

          <div className="flex flex-col gap-2">
            {visibleCapabilities.map((cap) => (
              <button
                key={cap.title}
                onClick={() => send(cap.prompt)}
                disabled={loading}
                className="text-left border border-gray-800 bg-gray-900 rounded-lg p-3 hover:border-blue-500 hover:bg-gray-800 transition-colors disabled:opacity-50"
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-lg">{cap.icon}</span>
                  <span className="font-medium text-sm text-gray-100">{cap.title}</span>
                </div>
                <p className="text-xs text-gray-400">{cap.description}</p>
              </button>
            ))}
          </div>
          </>
          )}
        </aside>

        <main className={(pane === "chat" ? "flex" : "hidden") + " md:flex col-span-12 md:col-span-8 lg:col-span-9 flex-col overflow-hidden min-w-0"}>
          {messages.length > 0 && (
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-gray-800 px-4 py-2 text-xs">
              <span className="truncate text-gray-400">{titleRef.current || titleFrom(messages)}</span>
              <div className="flex shrink-0 items-center gap-2">
                <button onClick={newConversation} disabled={loading} className="rounded border border-gray-700 px-2 py-1 text-gray-300 hover:border-blue-500 disabled:opacity-40">
                  ＋ New
                </button>
                <details className="relative">
                  <summary className={"cursor-pointer list-none rounded border border-gray-700 px-2 py-1 text-gray-300 hover:border-blue-500 " + (loading ? "pointer-events-none opacity-40" : "")}>Export ▾</summary>
                  <div className="absolute right-0 z-20 mt-1 w-44 rounded-lg border border-gray-700 bg-gray-900 py-1 shadow-lg">
                    <button
                      className="block w-full px-3 py-1.5 text-left text-gray-200 hover:bg-gray-800"
                      onClick={(e) => {
                        e.currentTarget.closest("details")?.removeAttribute("open");
                        exportMarkdown();
                      }}
                    >
                      Markdown (.md)
                    </button>
                    <button
                      className="block w-full px-3 py-1.5 text-left text-gray-200 hover:bg-gray-800"
                      onClick={(e) => {
                        e.currentTarget.closest("details")?.removeAttribute("open");
                        exportPdf();
                      }}
                    >
                      PDF / print…
                    </button>
                  </div>
                </details>
              </div>
            </div>
          )}
          <div className="flex-1 overflow-y-auto space-y-4 p-3 md:p-4">
            {messages.length === 0 && <IntroPanel />}
            {messages.map((m, i) => (
              <div key={i} className={m.role === "user" ? "text-right" : "text-left"}>
                {m.role === "user" ? (
                  <div className="inline-block rounded-lg px-3 py-2 max-w-[85%] whitespace-pre-wrap text-left text-sm bg-blue-600 text-white">
                    {m.content}
                  </div>
                ) : (
                  <CreditsCtx.Provider value={creditsOf(m)}>
                  <div className={(m.datasets?.length || m.maps?.length ? "block w-full" : "inline-block max-w-full") + " rounded-lg px-3 py-2 text-sm bg-gray-800 text-gray-100"}>
                    <Steps steps={m.steps ?? []} streaming={!!m.streaming} />
                    {m.streaming && !m.content && (m.steps ?? []).every((s) => s.status !== "running") && (
                      <div className="text-xs text-gray-500">Thinking…</div>
                    )}
                    {m.content && (
                      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                        {m.content}
                      </ReactMarkdown>
                    )}
                    {m.datasets?.map((d) => (
                      <DatasetView key={d.id} ds={d} credits={creditsOf(m)} />
                    ))}
                    {m.maps?.map((mp) => (
                      <MapView key={mp.id} map={mp} credits={creditsOf(m)} />
                    ))}
                    {!m.streaming && <Sources evidence={m.evidence ?? []} />}
                    {m.stopped && <p className="mt-1 text-xs italic text-gray-500">Stopped.</p>}
                    {m.notice && <p className="mt-1 text-xs italic text-amber-500">{m.notice}</p>}
                    {!m.streaming && m.answerId && <ShareAnswer key={`sh-${i}`} answerId={m.answerId} />}
                    {!m.streaming && m.content.trim() && i > 0 && messages[i - 1]?.role === "user" && (
                      <FeedbackBar
                        key={`fb-${i}`}
                        question={messages[i - 1].content}
                        answer={m.content}
                        saved={!!m.notice?.startsWith("Saved answer")}
                        value={m.feedback}
                        onChange={(f) => rate(i, f)}
                      />
                    )}
                    {m.images?.map((img, j) => (
                      <div key={j} className="mt-2">
                        <img
                          src={`data:${img.mimeType};base64,${img.base64}`}
                          alt={img.caption}
                          className="rounded border border-gray-700 max-w-full"
                        />
                        <p className="text-xs text-gray-500 mt-1">{img.caption}</p>
                      </div>
                    ))}
                  </div>
                  </CreditsCtx.Provider>
                )}
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
          <div className="flex gap-2 border-t border-gray-800 p-3 md:p-4 shrink-0 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            <input
              className="flex-1 border border-gray-700 bg-gray-900 text-gray-100 placeholder-gray-500 rounded-lg px-3 py-2 text-base md:text-sm min-w-0 focus:outline-none focus:border-blue-500"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && send()}
              placeholder="Ask a question…"
              disabled={loading}
            />
            {loading ? (
              <button
                className="bg-gray-700 hover:bg-gray-600 text-white rounded-lg px-4 py-2 text-sm transition-colors"
                onClick={stop}
              >
                Stop
              </button>
            ) : (
              <button
                className="bg-blue-600 hover:bg-blue-700 text-white rounded-lg px-4 py-2 text-sm disabled:opacity-50 transition-colors"
                onClick={() => send()}
                disabled={!input.trim()}
              >
                Send
              </button>
            )}
          </div>
        </main>
      </div>
      {toast && <div className="fixed bottom-4 right-4 z-50 rounded-lg border border-gray-700 bg-gray-800 px-4 py-2 text-sm text-gray-100 shadow-lg">{toast}</div>}
    </div>
    {printConv && (
      <div className="hidden print:block">
        <PrintView conv={printConv} />
      </div>
    )}
    </>
  );
}
