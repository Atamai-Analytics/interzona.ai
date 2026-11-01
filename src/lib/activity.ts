import { redis } from "@/lib/redis";

// App-wide activity log for the owner's Activity page: every question (owner, guests and automated test runs), refused questions, errors and
// Multivariate tools database loads. Stored in Redis like the invitation logs: a capped list of the latest events plus per-day counters kept
// for 100 days. Only what is needed to see how the app is used is kept: the question text (shortened), who asked, tools and cost units; for
// Multivariate tools loads only the datasets and counts, never the sample data.

export type ActivityKind = "question" | "refused" | "multivariate_load";
export type ActivityWho = { role: "owner" | "guest" | "test"; name?: string; inviteId?: string };
export type ActivityEvent = {
  t: number; // unix seconds
  kind: ActivityKind;
  who: ActivityWho;
  q?: string; // question, shortened
  outcome?: "answered" | "error" | "step_budget" | "stopped" | string; // questions: how the answer ended; refused: the refusal code
  tools?: string[];
  units?: number;
  ms?: number;
  detail?: string; // multivariate loads: datasets and counts
};

const LOG = "activity:log";
const LOG_MAX = 1000;
const DAY_TTL = 100 * 86400;
const dayKey = (d: string) => `activity:day:${d}`;
const toolsKey = (d: string) => `activity:tools:${d}`;
const today = () => new Date().toISOString().slice(0, 10);

/** Records one event. Never throws: activity logging must not break the request that triggered it. */
export async function recordActivity(e: Omit<ActivityEvent, "t">): Promise<void> {
  const ev: ActivityEvent = { ...e, t: Math.floor(Date.now() / 1000), q: e.q?.replace(/\s+/g, " ").slice(0, 240), tools: e.tools?.slice(0, 12) };
  const d = today();
  const counters: string[] = [e.kind, `${e.kind}_${e.who.role}`];
  if (e.kind === "question" && e.outcome && e.outcome !== "answered") counters.push(`question_${e.outcome}`);
  const cmds: (string | number)[][] = [
    ["LPUSH", LOG, JSON.stringify(ev)],
    ["LTRIM", LOG, 0, LOG_MAX - 1],
    ...counters.map((c) => ["HINCRBY", dayKey(d), c, 1]),
    ["EXPIRE", dayKey(d), DAY_TTL],
  ];
  if (e.units) cmds.push(["HINCRBY", dayKey(d), "units", Math.round(e.units)]);
  if (e.kind === "question" && ev.tools?.length) {
    for (const tool of new Set(ev.tools)) cmds.push(["HINCRBY", toolsKey(d), tool, 1]);
    cmds.push(["EXPIRE", toolsKey(d), DAY_TTL]);
  }
  try {
    await redis(cmds);
  } catch (err) {
    console.error("[activity] could not record:", String(err).slice(0, 160));
  }
}

export type ActivityDay = { day: string; questions: number; owner: number; guest: number; test: number; refused: number; errors: number; multivariate: number; units: number };

/** Daily totals for the last `days` days (oldest first), tool use over the same period, and the latest events. */
export async function activitySummary(days = 30, recent = 300): Promise<{ days: ActivityDay[]; tools: { name: string; count: number }[]; recent: ActivityEvent[] }> {
  const list: string[] = [];
  for (let i = days - 1; i >= 0; i--) list.push(new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10));
  const out = await redis([...list.map((d) => ["HGETALL", dayKey(d)]), ...list.map((d) => ["HGETALL", toolsKey(d)]), ["LRANGE", LOG, 0, recent - 1]]);
  const asMap = (v: unknown): Record<string, number> => {
    // Upstash returns a flat [field, value, ...] array; the local stand-in returns the same shape.
    const flat = Array.isArray(v) ? (v as string[]) : [];
    const m: Record<string, number> = {};
    for (let i = 0; i + 1 < flat.length; i += 2) m[flat[i]] = Number(flat[i + 1]) || 0;
    return m;
  };
  const dayRows = list.map((day, i) => {
    const h = asMap(out[i]);
    return {
      day,
      questions: h.question ?? 0,
      owner: h.question_owner ?? 0,
      guest: h.question_guest ?? 0,
      test: h.question_test ?? 0,
      refused: h.refused ?? 0,
      errors: (h.question_error ?? 0) + (h.question_step_budget ?? 0),
      multivariate: h.multivariate_load ?? 0,
      units: h.units ?? 0,
    };
  });
  const toolTotals: Record<string, number> = {};
  list.forEach((_, i) => {
    for (const [k, v] of Object.entries(asMap(out[days + i]))) toolTotals[k] = (toolTotals[k] ?? 0) + v;
  });
  const events = ((out[days * 2] as string[]) ?? [])
    .map((s) => {
      try {
        return JSON.parse(s) as ActivityEvent;
      } catch {
        return null;
      }
    })
    .filter((e): e is ActivityEvent => e !== null);
  return { days: dayRows, tools: Object.entries(toolTotals).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count), recent: events };
}
