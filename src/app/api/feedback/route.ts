import { NextRequest, NextResponse } from "next/server";
import { getSession, sameOrigin } from "@/lib/auth";
import { listFeedback, saveFeedback } from "@/lib/feedback";
import { getInvite } from "@/lib/invites";
import { redisConfigured } from "@/lib/redis";

export const dynamic = "force-dynamic";

// POST: any signed-in visitor (owner or invited guest) rates an answer. GET: the owner reads the latest feedback.
export async function POST(req: NextRequest) {
  const s = await getSession(req);
  if (!s) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  if (!sameOrigin(req)) return NextResponse.json({ error: "That request was not allowed." }, { status: 403 });
  if (!redisConfigured() && process.env.NODE_ENV === "production") return NextResponse.json({ error: "Feedback is not available right now." }, { status: 503 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Bad request." }, { status: 400 });
  let who: { r: "owner" | "guest"; inviteId?: string; name?: string } = { r: "owner" };
  if (s.r === "guest" && s.i) {
    const inv = await getInvite(s.i).catch(() => null);
    who = { r: "guest", inviteId: s.i, name: inv?.name ?? s.n };
  }
  try {
    const out = await saveFeedback(body, who);
    return out.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: out.error }, { status: out.status });
  } catch (e) {
    console.error("[feedback] save failed:", String(e).slice(0, 160));
    return NextResponse.json({ error: "Could not save feedback just now." }, { status: 503 });
  }
}

export async function GET(req: NextRequest) {
  if ((await getSession(req))?.r !== "owner") return NextResponse.json({ error: "That area is for the owner only." }, { status: 403 });
  try {
    return NextResponse.json(await listFeedback(Number(req.nextUrl.searchParams.get("limit")) || 200), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 160) }, { status: 503 });
  }
}
