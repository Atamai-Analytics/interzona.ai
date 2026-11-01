import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Dataset, Evidence } from "@/lib/types";
import type { SharedAnswer } from "@/lib/shared-answers";
import { chartSvgString } from "@/lib/chart";
import { MemoMap } from "@/components/MemoMap";

// Light, print-first page for a shared answer: the question, the answer as it was given, its tables, charts and maps, and the sources. Read-only.

const th = "border-b border-gray-300 px-1.5 py-1 text-left font-medium text-gray-600";
const td = "border-b border-gray-100 px-1.5 py-1 align-top";

function Bars({ bars }: { bars: NonNullable<Dataset["bars"]> }) {
  const max = Math.max(1, ...bars.items.flatMap((i) => [i.value, i.compare ?? 0]));
  return (
    <div className="my-2 break-inside-avoid">
      <p className="mb-1 text-[11px] text-gray-500">({bars.unit})</p>
      <div className="space-y-1.5">
        {bars.items.map((i) => (
          <div key={i.label}>
            <div className="flex justify-between text-[12px]">
              <span>{i.label}</span>
              <span className="text-gray-600">
                {i.value}
                {i.compare !== undefined ? ` · ${i.compare}` : ""}
              </span>
            </div>
            <div className="mt-0.5 h-2 rounded bg-gray-100">
              <div className="h-2 rounded bg-blue-500" style={{ width: `${Math.max(0, Math.min(100, (i.value / max) * 100))}%` }} />
            </div>
            {i.compare !== undefined && (
              <div className="mt-0.5 h-1.5 rounded bg-gray-100">
                <div className="h-1.5 rounded bg-gray-400" style={{ width: `${Math.max(0, Math.min(100, (i.compare / max) * 100))}%` }} />
              </div>
            )}
          </div>
        ))}
      </div>
      <p className="mt-1 text-[11px] text-gray-500">
        <span className="text-blue-600">▬</span> {bars.legend[0]}
        {bars.legend[1] && (
          <>
            {" "}
            <span className="text-gray-500">▬</span> {bars.legend[1]}
          </>
        )}
      </p>
    </div>
  );
}

