import { NextRequest, NextResponse } from "next/server";
import { getSession, sameOrigin } from "@/lib/auth";
import { createInvite, inviteLog, listInvites, revokeInvite } from "@/lib/invites";
import { redisConfigured } from "@/lib/redis";

export const dynamic = "force-dynamic";

// Owner-only (also enforced here, not just in the middleware): list invitations, create one, switch one off or on, and read an invitation's recent questions.
async function owner(req: NextRequest) {
  const s = await getSession(req);
  return s?.r === "owner";
}
const deny = () => NextResponse.json({ error: "That area is for the owner only." }, { status: 403 });
const productionWithoutRedis = () => !redisConfigured() && process.env.NODE_ENV === "production";

export async function GET(req: NextRequest) {
  if (!(await owner(req))) return deny();
  if (productionWithoutRedis()) return NextResponse.json({ error: "No database is connected, so invitations cannot be stored." }, { status: 503 });
  const log = req.nextUrl.searchParams.get("log");
  if (log) return NextResponse.json({ log: await inviteLog(log) });
  return NextResponse.json({ invites: await listInvites() }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  if (!(await owner(req))) return deny();
  if (!sameOrigin(req)) return NextResponse.json({ error: "That request was not allowed." }, { status: 403 });
  if (productionWithoutRedis()) return NextResponse.json({ error: "No database is connected, so invitations cannot be stored." }, { status: 503 });
  const b = (await req.json().catch(() => null)) as { action?: string; id?: string; name?: string; note?: string; days?: number; dailyLimit?: number } | null;
  if (!b) return NextResponse.json({ error: "Bad request." }, { status: 400 });
  try {
    if (b.action === "create") {
      const { invite, token } = await createInvite({ name: String(b.name ?? ""), note: b.note, days: Number(b.days) || undefined, dailyLimit: Number(b.dailyLimit) || undefined });
      return NextResponse.json({ invite, link: `${req.nextUrl.origin}/invite/${token}` });
    }
    if ((b.action === "revoke" || b.action === "restore") && typeof b.id === "string") {
      const ok = await revokeInvite(b.id, b.action === "revoke");
      return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "No such invitation." }, { status: 404 });
    }
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error).message ?? e).slice(0, 200) }, { status: 400 });
  }
}
