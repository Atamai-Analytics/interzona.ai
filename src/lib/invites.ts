import crypto from "crypto";
import { redis } from "@/lib/redis";

// Personal invite links. Each invitation has its own secret link, an expiry date, a daily question allowance and a usage record, and can be switched
// off at any time. The secret token is shown once, when the invitation is created: only its SHA-256 hash is stored, so a leaked database cannot be
// turned back into working links.

export type Invite = {
  id: string;
  name: string;
  note: string;
  /** Seconds since the epoch. */
  created: number;
  expires: number;
  dailyLimit: number;
  revoked: boolean;
};
export type InviteStats = { questions: number; units: number; lastSeen: number | null; up: number; down: number };
export type InviteStatus = "active" | "expired" | "revoked";

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const now = () => Math.floor(Date.now() / 1000);
const parse = (raw: unknown): Invite | null => {
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw) as Invite;
  } catch {
    return null;
  }
};

export const inviteStatus = (i: Invite): InviteStatus => (i.revoked ? "revoked" : i.expires < now() ? "expired" : "active");

export async function createInvite(input: { name: string; note?: string; days?: number; dailyLimit?: number }): Promise<{ invite: Invite; token: string }> {
  const name = input.name.trim().slice(0, 80);
  if (!name) throw new Error("Give the invitation a name (the person or firm it is for).");
  const days = Math.min(Math.max(Math.floor(input.days ?? 14), 1), 90);
  const invite: Invite = {
    id: crypto.randomBytes(6).toString("hex"),
    name,
    note: (input.note ?? "").trim().slice(0, 200),
    created: now(),
    expires: now() + days * 86400,
    dailyLimit: Math.min(Math.max(Math.floor(input.dailyLimit ?? 30), 1), 200),
    revoked: false,
  };
  const token = "iv_" + crypto.randomBytes(24).toString("base64url");
  await redis([
    ["SET", `invite:${invite.id}`, JSON.stringify(invite)],
    ["SET", `invite:tok:${sha(token)}`, invite.id],
    ["SADD", "invites", invite.id],
  ]);
  return { invite, token };
}

export async function getInvite(id: string): Promise<Invite | null> {
  if (!/^[a-f0-9]{12}$/.test(id)) return null;
  return parse((await redis([["GET", `invite:${id}`]]))[0]);
}

export async function findInviteByToken(token: string): Promise<Invite | null> {
  if (!/^iv_[A-Za-z0-9_-]{30,64}$/.test(token)) return null;
  const id = (await redis([["GET", `invite:tok:${sha(token)}`]]))[0];
  return typeof id === "string" ? getInvite(id) : null;
}

export async function revokeInvite(id: string, revoked = true): Promise<boolean> {
  const inv = await getInvite(id);
  if (!inv) return false;
  inv.revoked = revoked;
  await redis([["SET", `invite:${id}`, JSON.stringify(inv)]]);
  return true;
}

export async function listInvites(): Promise<(Invite & { status: InviteStatus; stats: InviteStats })[]> {
  const ids = ((await redis([["SMEMBERS", "invites"]]))[0] as string[]) ?? [];
  if (ids.length === 0) return [];
  const replies = await redis([...ids.map((id) => ["GET", `invite:${id}`]), ...ids.map((id) => ["HGETALL", `invite:${id}:stats`])]);
  const out: (Invite & { status: InviteStatus; stats: InviteStats })[] = [];
  ids.forEach((id, k) => {
    const inv = parse(replies[k]);
    if (!inv) return;
    const flat = (replies[ids.length + k] as string[]) ?? [];
    const h: Record<string, string> = {};
    for (let i = 0; i + 1 < flat.length; i += 2) h[flat[i]] = flat[i + 1];
    out.push({
      ...inv,
      status: inviteStatus(inv),
      stats: { questions: Number(h.questions ?? 0), units: Number(h.units ?? 0), lastSeen: h.lastSeen ? Number(h.lastSeen) : null, up: Number(h.up ?? 0), down: Number(h.down ?? 0) },
    });
  });
  return out.sort((a, b) => b.created - a.created);
}

/** Records one question against an invitation: totals, last seen, and the question text (shortened) for the owner's activity view. */
export async function recordInviteUse(id: string, use: { question: string; units: number; models?: string[]; tools?: string[] }) {
  const t = now();
  await redis([
    ["HINCRBY", `invite:${id}:stats`, "questions", 1],
    ["HINCRBY", `invite:${id}:stats`, "units", Math.max(0, Math.round(use.units))],
    ["HSET", `invite:${id}:stats`, "lastSeen", t],
    ["LPUSH", `invite:${id}:log`, JSON.stringify({ t, q: use.question.replace(/\s+/g, " ").slice(0, 240), units: Math.round(use.units), tools: (use.tools ?? []).slice(0, 8) })],
    ["LTRIM", `invite:${id}:log`, 0, 99],
  ]);
}

export async function touchInvite(id: string) {
  await redis([["HSET", `invite:${id}:stats`, "lastSeen", now()]]);
}

export async function inviteLog(id: string): Promise<{ t: number; q: string; units: number; tools?: string[] }[]> {
  const rows = ((await redis([["LRANGE", `invite:${id}:log`, 0, 49]]))[0] as string[]) ?? [];
  return rows
    .map((r) => {
      try {
        return JSON.parse(r);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
