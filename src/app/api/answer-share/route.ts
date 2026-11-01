import { NextRequest, NextResponse } from "next/server";
import { getSession, sameOrigin } from "@/lib/auth";
import { redisConfigured } from "@/lib/redis";
import { shareAnswer } from "@/lib/shared-answers";

export const dynamic = "force-dynamic";

// Any signed-in visitor (owner or invited guest) can turn one of their own recent answers into a 30-day link to a frozen copy.
export async function POST(req: NextRequest) {
  const s = await getSession(req);
  if (!s) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  if (!sameOrigin(req)) return NextResponse.json({ error: "That request was not allowed." }, { status: 403 });
  if (!redisConfigured() && process.env.NODE_ENV === "production") return NextResponse.json({ error: "Sharing is not available right now." }, { status: 503 });
  const body = (await req.json().catch(() => null)) as { id?: unknown } | null;
  try {
    const out = await shareAnswer(body?.id, { r: s.r, i: s.i });
    if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status });
    return NextResponse.json({ url: `${req.nextUrl.origin}/a/${encodeURIComponent(out.token)}`, expires: out.expires });
  } catch (e) {
    console.error("[answer-share] failed:", String(e).slice(0, 200));
    return NextResponse.json({ error: "Could not create the link just now." }, { status: 503 });
  }
}
