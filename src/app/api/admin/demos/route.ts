import { NextRequest, NextResponse } from "next/server";
import { getSession, sameOrigin } from "@/lib/auth";
import { approve, draftAnswer, editDraft, listDemos, promptHash, remove } from "@/lib/demo-cache";
import { DEMO_CARDS } from "@/lib/demo-cards";
import { redisConfigured } from "@/lib/redis";

export const dynamic = "force-dynamic";

// Owner-only: the saved answers for the demo cards. List them, read a recorded draft, approve it (it then replaces the saved answer), or remove one.
const deny = () => NextResponse.json({ error: "That area is for the owner only." }, { status: 403 });
const noDb = () => !redisConfigured() && process.env.NODE_ENV === "production";

export async function GET(req: NextRequest) {
  if ((await getSession(req))?.r !== "owner") return deny();
  if (noDb()) return NextResponse.json({ error: "No database is connected." }, { status: 503 });
  const hash = req.nextUrl.searchParams.get("draft");
  if (hash) {
    const d = await draftAnswer(hash);
    return d ? NextResponse.json(d) : NextResponse.json({ error: "No draft recorded for that card." }, { status: 404 });
  }
  const saved = new Map((await listDemos()).map((d) => [d.hash, d]));
  const cards = DEMO_CARDS.map((c) => {
    const hash = promptHash(c.prompt);
    const s = saved.get(hash);
    return { hash, title: c.title, prompt: c.prompt, status: s?.status ?? "none", approvedAt: s?.approvedAt ?? null, draftAt: s?.draftAt ?? null };
  });
  return NextResponse.json({ cards }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  if ((await getSession(req))?.r !== "owner") return deny();
  if (!sameOrigin(req)) return NextResponse.json({ error: "That request was not allowed." }, { status: 403 });
  if (noDb()) return NextResponse.json({ error: "No database is connected." }, { status: 503 });
  const b = (await req.json().catch(() => null)) as { action?: string; hash?: string; which?: "approved" | "draft"; text?: string } | null;
  if (!b || typeof b.hash !== "string") return NextResponse.json({ error: "Bad request." }, { status: 400 });
  if (b.action === "edit" && typeof b.text === "string") {
    const r = await editDraft(b.hash, b.text);
    return r.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: r.error }, { status: 400 });
  }
  if (b.action === "approve") return (await approve(b.hash)) ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "There is no draft to approve." }, { status: 404 });
  if (b.action === "remove" && (b.which === "approved" || b.which === "draft")) {
    await remove(b.hash, b.which);
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}
