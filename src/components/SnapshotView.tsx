import type { Snapshot } from "@/lib/snapshot";
import { chartSvgString } from "@/lib/chart";

// Light, print-first rendering of one company snapshot. Used by both the signed-in page and the shared-link page.

const fmtCell = (v: number | null, kind: "usd" | "pct" | "x") => {
  if (v === null) return "–";
  if (kind === "pct") return `${(v * 100).toFixed(1)}%`;
  if (kind === "x") return `${v.toFixed(1)}x`;
  return Math.abs(v) >= 100 ? v.toLocaleString("en-US", { maximumFractionDigits: 0 }) : v.toLocaleString("en-US", { maximumFractionDigits: 1 });
};

const strengthClass: Record<string, string> = {
  strong: "bg-green-100 text-green-800",
  moderate: "bg-amber-100 text-amber-800",
  "weak or none": "bg-gray-200 text-gray-700",
};

function H({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-1 mt-5 break-after-avoid border-b border-gray-300 pb-0.5 text-[11px] font-semibold uppercase tracking-wider text-gray-500">{children}</h2>;
}

export function SnapshotView({ s, sharedUntil }: { s: Snapshot; sharedUntil?: string }) {
  const c = s.company;
  const sub = [c.ticker && c.exchange ? `${c.ticker} · ${c.exchange}` : c.ticker ?? c.exchange, c.hq, c.type && c.stage ? `${c.type}, ${c.stage}` : c.type ?? c.stage].filter(Boolean).join("  |  ");
  return (
    <article className="mx-auto max-w-[820px] bg-white p-4 md:p-8 text-[13px] leading-relaxed text-gray-900 print:max-w-none print:p-0 print:text-[11px] print:leading-snug">
      <style>{"@media print{@page{size:A4;margin:12mm}html,body{background:#fff !important;color:#000}}"}</style>
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-2 md:gap-4 border-b-2 border-gray-900 pb-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{c.name}</h1>
          <p className="text-xs text-gray-600">{sub}</p>
          {c.peers.length > 0 && <p className="text-[11px] text-gray-500">Peer groups: {c.peers.join(", ")}</p>}
        </div>
        <div className="md:text-right text-[11px] text-gray-500">
          <div className="font-semibold text-gray-700">Interzona · Company snapshot</div>
          <div>Fiscal {s.latestYear} (year end {s.latestPeriodEnd})</div>
          <div>Generated {s.generated}</div>
          {sharedUntil && <div>Shared link valid until {sharedUntil}</div>}
        </div>
      </header>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5 print:grid-cols-5">
        {s.headline.map((h) => (
          <div key={h.label} className="break-inside-avoid rounded border border-gray-300 px-2 py-1.5">
            <div className="text-[10px] uppercase tracking-wide text-gray-500">{h.label}</div>
            <div className="text-base font-semibold">{h.value}</div>
            {h.sub && <div className="text-[10px] text-gray-600">{h.sub}</div>}
          </div>
        ))}
      </div>

      <H>At a glance</H>
      <ul className="list-disc pl-5">
        {s.bullets.map((b, i) => (
          <li key={i}>{b}</li>
        ))}
      </ul>

      {s.charts.length > 0 && (
        <>
          <H>Charts</H>
          <div className="grid gap-3 sm:grid-cols-2 print:grid-cols-2">
            {s.charts.map((ch) => (
              <div key={ch.title} className="break-inside-avoid" dangerouslySetInnerHTML={{ __html: chartSvgString(ch.chart, ch.title) }} />
            ))}
          </div>
        </>
      )}

      <H>Financial history (US$ millions unless stated)</H>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[11px]">
          <thead>
            <tr className="bg-gray-100">
              <th className="border border-gray-300 px-1.5 py-0.5 text-left font-semibold">Fiscal year</th>
              {s.history.years.map((y) => (
                <th key={y} className="border border-gray-300 px-1.5 py-0.5 text-right font-semibold">{y}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {s.history.rows.map((r) => (
              <tr key={r.label}>
                <td className="border border-gray-300 px-1.5 py-0.5">{r.label}</td>
                {r.values.map((v, i) => (
                  <td key={i} className={"border border-gray-300 px-1.5 py-0.5 text-right tabular-nums " + (v !== null && v < 0 && r.kind === "usd" ? "text-red-700" : "")}>{fmtCell(v, r.kind)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {s.priceLink && (
        <>
          <H>Link to commodity price</H>
          <div className="break-inside-avoid rounded border border-gray-300 px-3 py-2">
            <p>
              Revenue against the {s.priceLink.commodity} ({s.priceLink.priceUnit}), {s.priceLink.years}:{" "}
              <span className={"rounded px-1.5 py-0.5 text-[11px] font-semibold " + (strengthClass[s.priceLink.strength] ?? "bg-gray-200")}>{s.priceLink.strength} fit</span>
              {s.priceLink.rSquared !== null && <> (R² {s.priceLink.rSquared})</>}
              {s.priceLink.elasticity !== null && <>; a 1% price change has gone with about a {s.priceLink.elasticity}% change in revenue.</>}
            </p>
            <p className="text-[11px] text-gray-600">{s.priceLink.meaning}.</p>
            {s.priceLink.warning && <p className="text-[11px] italic text-gray-600">{s.priceLink.warning}</p>}
            <p className="text-[10px] text-gray-500">A historical association over a small number of years, not a forecast and not proof that price caused the change. {s.priceLink.note}</p>
          </div>
        </>
      )}

      {s.operating.length > 0 && (
        <>
          <H>Operating highlights (company-reported)</H>
          <div className="break-inside-avoid overflow-x-auto">
          <table className="w-full min-w-[480px] border-collapse text-[11px]">
            <thead>
              <tr className="bg-gray-100">
                {["Product / asset", "Measure", "Year", "Value", "Basis"].map((h) => (
                  <th key={h} className="border border-gray-300 px-1.5 py-0.5 text-left font-semibold">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {s.operating.map((o, i) => (
                <tr key={i} className="break-inside-avoid">
                  <td className="border border-gray-300 px-1.5 py-0.5">{[o.commodity, o.asset].filter(Boolean).join(" · ")}</td>
                  <td className="border border-gray-300 px-1.5 py-0.5">{o.metric}</td>
                  <td className="border border-gray-300 px-1.5 py-0.5">{o.year}</td>
                  <td className="border border-gray-300 px-1.5 py-0.5 text-right tabular-nums">{o.value.toLocaleString("en-US", { maximumFractionDigits: 2 })} {o.unit}</td>
                  <td className="border border-gray-300 px-1.5 py-0.5 text-gray-600">{o.basis ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </>
      )}

      {s.assets.length > 0 && (
        <>
          <H>Assets and ownership</H>
          <div className="break-inside-avoid overflow-x-auto">
          <table className="w-full min-w-[480px] border-collapse text-[11px]">
            <thead>
              <tr className="bg-gray-100">
                {["Project", "Commodity", "Country", "Status", "Interest"].map((h) => (
                  <th key={h} className="border border-gray-300 px-1.5 py-0.5 text-left font-semibold">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {s.assets.map((a, i) => (
                <tr key={i} className="break-inside-avoid">
                  <td className="border border-gray-300 px-1.5 py-0.5">{a.project}</td>
                  <td className="border border-gray-300 px-1.5 py-0.5">{a.commodity ?? ""}</td>
                  <td className="border border-gray-300 px-1.5 py-0.5">{a.country ?? ""}</td>
                  <td className="border border-gray-300 px-1.5 py-0.5">{a.status ?? ""}</td>
                  <td className="border border-gray-300 px-1.5 py-0.5">{a.share !== null ? `${a.share}%` : "n/a"}{a.asOf ? ` (${a.asOf})` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {s.assetsMore > 0 && <p className="mt-0.5 text-[10px] text-gray-500">…and {s.assetsMore} more interests (largest holdings shown).</p>}
          </div>
        </>
      )}

      {s.documents.length > 0 && (
        <>
          <H>Source documents held</H>
          <ul className="list-disc pl-5 text-[11px] text-gray-700">
            {s.documents.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        </>
      )}

      <H>Notes and sources</H>
      <ul className="list-disc pl-5 text-[10.5px] text-gray-600">
        {s.notes.map((n, i) => (
          <li key={i}>{n}</li>
        ))}
        <li>Sources: company annual reports and filings held in the Interzona library; Bank for International Settlements exchange rates; World Bank, IMF and USGS commodity prices where a price link is shown.</li>
      </ul>
      <p className="mt-4 border-t border-gray-300 pt-2 text-[10px] text-gray-500">
        Built automatically from stored data with no generated commentary; check important figures against the filings listed. Not investment advice.
      </p>
    </article>
  );
}
