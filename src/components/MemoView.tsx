import type { Memo } from "@/lib/memo";
import { MemoMap } from "@/components/MemoMap";

// Light, print-first rendering of an investor memo. Used by the signed-in page and the shared-link page.

const STATUS_WORD: Record<string, string> = {
  PRODUCER: "Producing",
  PAST_PRODUCER: "Past producing",
  DEVELOPMENT: "Development",
  FEASIBILITY: "Feasibility",
  EXPLORATION: "Exploration",
  PROSPECT: "Prospect",
  OCCURRENCE: "Occurrence",
  CARE_AND_MAINTENANCE: "Care and maintenance",
  CLOSED: "Closed",
  UNKNOWN: "Status not stated",
};
const word = (s: string | null) => (s ? (STATUS_WORD[s] ?? s.replace(/_/g, " ").toLowerCase()) : "");

function H({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-1 mt-6 break-after-avoid border-b border-gray-300 pb-0.5 text-[11px] font-semibold uppercase tracking-wider text-gray-500">{children}</h2>;
}
const th = "border-b border-gray-300 px-1.5 py-1 text-left font-medium text-gray-600";
const td = "border-b border-gray-100 px-1.5 py-1 align-top";

export function MemoView({ m, sharedUntil }: { m: Memo; sharedUntil?: string }) {
  const credits = m.sources.data;
  return (
    <article className="mx-auto max-w-[820px] bg-white p-4 md:p-8 text-[13px] leading-relaxed text-gray-900 print:max-w-none print:p-0 print:text-[11px] print:leading-snug">
      <style>{"@media print{@page{size:A4;margin:12mm}html,body{background:#fff !important;color:#000}}"}</style>
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-2 md:gap-4 border-b-2 border-gray-900 pb-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{m.title}</h1>
          <p className="text-xs text-gray-600">{m.subtitle}</p>
        </div>
        <div className="md:text-right text-[11px] text-gray-500">
          <div className="font-semibold text-gray-700">Interzona · Investor memo</div>
          <div>Built {m.generated}</div>
          {sharedUntil && <div>Shared link valid until {sharedUntil}</div>}
        </div>
      </header>

      <H>Key points</H>
      <ul className="list-disc space-y-1 pl-5">
        {m.keyPoints.map((k) => (
          <li key={k}>{k}</li>
        ))}
      </ul>

      {m.leads && (
        <>
          <H>Geochemical leads: {m.leads.indicator}</H>
          <p className="text-gray-600">{m.leads.basisNote}</p>
          {m.leads.note && <p className="mt-1 text-gray-600">{m.leads.note}</p>}
          {m.leads.rows.length > 0 && (
            <div className="overflow-x-auto"><table className="mt-2 w-full min-w-[560px] border-collapse text-[12px] print:text-[10px]">
              <thead>
                <tr>
                  <th className={th}>#</th>
                  <th className={th}>Area</th>
                  <th className={th}>Anomalous / analysed</th>
                  <th className={th}>Highest (ppm)</th>
                  <th className={th}>Sample types</th>
                  <th className={th}>Nearest catalogued occurrence</th>
                </tr>
              </thead>
              <tbody>
                {m.leads.rows.map((r, i) => (
                  <tr key={i}>
                    <td className={td}>{i + 1}</td>
                    <td className={td}>{r.area}</td>
                    <td className={td}>
                      {r.anomalous} / {r.analysed}
                    </td>
                    <td className={td}>{r.highest ?? "–"}</td>
                    <td className={td}>{r.types}</td>
                    <td className={td}>{r.nearest ? `${r.nearest}, ${r.km} km` : "none within range"}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
          {m.leads.map && <MemoMap map={m.leads.map} credits={credits} />}
        </>
      )}

      <H>Deposit-type signature of the enriched rocks</H>
      {m.fingerprint ? (
        <>
          <p className="text-gray-600">
            {m.fingerprint.nLead} rock samples ({m.fingerprint.filter}) from {m.fingerprint.survey}, compared with {m.fingerprint.nBackground} background rock samples from the same survey and with about 1,250 known deposits in {m.fingerprint.accuracy.types}{" "}
            deposit groups (Geoscience Australia / Critical Minerals Mapping Initiative). Each sample is assigned to the type its chemistry is closest to; the difference from the background is the signal.
          </p>
          <div className="mt-2 space-y-1.5">
            {m.fingerprint.ranked.map((r) => (
              <div key={r.type}>
                <div className="flex justify-between text-[12px]">
                  <span>
                    {r.type}
                    {r.small ? <span className="text-gray-500"> (small reference group: {r.deposits} deposits)</span> : ""}
                  </span>
                  <span className="text-gray-600">
                    {r.lead}% vs background {r.background}% ({r.difference >= 0 ? "+" : ""}
                    {r.difference} points)
                  </span>
                </div>
                <div className="mt-0.5 h-2 rounded bg-gray-100">
                  <div className="h-2 rounded bg-blue-500" style={{ width: `${Math.min(100, r.lead)}%` }} />
                </div>
                <div className="mt-0.5 h-1.5 rounded bg-gray-100">
                  <div className="h-1.5 rounded bg-gray-400" style={{ width: `${Math.min(100, r.background)}%` }} />
                </div>
              </div>
            ))}
          </div>
          <p className="mt-1 text-[11px] text-gray-500">
            <span className="text-blue-600">▬</span> Enriched samples <span className="text-gray-500">▬</span> Regional background
          </p>
          {m.fingerprint.drivers.length > 0 && (
            <p className="mt-2">
              <span className="font-medium">Elements behind the match:</span>{" "}
              {m.fingerprint.drivers.map((d) => `${d.element} ${d.fold >= 1 ? `${d.fold}× background` : `${d.fold}× (below background)`}${d.towards ? "" : " (does not point to this type)"}`).join("; ")}.
            </p>
          )}
          <p className="mt-1 text-gray-600">
            Reliability: on known deposits, using these {m.fingerprint.elements.length} elements ({m.fingerprint.elements.join(", ")}), the first guess is right about {Math.round(m.fingerprint.accuracy.first)}% of the time and the right type is among the first three about{" "}
            {Math.round(m.fingerprint.accuracy.topThree)}% (chance: about {Math.round(m.fingerprint.accuracy.chance)}%). A screening hint, not proof.
          </p>
        </>
      ) : (
        <p className="text-gray-600">{m.fingerprintNote ?? "Not available for this case."}</p>
      )}

      {m.occurrences && (
        <>
          <H>Catalogued {m.occurrences.label}</H>
          <p>
            {m.occurrences.total.toLocaleString("en-US")} in the catalogue:{" "}
            {m.occurrences.byStatus.map((s) => `${word(s.status)} ${s.n.toLocaleString("en-US")}`).join(", ")}.
          </p>
          {m.occurrences.named.length > 0 && (
            <p className="mt-1 text-gray-600">
              Examples, most advanced first: {m.occurrences.named.map((n) => `${n.name} (${word(n.status).toLowerCase()})`).join("; ")}.
            </p>
          )}
        </>
      )}

      {m.holders && (
        <>
          <H>Who holds the projects</H>
          <div className="overflow-x-auto"><table className="w-full min-w-[520px] border-collapse text-[12px] print:text-[10px]">
            <thead>
              <tr>
                <th className={th}>Asset</th>
                <th className={th}>Company</th>
                <th className={th}>Interest</th>
                <th className={th}>Stage</th>
                <th className={th}>Recorded owners</th>
              </tr>
            </thead>
            <tbody>
              {m.holders.rows.map((r, i) => (
                <tr key={i}>
                  <td className={td}>{r.asset}</td>
                  <td className={td}>{r.company}</td>
                  <td className={td}>{r.interest !== null ? `${r.interest}%` : "not stated"}</td>
                  <td className={td}>{word(r.status)}</td>
                  <td className={td}>{r.owners}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
          {m.holders.unplaced > 0 && <p className="mt-1 text-[11px] text-gray-500">{m.holders.unplaced} assets could not be placed on a map.</p>}
          {m.holders.map && <MemoMap map={m.holders.map} credits={credits} />}
        </>
      )}

      {m.prices && (
        <>
          <H>Price context</H>
          <p className="text-[11px] text-gray-500">{m.prices.title}</p>
          <div className="overflow-x-auto"><table className="mt-1 border-collapse text-[12px] print:text-[10px]">
            <thead>
              <tr>
                {m.prices.columns.map((c) => (
                  <th key={c} className={th}>
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {m.prices.rows.map((r, i) => (
                <tr key={i}>
                  {r.map((v, j) => (
                    <td key={j} className={td}>
                      {v === null ? "" : typeof v === "number" ? v.toLocaleString("en-US") : /^\d{4}-\d{2}-\d{2}/.test(String(v)) ? String(v).slice(0, 4) : String(v)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table></div>
        </>
      )}

      {(m.context ?? []).some((t) => t.items.length > 0) && (
        <>
          <H>Project status, permitting and finance</H>
          <p className="text-[11px] text-gray-500">
            Quoted from our document library, by topic. The documents are of different dates (see each title) and project status changes quickly, so check these against current announcements. The memo does not assess or value any project.
          </p>
          <div className="mt-1 space-y-3">
            {(m.context ?? [])
              .filter((t) => t.items.length > 0)
              .map((t) => (
                <div key={t.topic}>
                  <p className="font-medium text-gray-800">{t.topic}</p>
                  <div className="space-y-2">
                    {t.items.map((i, k) => (
                      <blockquote key={t.topic + k} className="border-l-2 border-gray-300 pl-3">
                        <p className="text-gray-800">“{i.excerpt}”</p>
                        <p className="text-[11px] text-gray-500">
                          {i.title}
                          {i.page ? `, p. ${i.page}` : ""}
                        </p>
                      </blockquote>
                    ))}
                  </div>
                </div>
              ))}
          </div>
        </>
      )}

      {m.literature.some((l) => l.items.length > 0) && (
        <>
          <H>What the literature says</H>
          <p className="text-[11px] text-gray-500">Short passages from our document library, each with its source. They are quoted, not summarised.</p>
          <div className="mt-1 space-y-2">
            {m.literature.flatMap((l) =>
              l.items.map((i, k) => (
                <blockquote key={l.query + k} className="border-l-2 border-gray-300 pl-3">
                  <p className="text-gray-800">“{i.excerpt}”</p>
                  <p className="text-[11px] text-gray-500">
                    {i.title}
                    {i.page ? `, p. ${i.page}` : ""}
                  </p>
                </blockquote>
              ))
            )}
          </div>
        </>
      )}

      <H>What we don&apos;t know</H>
      <ul className="list-disc space-y-1 pl-5 text-gray-700">
        {m.unknowns.map((u) => (
          <li key={u}>{u}</li>
        ))}
      </ul>

      <H>Sources and credits</H>
      <ul className="list-disc space-y-0.5 pl-5 text-[11px] text-gray-600">
        {m.sources.data.map((d) => (
          <li key={d}>{d}</li>
        ))}
        {m.sources.documents.map((d) => (
          <li key={d.title}>
            {d.title}
            {d.pages.length ? `, p. ${d.pages.join(", ")}` : ""}
          </li>
        ))}
      </ul>
      <p className="mt-4 border-t border-gray-300 pt-2 text-[11px] text-gray-500">{m.disclaimer}</p>
    </article>
  );
}
