import crypto from "crypto";
import { redis } from "@/lib/redis";

// Improvement requests: visitors ask for missing data or coverage, a new feature or tool, or report something wrong. Stored in Redis as a
// capped list for the owner's review page. A guest's request records who invited them (invitedBy), so an inviter (partner) can see the
// requests from the people they invited - never their questions.

export const REQUEST_KINDS = {
  coverage: "Missing data or coverage",
  feature: "New feature or tool",
  wrong: "Something wrong in an answer",
  other: "Other",
} as const;
export type RequestKind = keyof typeof REQUEST_KINDS;

export type RequestEntry = {
  id: string;
  t: number;
  kind: RequestKind;
  text: string;
  /** Optional country, region or commodity the request is about. */
  about: string;
  who: { r: "owner" | "guest"; inviteId?: string; name?: string; invitedBy?: string };
};

const MAX_ENTRIES = 2000;
const DAILY_LIMIT = 10;
const clip = (s: unknown, n: number) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, n) : "");

export async function saveRequest(input: { kind?: unknown; text?: unknown; about?: unknown }, who: RequestEntry["who"]): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const kind = typeof input.kind === "string" && input.kind in REQUEST_KINDS ? (input.kind as RequestKind) : null;
  if (!kind) return { ok: false, status: 400, error: "Please choose what kind of request this is." };
  const text = clip(input.text, 1500);
  if (text.length < 5) return { ok: false, status: 400, error: "Please describe what you would like." };
  const day = new Date().toISOString().slice(0, 10);
  const key = `req:rl:${who.inviteId ?? "owner"}:${day}`;
  const n = Number((await redis([["INCR", key], ["EXPIRE", key, 129600, "NX"]]))[0] ?? 0);
  if (n > DAILY_LIMIT) return { ok: false, status: 429, error: "Thank you, that is the most requests we can take from one person in a day. Please send more tomorrow." };
  const entry: RequestEntry = { id: crypto.randomBytes(6).toString("hex"), t: Math.floor(Date.now() / 1000), kind, text, about: clip(input.about, 120), who };
  await redis([
    ["LPUSH", "requests:log", JSON.stringify(entry)],
    ["LTRIM", "requests:log", 0, MAX_ENTRIES - 1],
  ]);
  return { ok: true };
}

export async function listRequests(filter?: { invitedBy: string }, limit = 500): Promise<RequestEntry[]> {
  const rows = ((await redis([["LRANGE", "requests:log", 0, Math.min(limit, MAX_ENTRIES) - 1]]))[0] as string[]) ?? [];
  return rows
    .map((r) => {
      try {
        return JSON.parse(r) as RequestEntry;
      } catch {
        return null;
      }
    })
    .filter((x): x is RequestEntry => x !== null && (!filter || x.who.invitedBy === filter.invitedBy));
}
