"use client";

import { useEffect, useMemo, useState } from "react";
import type { ActivityDay, ActivityEvent } from "@/lib/activity";

// The owner's Activity page: questions per day, who is using the app, the latest questions (owner included), tools, problems and
// Multivariate tools loads. Reads /api/admin/activity (owner only).

type InviteRow = { id: string; name: string; status: "active" | "expired" | "revoked"; dailyLimit: number; expires: number; stats: { questions: number; units: number; lastSeen: number | null; up: number; down: number } };
type Data = { days: ActivityDay[]; tools: { name: string; count: number }[]; recent: ActivityEvent[]; invites: InviteRow[]; feedback: { up: number; down: number } };

const when = (s: number) => new Date(s * 1000).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
const ago = (s: number | null) => {
  if (!s) return "never";
  const d = Math.floor(Date.now() / 1000) - s;
  return d < 3600 ? `${Math.max(1, Math.round(d / 60))} min ago` : d < 86400 ? `${Math.round(d / 3600)} h ago` : `${Math.round(d / 86400)} days ago`;
};
const n = (v: number) => v.toLocaleString("en-US");
const OUTCOME: Record<string, string> = {
  error: "error", step_budget: "ran out of steps", stopped: "stopped by the user", daily_limit: "daily limit reached", too_fast: "asked too quickly",
  capacity: "app at capacity", busy: "previous question still running", invite_ended: "invitation ended",
};
const COLORS = { owner: "#60a5fa", guest: "#34d399", test: "#6b7280" };

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-3">
      <p className="text-xs text-gray-500">{label}</p>
      <p className="mt-0.5 text-xl font-semibold text-gray-100">{value}</p>
      {sub && <p className="text-xs text-gray-500">{sub}</p>}
    </div>
  );
}

function DailyChart({ days }: { days: ActivityDay[] }) {
  const max = Math.max(1, ...days.map((d) => d.questions + d.refused));
  const W = 720, H = 180, pad = { l: 28, b: 22, t: 8 };
  const bw = (W - pad.l) / days.length;
  const sy = (v: number) => ((H - pad.b - pad.t) * v) / max;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Questions per day">
      {[...new Set([0, Math.round(max / 2), max])].map((v) => (
        <g key={v}>
          <line x1={pad.l} x2={W} y1={H - pad.b - sy(v)} y2={H - pad.b - sy(v)} stroke="#1f2937" />
          <text x={pad.l - 4} y={H - pad.b - sy(v) + 3} fontSize={9} textAnchor="end" fill="#6b7280">{v}</text>
        </g>
      ))}
      {days.map((d, i) => {
        let y = H - pad.b;
        const parts: [number, string][] = [[d.owner, COLORS.owner], [d.guest, COLORS.guest], [d.test, COLORS.test], [d.refused, "#f59e0b"]];
        return (
          <g key={d.day}>
            <title>{`${d.day}: ${d.questions} questions (you ${d.owner}, guests ${d.guest}, tests ${d.test}); ${d.refused} refused; ${d.errors} with problems; ${d.multivariate} Multivariate loads`}</title>
            {parts.map(([v, c], k) => {
              if (!v) return null;
              const h = sy(v);
              y -= h;
              return <rect key={k} x={pad.l + i * bw + 1} y={y} width={bw - 2} height={h} fill={c} />;
            })}
            {d.errors > 0 && <circle cx={pad.l + i * bw + bw / 2} cy={H - pad.b - sy(d.questions + d.refused) - 6} r={3} fill="#ef4444" />}
            {i % 5 === 0 && <text x={pad.l + i * bw + bw / 2} y={H - 6} fontSize={9} textAnchor="middle" fill="#6b7280">{d.day.slice(5)}</text>}
          </g>
        );
      })}
    </svg>
  );
}

