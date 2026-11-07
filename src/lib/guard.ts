import crypto from "crypto";
import type { NextRequest } from "next/server";
import type { Session } from "@/lib/session";

// Cost protection for /api/chat. Every question can start several model calls, database queries, analysis sandboxes and web lookups that are billed
// per use, so this limits what one visitor, and all visitors together, can spend:
//   1. input limits (length of the question, how much history is sent back each turn),
//   2. per-visitor limits (burst, per day, one question at a time) and a per-IP daily limit that cookie-clearing does not reset,
//   3. a global daily question limit and a global daily cost budget (a "kill switch" that stops new questions until tomorrow),
//   4. a cap on analysis sandboxes per question (see sandboxRunsPerQuestion).
// All numbers can be changed with environment variables (GUARD_*). Counters live in Upstash Redis when UPSTASH_REDIS_REST_URL / _TOKEN (or the
// Vercel KV names KV_REST_API_URL / _TOKEN) are set, which makes the limits global across servers; otherwise they live in each server's memory,
// which still stops abuse of a single instance but is NOT a reliable global ceiling. A request carrying the secret bypass header is not limited.

const n = (name: string, def: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
};

export const LIMITS = {
  maxUserChars: n("GUARD_MAX_USER_CHARS", 1500),
  maxMessages: n("GUARD_MAX_MESSAGES", 12),
  maxOldAnswerChars: n("GUARD_MAX_OLD_ANSWER_CHARS", 4000),
  maxPayloadChars: n("GUARD_MAX_PAYLOAD_CHARS", 30000),
  perVisitor10Min: n("GUARD_VISITOR_PER_10MIN", 10),
  perVisitorDay: n("GUARD_VISITOR_PER_DAY", 40),
  perIpDay: n("GUARD_IP_PER_DAY", 150),
  globalDay: n("GUARD_GLOBAL_PER_DAY", 400),
  maxConcurrent: n("GUARD_MAX_CONCURRENT", 1),
  // Cost units are input-equivalent tokens: input + 0.1 x cache reads + 1.25 x cache writes + 5 x output. A typical question is roughly 15,000-40,000.
  visitorDayUnits: n("GUARD_VISITOR_DAY_UNITS", 1_500_000),
  globalDayUnits: n("GUARD_GLOBAL_DAY_UNITS", 8_000_000),
  sandboxRunsPerQuestion: n("GUARD_SANDBOX_RUNS", 4),
};

export const costUnits = (t: { input: number; cache_read: number; cache_write: number; output: number }) =>
  Math.round(t.input + 0.1 * t.cache_read + 1.25 * t.cache_write + 5 * t.output);

// ---- Counter store ---------------------------------------------------------------------------------------------------------------------------
type Store = {
  kind: "redis" | "memory";
  /** Adds `by` to the counter, sets its lifetime if new, and returns the new value. */
  incr(key: string, by: number, ttlSec: number): Promise<number>;
  get(key: string): Promise<number>;
};

const mem = new Map<string, { v: number; exp: number }>();
const memoryStore: Store = {
  kind: "memory",
  async incr(key, by, ttlSec) {
    const now = Date.now();
    const cur = mem.get(key);
    const e = cur && cur.exp > now ? cur : { v: 0, exp: now + ttlSec * 1000 };
    e.v += by;
    mem.set(key, e);
    if (mem.size > 5000) for (const [k, x] of mem) if (x.exp <= now) mem.delete(k);
    return e.v;
  },
  async get(key) {
    const cur = mem.get(key);
    return cur && cur.exp > Date.now() ? cur.v : 0;
  },
};

