import { NextRequest, NextResponse } from "next/server";
import { getSession, sameOrigin } from "@/lib/auth";
import { getInvite } from "@/lib/invites";
import { listRequests, saveRequest, type RequestEntry } from "@/lib/requests";
import { redisConfigured } from "@/lib/redis";

export const dynamic = "force-dynamic";

// POST: a signed-in visitor (owner or invited guest) sends an improvement request. GET: the owner reads them all.
// (An inviter sees only the requests from people they invited, through /api/admin/invites.)
export async function POST(req: NextRequest) {
  const s = await getSession(req);
  if (!s || s.r === "inviter") return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  if (!sameOrigin(req)) return NextResponse.json({ error: "That request was not allowed." }, { status: 403 });
  if (!redisConfigured() && process.env.NODE_ENV === "production") return NextResponse.json({ error: "Requests cannot be saved right now." }, { status: 503 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Bad request." }, { status: 400 });
  let who: RequestEntry["who"] = { r: "owner" };
  if (s.r === "guest" && s.i) {
    const inv = await getInvite(s.i).catch(() => null);
    who = { r: "guest", inviteId: s.i, name: inv?.name ?? s.n, ...(inv?.createdBy ? { invitedBy: inv.createdBy } : {}) };
  }
  try {
    const out = await saveRequest(body, who);
    return out.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: out.error }, { status: out.status });
  } catch (e) {
    console.error("[requests] save failed:", String(e).slice(0, 160));
    return NextResponse.json({ error: "Could not save your request just now. Please try again." }, { status: 503 });
  }
}

export async function GET(req: NextRequest) {
  if ((await getSession(req))?.r !== "owner") return NextResponse.json({ error: "That area is for the owner only." }, { status: 403 });
  try {
    return NextResponse.json({ items: await listRequests() }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 160) }, { status: 503 });
  }
}
