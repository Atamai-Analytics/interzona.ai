import crypto from "crypto";
import { redis } from "@/lib/redis";

// Thumbs up/down (with an optional comment) on answers. Stored in Redis: a capped list of the latest entries for the owner's review page, running totals,
// and, for invited guests, totals on their invitation so the invitation list can show how each person rated the answers.

export type FeedbackEntry = {
  id: string;
  t: number;
  rating: "up" | "down";
  comment: string;
  q: string;
  a: string;
  /** The answer was a saved (recorded) answer, not a live one. */
  saved: boolean;
  who: { r: "owner" | "guest"; inviteId?: string; name?: string };
};

const MAX_ENTRIES = 2000;
const DAILY_LIMIT = 60;
const clip = (s: unknown, n: number) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, n) : "");

export async function saveFeedback(input: { rating?: unknown; comment?: unknown; question?: unknown; answer?: unknown; saved?: unknown }, who: FeedbackEntry["who"]): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  if (input.rating !== "up" && input.rating !== "down") return { ok: false, status: 400, error: "Please choose thumbs up or thumbs down." };
  const day = new Date().toISOString().slice(0, 10);
  const key = `fb:rl:${who.inviteId ?? "owner"}:${day}`;
  const n = Number((await redis([["INCR", key], ["EXPIRE", key, 129600, "NX"]]))[0] ?? 0);
  if (n > DAILY_LIMIT) return { ok: false, status: 429, error: "That is a lot of feedback for one day. Thank you, it has been noted." };
  const entry: FeedbackEntry = {
    id: crypto.randomBytes(6).toString("hex"),
    t: Math.floor(Date.now() / 1000),
    rating: input.rating,
    comment: clip(input.comment, 800),
    q: clip(input.question, 500),
    a: clip(input.answer, 700),
    saved: input.saved === true,
    who,
  };
  const cmds: (string | number)[][] = [
    ["LPUSH", "feedback:log", JSON.stringify(entry)],
    ["LTRIM", "feedback:log", 0, MAX_ENTRIES - 1],
    ["HINCRBY", "feedback:counts", entry.rating, 1],
  ];
  if (who.inviteId) cmds.push(["HINCRBY", `invite:${who.inviteId}:stats`, entry.rating, 1]);
  await redis(cmds);
  return { ok: true };
}

export async function listFeedback(limit = 200): Promise<{ items: FeedbackEntry[]; counts: { up: number; down: number } }> {
  const [rows, counts] = await redis([["LRANGE", "feedback:log", 0, Math.min(limit, MAX_ENTRIES) - 1], ["HGETALL", "feedback:counts"]]);
  const items = ((rows as string[]) ?? [])
    .map((r) => {
      try {
        return JSON.parse(r) as FeedbackEntry;
      } catch {
        return null;
      }
    })
    .filter((x): x is FeedbackEntry => x !== null);
  const flat = (counts as string[]) ?? [];
  const h: Record<string, string> = {};
  for (let i = 0; i + 1 < flat.length; i += 2) h[flat[i]] = flat[i + 1];
  return { items, counts: { up: Number(h.up ?? 0), down: Number(h.down ?? 0) } };
}