function redisStore(): Store | null {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const once = async (commands: (string | number)[][]) => {
    const r = await fetch(`${url.replace(/\/$/, "")}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(commands),
      signal: AbortSignal.timeout(1500),
      cache: "no-store",
    });
    if (!r.ok) throw new Error(`redis ${r.status}`);
    return (await r.json()) as { result?: unknown; error?: string }[];
  };
  // A connection kept open while a long answer was being written can be closed by the other side, and the first request on it then times out
  // (seen as "redis failed, using memory" when a finished answer's cost was recorded). A second attempt opens a fresh connection and succeeds.
  const call = async (commands: (string | number)[][]) => {
    try {
      return await once(commands);
    } catch {
      return once(commands);
    }
  };
  return {
    kind: "redis",
    async incr(key, by, ttlSec) {
      const out = await call([["INCRBY", key, by], ["EXPIRE", key, ttlSec, "NX"]]);
      return Number(out[0]?.result ?? 0);
    },
    async get(key) {
      const out = await call([["GET", key]]);
      return Number(out[0]?.result ?? 0);
    },
  };
}

/** The shared store when configured, with the in-memory one as a fallback if it is unreachable (a counter outage must not take the demo down). */
const store = (): Store => {
  const r = redisStore();
  if (!r) return memoryStore;
  return {
    kind: "redis",
    async incr(k, by, ttl) {
      try {
        return await r.incr(k, by, ttl);
      } catch (e) {
        console.error("[guard] redis failed, using memory:", String(e).slice(0, 120));
        return memoryStore.incr(k, by, ttl);
      }
    },
    async get(k) {
      try {
        return await r.get(k);
      } catch {
        return memoryStore.get(k);
      }
    },
  };
};

// ---- Identity --------------------------------------------------------------------------------------------------------------------------------
const hash = (s: string) => crypto.createHash("sha256").update((process.env.APP_PASSWORD ?? "") + "|guard|" + s).digest("hex").slice(0, 16);
const COOKIE = "iz_vid";

function identify(req: NextRequest) {
  const fwd = req.headers.get("x-forwarded-for") ?? req.headers.get("x-real-ip") ?? "unknown";
  const ip = hash(fwd.split(",")[0].trim());
  const existing = req.cookies.get(COOKIE)?.value;
  const valid = existing && /^[a-f0-9]{24}$/.test(existing);
  const vid = valid ? existing! : crypto.randomBytes(12).toString("hex");
  return { ip, vid, setCookie: valid ? null : `${COOKIE}=${vid}; Path=/; Max-Age=${30 * 86400}; HttpOnly; Secure; SameSite=Lax` };
}

const bypassOk = (req: NextRequest) => {
  const secret = process.env.GUARD_BYPASS_TOKEN;
  const given = req.headers.get("x-guard-bypass");
  if (!secret || !given) return false;
  const a = Buffer.from(given), b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

// ---- Input checks ----------------------------------------------------------------------------------------------------------------------------
export type ChatMessage = { role: "user" | "assistant"; content: string };
export type Rejection = { ok: false; status: number; code: string; message: string; retryAfterSec?: number };

/** Validates the request body and trims the history that is sent back to the model on every turn (old answers are the main source of input bloat). */
export function checkMessages(body: unknown): { ok: true; messages: ChatMessage[] } | Rejection {
  const raw = (body as { messages?: unknown })?.messages;
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, status: 400, code: "bad_request", message: "Please type a question." };
  const msgs: ChatMessage[] = [];
  for (const m of raw) {
    const mm = m as { role?: unknown; content?: unknown };
    if ((mm.role !== "user" && mm.role !== "assistant") || typeof mm.content !== "string") return { ok: false, status: 400, code: "bad_request", message: "That request was not valid." };
    msgs.push({ role: mm.role, content: mm.content });
  }
  const last = msgs[msgs.length - 1];
  if (last.role !== "user" || !last.content.trim()) return { ok: false, status: 400, code: "bad_request", message: "Please type a question." };
  if (last.content.length > LIMITS.maxUserChars)
    return { ok: false, status: 413, code: "too_long", message: `That question is too long (${last.content.length.toLocaleString("en-US")} characters; the limit is ${LIMITS.maxUserChars.toLocaleString("en-US")}). Please shorten it.` };
  let kept = msgs.slice(-LIMITS.maxMessages).map((m, i, a) =>
    i === a.length - 1 ? m : { ...m, content: m.content.length > LIMITS.maxOldAnswerChars ? m.content.slice(0, LIMITS.maxOldAnswerChars) + " […earlier text shortened]" : m.content }
  );
  while (kept.length > 1 && kept.reduce((s, m) => s + m.content.length, 0) > LIMITS.maxPayloadChars) kept = kept.slice(1);
  while (kept.length > 1 && kept[0].role !== "user") kept = kept.slice(1);
  return { ok: true, messages: kept };
}

// ---- Admission -------------------------------------------------------------------------------------------------------------------------------
const active = new Map<string, number>();
export type Admission = { ok: true; setCookie: string | null; finish: (totals: { turns: number; input: number; cache_read: number; cache_write: number; output: number }, extra?: Record<string, unknown>) => Promise<void> };

/** Questions an invitation has used today (counted when a question is accepted). */
export const inviteQuestionsToday = (inviteId: string) => store().get(`v:inv_${inviteId}:req:${new Date().toISOString().slice(0, 10)}`);

/**
 * Decides whether a question may start. A visitor who arrived through a personal invite link is counted under that invitation (its own daily
 * allowance, its own usage record) instead of the browser cookie, and is refused once the invitation is switched off or has expired.
 */
export async function admit(req: NextRequest, opts: { session?: Session | null; question?: string } = {}): Promise<Admission | Rejection> {
  const ident = identify(req);
  const { ip, setCookie } = ident;
  let vid = ident.vid;
  const bypass = bypassOk(req);
  const day = new Date().toISOString().slice(0, 10);
  const st = store();
  const who = (inv?: import("@/lib/invites").Invite | null): import("@/lib/activity").ActivityWho =>
    bypass ? { role: "test" } : inv ? { role: "guest", name: inv.name, inviteId: inv.id } : opts.session?.r === "guest" ? { role: "guest", inviteId: opts.session.i } : { role: "owner" };
  const reject = (status: number, code: string, message: string, retryAfterSec?: number): Rejection => {
    import("@/lib/activity").then(({ recordActivity }) => recordActivity({ kind: "refused", who: who(invite), q: opts.question, outcome: code })).catch(() => undefined);
    return { ok: false, status, code, message, retryAfterSec };
  };

  let invite: import("@/lib/invites").Invite | null = null;
  if (opts.session?.r === "guest" && opts.session.i && !bypass) {
    const { getInvite, inviteStatus } = await import("@/lib/invites");
    try {
      invite = await getInvite(opts.session.i);
    } catch (e) {
      // The invitation could not be read (Redis timeout): refuse for now with a retry, rather than crash or let an unchecked guest through.
      console.error("[guard] invite lookup failed:", String(e).slice(0, 120));
      return reject(503, "invite_check_failed", "We couldn't check your invitation just now. Please try again in a moment.", 10);
    }
    const status = invite ? inviteStatus(invite) : "revoked";
    if (!invite || status !== "active")
      return reject(403, "invite_ended", status === "expired" ? "Your invitation has expired. Please ask for a new link." : "This invitation is no longer active. Please contact the person who invited you.");
    vid = `inv_${invite.id}`;
  }

  if (!bypass) {
    // Budgets first (reads only): the global kill switch and this visitor's spend today.
    if ((await st.get(`units:${day}`)) >= LIMITS.globalDayUnits)
      return reject(429, "capacity", "This demo has reached its capacity for today. Please try again tomorrow.", 3600);
    if ((await st.get(`v:${vid}:units:${day}`)) >= LIMITS.visitorDayUnits)
      return reject(429, "daily_limit", "You have reached today's usage limit for this demo. Please come back tomorrow, or get in touch for extended access.", 3600);
    if ((active.get(vid) ?? 0) >= LIMITS.maxConcurrent)
      return reject(429, "busy", "Your previous question is still running. Please wait for it to finish.", 10);
    const tenMin = Math.floor(Date.now() / 600_000);
    if ((await st.incr(`v:${vid}:w:${tenMin}`, 1, 900)) > LIMITS.perVisitor10Min)
      return reject(429, "too_fast", "You're asking questions quickly. Please wait a few minutes before the next one.", 300);
    const dayLimit = invite ? invite.dailyLimit : LIMITS.perVisitorDay;
    if ((await st.incr(`v:${vid}:req:${day}`, 1, 129600)) > dayLimit)
      return reject(429, "daily_limit", invite ? `You have used today's ${dayLimit} ${dayLimit === 1 ? "question" : "questions"} on this invitation. Please come back tomorrow.` : "You have reached today's question limit for this demo. Please come back tomorrow, or get in touch for extended access.", 3600);
    // Invited guests are counted under their invitation, so an office sharing one connection is not cut off by the per-connection limit (the global limits still apply).
    if (!invite && (await st.incr(`ip:${ip}:req:${day}`, 1, 129600)) > LIMITS.perIpDay)
      return reject(429, "daily_limit", "Too many questions have been asked from this connection today. Please try again tomorrow.", 3600);
    if ((await st.incr(`req:${day}`, 1, 129600)) > LIMITS.globalDay)
      return reject(429, "capacity", "This demo has reached its capacity for today. Please try again tomorrow.", 3600);
  }

  active.set(vid, (active.get(vid) ?? 0) + 1);
  let finished = false;
  return {
    ok: true,
    setCookie,
    async finish(totals, extra) {
      if (finished) return;
      finished = true;
      const left = (active.get(vid) ?? 1) - 1;
      if (left <= 0) active.delete(vid);
      else active.set(vid, left);
      const units = costUnits(totals);
      try {
        if (!bypass && units > 0) {
          await st.incr(`units:${day}`, units, 129600);
          await st.incr(`v:${vid}:units:${day}`, units, 129600);
        }
      } catch (e) {
        console.error("[guard] could not record usage:", String(e).slice(0, 120));
      }
      if (invite) {
        try {
          const { recordInviteUse } = await import("@/lib/invites");
          const tools = Array.isArray(extra?.tools) ? (extra!.tools as string[]) : [];
          await recordInviteUse(invite.id, { question: opts.question ?? "", units, tools });
        } catch (e) {
          console.error("[guard] could not record invite use:", String(e).slice(0, 120));
        }
      }
      try {
        const { recordActivity } = await import("@/lib/activity");
        await recordActivity({
          kind: "question",
          who: who(invite),
          q: opts.question,
          outcome: typeof extra?.outcome === "string" ? extra.outcome : undefined,
          tools: Array.isArray(extra?.tools) ? (extra!.tools as string[]) : [],
          units,
          ms: typeof extra?.ms === "number" ? extra.ms : undefined,
        });
      } catch (e) {
        console.error("[guard] could not record activity:", String(e).slice(0, 120));
      }
      console.log(`[usage] ${JSON.stringify({ v: vid.slice(0, 10), ip: ip.slice(0, 6), units, ...totals, store: st.kind, bypass, ...extra })}`);
    },
  };
}
