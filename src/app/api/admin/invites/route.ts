import { NextRequest, NextResponse } from "next/server";
import { getSession, inviterLimits, sameOrigin } from "@/lib/auth";
import { createInvite, getInvite, inviteLog, listInvites, revokeInvite } from "@/lib/invites";
import { redisConfigured } from "@/lib/redis";

export const dynamic = "force-dynamic";

// Invitations API (also enforced here, not just in the middleware).
//   owner   - list every invitation, create, switch any off or on, and read an invitation's recent questions.
//   inviter - a partner: list, create and switch off/on ONLY the invitations they created, within inviterLimits() (days, questions a day,
//             number active). They never see guests' questions, cost units or the owner's invitations.
type Who = { role: "owner" } | { role: "inviter"; name: string };
async function who(req: NextRequest): Promise<Who | null> {
  const s = await getSession(req);
  if (s?.r === "owner") return { role: "owner" };
  if (s?.r === "inviter" && s.n) return { role: "inviter", name: s.n };
  return null;
}
const deny = () => NextResponse.json({ error: "That area is for the owner only." }, { status: 403 });
const productionWithoutRedis = () => !redisConfigured() && process.env.NODE_ENV === "production";
const mine = (inv: { createdBy?: string }, w: Who) => w.role === "owner" || inv.createdBy === w.name;

export async function GET(req: NextRequest) {
  const w = await who(req);
  if (!w) return deny();
  if (productionWithoutRedis()) return NextResponse.json({ error: "No database is connected, so invitations cannot be stored." }, { status: 503 });
  const log = req.nextUrl.searchParams.get("log");
  if (log) {
    if (w.role !== "owner") return NextResponse.json({ error: "Guests' questions are visible to the owner only." }, { status: 403 });
    return NextResponse.json({ log: await inviteLog(log) });
  }
  const all = await listInvites();
  if (w.role === "owner") return NextResponse.json({ role: "owner", invites: all }, { headers: { "Cache-Control": "no-store" } });
  const own = all.filter((i) => i.createdBy === w.name).map((i) => ({ ...i, stats: { ...i.stats, units: 0 } }));
  const limits = inviterLimits();
  return NextResponse.json(
    { role: "inviter", name: w.name, limits, active: own.filter((i) => i.status === "active").length, invites: own },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function POST(req: NextRequest) {
  const w = await who(req);
  if (!w) return deny();
  if (!sameOrigin(req)) return NextResponse.json({ error: "That request was not allowed." }, { status: 403 });
  if (productionWithoutRedis()) return NextResponse.json({ error: "No database is connected, so invitations cannot be stored." }, { status: 503 });
  const b = (await req.json().catch(() => null)) as { action?: string; id?: string; name?: string; note?: string; days?: number; dailyLimit?: number } | null;
  if (!b) return NextResponse.json({ error: "Bad request." }, { status: 400 });
  const limits = inviterLimits();
  const activeCount = async () => (await listInvites()).filter((i) => w.role === "inviter" && i.createdBy === w.name && i.status === "active").length;
  try {
    if (b.action === "create") {
      if (w.role === "inviter" && (await activeCount()) >= limits.maxActive)
        return NextResponse.json({ error: `You already have ${limits.maxActive} active invitations, the most allowed. Switch one off, or ask the account owner to raise the limit.` }, { status: 400 });
      const { invite, token } = await createInvite({
        name: String(b.name ?? ""),
        note: b.note,
        days: Number(b.days) || undefined,
        dailyLimit: Number(b.dailyLimit) || undefined,
        ...(w.role === "inviter" ? { createdBy: w.name, maxDays: limits.maxDays, maxDaily: limits.maxDaily } : {}),
      });
      return NextResponse.json({ invite, link: `${req.nextUrl.origin}/invite/${token}` });
    }
    if ((b.action === "revoke" || b.action === "restore") && typeof b.id === "string") {
      const inv = await getInvite(b.id);
      if (!inv || !mine(inv, w)) return NextResponse.json({ error: "No such invitation." }, { status: 404 });
      if (b.action === "restore" && w.role === "inviter" && (await activeCount()) >= limits.maxActive)
        return NextResponse.json({ error: `You already have ${limits.maxActive} active invitations, the most allowed.` }, { status: 400 });
      const ok = await revokeInvite(b.id, b.action === "revoke");
      return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "No such invitation." }, { status: 404 });
    }
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error).message ?? e).slice(0, 200) }, { status: 400 });
  }
}
