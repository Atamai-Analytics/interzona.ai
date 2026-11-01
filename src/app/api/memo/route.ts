import { NextRequest, NextResponse } from "next/server";
import { getSession, sameOrigin } from "@/lib/auth";
import { createMemoShare, getMemo } from "@/lib/memo";
import { MEMO_CASES } from "@/lib/memo-cases";
import { redisConfigured } from "@/lib/redis";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

// GET lists the memos on offer. POST {case, action}: "share" makes a 30-day link to a frozen copy (any signed-in visitor); "refresh" rebuilds it from today's data (owner only).
export async function GET() {
  return NextResponse.json({ memos: Object.values(MEMO_CASES).map((c) => ({ id: c.id, title: c.title, subtitle: c.subtitle })) });
}

export async function POST(req: NextRequest) {
  const s = await getSession(req);
  if (!s) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  if (!sameOrigin(req)) return NextResponse.json({ error: "That request was not allowed." }, { status: 403 });
  const body = (await req.json().catch(() => null)) as { case?: string; action?: string } | null;
  const id = String(body?.case ?? "");
  if (!MEMO_CASES[id]) return NextResponse.json({ error: "No such memo." }, { status: 404 });
  if (!redisConfigured() && process.env.NODE_ENV === "production") return NextResponse.json({ error: "Memos are not available right now." }, { status: 503 });
  try {
    if (body?.action === "refresh") {
      if (s.r !== "owner") return NextResponse.json({ error: "That is for the owner only." }, { status: 403 });
      await getMemo(id, true);
      return NextResponse.json({ ok: true });
    }
    if (body?.action === "share") {
      const { token, expires } = await createMemoShare(id);
      return NextResponse.json({ url: `${req.nextUrl.origin}/m/${encodeURIComponent(token)}`, expires });
    }
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (e) {
    console.error("[memo] failed:", String(e).slice(0, 200));
    return NextResponse.json({ error: "Could not build the memo just now." }, { status: 503 });
  }
}