export function ActivityAdmin() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<"all" | "questions" | "problems" | "multivariate">("all");
  const [who, setWho] = useState<"all" | "owner" | "guest" | "test">("all");

  useEffect(() => {
    fetch("/api/admin/activity", { cache: "no-store" })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error((d as { error?: string }).error ?? `Request failed (${r.status})`);
        setData(d as Data);
      })
      .catch((e) => setError((e as Error).message));
  }, []);

  const events = useMemo(
    () =>
      (data?.recent ?? []).filter(
        (e) =>
          (who === "all" || e.who.role === who) &&
          (kind === "all" ||
            (kind === "questions" && e.kind === "question") ||
            (kind === "multivariate" && e.kind === "multivariate_load") ||
            (kind === "problems" && (e.kind === "refused" || (e.kind === "question" && e.outcome && e.outcome !== "answered"))))
      ),
    [data, kind, who]
  );

  if (error) return <p className="rounded-md border border-red-800 bg-red-950/40 p-3 text-sm text-red-300">{error}</p>;
  if (!data) return <p className="text-sm text-gray-500">Loading…</p>;

  const last = (k: number) => data.days.slice(-k);
  const sum = (ds: ActivityDay[], f: keyof ActivityDay) => ds.reduce((a, d) => a + (d[f] as number), 0);
  const weekAgo = Math.floor(Date.now() / 1000) - 7 * 86400;
  const activeGuests = data.invites.filter((i) => i.status === "active" && (i.stats.lastSeen ?? 0) >= weekAgo).length;
  const toolMax = Math.max(1, ...data.tools.map((t) => t.count));
  const firstDay = data.days.find((d) => d.questions + d.refused + d.multivariate > 0)?.day;

  return (
    <div className="space-y-8">
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Questions, last 7 days" value={n(sum(last(7), "questions"))} sub={`${n(sum(last(7), "guest"))} from guests`} />
        <Stat label="Questions, last 30 days" value={n(sum(data.days, "questions"))} sub={`you ${n(sum(data.days, "owner"))} · guests ${n(sum(data.days, "guest"))} · tests ${n(sum(data.days, "test"))}`} />
        <Stat label="Guests active this week" value={String(activeGuests)} sub={`${data.invites.filter((i) => i.status === "active").length} active invitations`} />
        <Stat label="Feedback (all time)" value={`👍 ${data.feedback.up} · 👎 ${data.feedback.down}`} />
        <Stat label="Problems, last 30 days" value={n(sum(data.days, "errors"))} sub="errors or ran out of steps" />
        <Stat label="Refused, last 30 days" value={n(sum(data.days, "refused"))} sub="limits reached, invitation ended" />
        <Stat label="Multivariate loads, 30 days" value={n(sum(data.days, "multivariate"))} sub="database extracts" />
        <Stat label="Usage units, 30 days" value={n(sum(data.days, "units"))} sub="same units as Invitations" />
      </section>

      <section>
        <h2 className="mb-1 text-sm font-semibold">Questions per day (last 30 days)</h2>
        <p className="mb-2 text-xs text-gray-500">
          <span style={{ color: COLORS.owner }}>■</span> you <span className="ml-2" style={{ color: COLORS.guest }}>■</span> guests <span className="ml-2" style={{ color: COLORS.test }}>■</span> automated tests{" "}
          <span className="ml-2 text-amber-500">■</span> refused <span className="ml-2 text-red-500">●</span> a day with problems. Hover a bar for details.
          {firstDay ? ` Recording started ${firstDay}.` : " Recording has just started; days before it show nothing."}
        </p>
        <div className="rounded-lg border border-gray-800 bg-gray-900/40 p-2">
          <DailyChart days={data.days} />
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold">Guests</h2>
        {data.invites.length === 0 ? (
          <p className="text-sm text-gray-500">No invitations yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-gray-800">
            <table className="min-w-full text-xs">
              <thead className="bg-gray-900 text-left text-gray-400">
                <tr>
                  <th className="px-3 py-2">Guest</th><th className="px-3 py-2">Status</th><th className="px-3 py-2 text-right">Questions</th><th className="px-3 py-2">Last seen</th>
                  <th className="px-3 py-2 text-right">👍 / 👎</th><th className="px-3 py-2 text-right">Daily limit</th><th className="px-3 py-2">Expires</th>
                </tr>
              </thead>
              <tbody>
                {[...data.invites].sort((a, b) => (b.stats.lastSeen ?? 0) - (a.stats.lastSeen ?? 0)).map((i) => (
                  <tr key={i.id} className="border-t border-gray-800">
                    <td className="px-3 py-1.5 text-gray-100">{i.name}</td>
                    <td className={"px-3 py-1.5 " + (i.status === "active" ? "text-emerald-400" : "text-gray-500")}>{i.status}</td>
                    <td className="px-3 py-1.5 text-right">{n(i.stats.questions)}</td>
                    <td className="px-3 py-1.5 text-gray-300">{ago(i.stats.lastSeen)}</td>
                    <td className="px-3 py-1.5 text-right">{i.stats.up} / {i.stats.down}</td>
                    <td className="px-3 py-1.5 text-right">{i.dailyLimit}</td>
                    <td className="px-3 py-1.5 text-gray-400">{new Date(i.expires * 1000).toLocaleDateString("en-GB", { dateStyle: "medium" })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-1 text-xs text-gray-500">Each guest&apos;s full question list is under Invitations → Recent questions.</p>
      </section>

      {data.tools.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold">Most-used tools (last 30 days, questions that used each)</h2>
          <div className="space-y-1">
            {data.tools.slice(0, 15).map((t) => (
              <div key={t.name} className="flex items-center gap-2 text-xs">
                <span className="w-48 shrink-0 truncate text-gray-300" title={t.name}>{t.name}</span>
                <div className="h-3 flex-1 rounded bg-gray-800"><div className="h-3 rounded bg-blue-500/70" style={{ width: `${(100 * t.count) / toolMax}%` }} /></div>
                <span className="w-10 text-right font-mono text-gray-400">{t.count}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <div className="mb-2 flex flex-wrap items-center gap-3">
          <h2 className="text-sm font-semibold">Latest activity</h2>
          <div className="flex gap-1 text-xs">
            {(["all", "questions", "problems", "multivariate"] as const).map((k) => (
              <button key={k} onClick={() => setKind(k)} className={"rounded-md border px-2 py-1 " + (kind === k ? "border-gray-400 text-gray-100" : "border-gray-700 text-gray-400")}>
                {k === "all" ? "Everything" : k === "questions" ? "Questions" : k === "problems" ? "Problems and refusals" : "Multivariate loads"}
              </button>
            ))}
          </div>
          <div className="flex gap-1 text-xs">
            {(["all", "owner", "guest", "test"] as const).map((k) => (
              <button key={k} onClick={() => setWho(k)} className={"rounded-md border px-2 py-1 " + (who === k ? "border-gray-400 text-gray-100" : "border-gray-700 text-gray-400")}>
                {k === "all" ? "Everyone" : k === "owner" ? "You" : k === "guest" ? "Guests" : "Tests"}
              </button>
            ))}
          </div>
        </div>
        {events.length === 0 ? (
          <p className="text-sm text-gray-500">Nothing recorded yet for this filter.</p>
        ) : (
          <ul className="divide-y divide-gray-800 rounded-lg border border-gray-800">
            {events.map((e, i) => {
              const problem = e.kind === "refused" || (e.kind === "question" && e.outcome && e.outcome !== "answered");
              return (
                <li key={i} className="px-3 py-2 text-xs">
                  <div className="flex flex-wrap items-baseline gap-x-2 text-gray-500">
                    <span>{when(e.t)}</span>
                    <span style={{ color: COLORS[e.who.role] }}>{e.who.role === "owner" ? "You" : e.who.role === "test" ? "Automated test" : e.who.name ?? "Guest"}</span>
                    <span>{e.kind === "question" ? "asked" : e.kind === "refused" ? "was refused" : "loaded Multivariate data"}</span>
                    {problem && <span className="text-amber-400">{OUTCOME[e.outcome ?? ""] ?? e.outcome}</span>}
                    {e.units ? <span>· {n(e.units)} units</span> : null}
                    {e.ms ? <span>· {(e.ms / 1000).toFixed(0)} s</span> : null}
                  </div>
                  {e.q && <p className="mt-0.5 text-gray-200">{e.q}</p>}
                  {e.detail && <p className="mt-0.5 text-gray-300">{e.detail}</p>}
                  {e.tools && e.tools.length > 0 && <p className="mt-0.5 text-gray-500">Tools: {e.tools.join(", ")}</p>}
                </li>
              );
            })}
          </ul>
        )}
        <p className="mt-1 text-xs text-gray-500">The latest 300 events are shown (1,000 are kept); daily totals are kept for 100 days.</p>
      </section>
    </div>
  );
}