function Table({ ds, cut }: { ds: Dataset; cut: boolean }) {
  const shown = ds.rows.slice(0, 50);
  return (
    <div className="my-3">
      <p className="text-[11px] font-medium text-gray-600">{ds.title}</p>
      {ds.chart && <div dangerouslySetInnerHTML={{ __html: chartSvgString(ds.chart, ds.title) }} />}
      {ds.bars && <Bars bars={ds.bars} />}
      {!ds.chart && (
        <div className="overflow-x-auto">
          <table className="mt-1 w-full border-collapse text-[12px] print:text-[10px]">
            <thead>
              <tr>
                {ds.columns.map((c) => (
                  <th key={c} className={th}>
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((r, i) => (
                <tr key={i}>
                  {r.map((v, j) => (
                    <td key={j} className={td}>
                      {v === null ? "" : typeof v === "number" ? v.toLocaleString("en-US", { maximumFractionDigits: 4 }) : String(v)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!ds.chart && ds.rows.length > shown.length && (
        <p className="mt-1 text-[11px] text-gray-500">
          First {shown.length} of {cut ? `at least ${ds.rows.length}` : ds.rows.length} rows shown.
        </p>
      )}
    </div>
  );
}

function Sources({ evidence }: { evidence: Evidence[] }) {
  const docs = new Map<string, number[]>();
  const web: Extract<Evidence, { kind: "web" }>[] = [];
  const data: string[] = [];
  for (const e of evidence) {
    if (e.kind === "document") {
      const p = docs.get(e.title) ?? [];
      if (e.page !== undefined && !p.includes(e.page)) p.push(e.page);
      docs.set(e.title, p);
    } else if (e.kind === "web") web.push(e);
    else data.push(e.detail ? `${e.label} (${e.detail})` : e.label);
  }
  if (!docs.size && !web.length && !data.length) return null;
  return (
    <>
      <h2 className="mb-1 mt-6 border-b border-gray-300 pb-0.5 text-[11px] font-semibold uppercase tracking-wider text-gray-500">Sources and credits</h2>
      <ul className="list-disc space-y-0.5 pl-5 text-[11px] text-gray-600">
        {[...new Set(data)].map((d) => (
          <li key={d}>{d}</li>
        ))}
        {[...docs.entries()].map(([t, p]) => (
          <li key={t}>
            {t}
            {p.length ? `, p. ${p.sort((a, b) => a - b).join(", ")}` : ""}
          </li>
        ))}
        {web.map((w) => (
          <li key={w.url}>
            Web: {w.title} ({w.url})
          </li>
        ))}
      </ul>
    </>
  );
}

// The publishers behind the answer, shown under each map and repeated in the sources.
const creditsOf = (a: SharedAnswer) => a.evidence.filter((e): e is Extract<Evidence, { kind: "data" }> => e.kind === "data").map((e) => e.label);

export function AnswerView({ a }: { a: SharedAnswer }) {
  const made = new Date(a.created * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  const credits = creditsOf(a);
  return (
    <article className="mx-auto max-w-[820px] bg-white p-4 md:p-8 text-[13px] leading-relaxed text-gray-900 print:max-w-none print:p-0 print:text-[11px] print:leading-snug">
      <style>{"@media print{@page{size:A4;margin:12mm}html,body{background:#fff !important;color:#000}}"}</style>
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-2 md:gap-4 border-b-2 border-gray-900 pb-2">
        <h1 className="text-xl font-semibold tracking-tight">Shared answer</h1>
        <div className="md:text-right text-[11px] text-gray-500">
          <div className="font-semibold text-gray-700">Interzona · Critical Minerals AI Assistant</div>
          <div>Answered {made}</div>
          {a.sharedUntil && <div>Shared link valid until {a.sharedUntil}</div>}
        </div>
      </header>

      <div className="mt-4 rounded border border-gray-300 bg-gray-50 px-3 py-2">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Question</div>
        <div className="whitespace-pre-wrap">{a.question}</div>
      </div>

      <div className="mt-3 [&_h1]:mb-1 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mt-3 [&_h2]:font-semibold [&_h3]:mt-2 [&_h3]:font-semibold [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:mb-2 [&_table]:my-2 [&_table]:border-collapse [&_td]:border [&_td]:border-gray-300 [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-gray-300 [&_th]:bg-gray-100 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_ul]:list-disc [&_ul]:pl-5">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Answer</div>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{a.text}</ReactMarkdown>
      </div>

      {a.datasets.map((d) => (
        <Table key={d.id} ds={d} cut={a.rowsCut} />
      ))}
      {a.maps.map((m) => (
        <div key={m.id} className="my-3">
          <MemoMap map={m} credits={credits} />
        </div>
      ))}
      {a.images.map((img, j) => (
        <div key={j} className="my-3 break-inside-avoid">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`data:${img.mimeType};base64,${img.base64}`} alt={img.caption} className="max-w-full border border-gray-300" />
          <div className="text-[11px] text-gray-500">{img.caption}</div>
        </div>
      ))}
      {a.imagesLeftOut && <p className="text-[11px] italic text-gray-500">Charts drawn in the chat are not included in this copy.</p>}
      {a.notice && <p className="mt-2 text-xs italic text-gray-600">{a.notice}</p>}
      <Sources evidence={a.evidence} />
      <p className="mt-6 border-t border-gray-300 pt-2 text-[11px] text-gray-500">
        This is one question and answer from an AI assistant, copied as it was given on {made}; the rest of the conversation is not included. It is built from stored datasets and documents and is not advice: check important figures against the sources listed.
      </p>
    </article>
  );
}
