import { NextRequest, NextResponse } from "next/server";
import { sameOrigin } from "@/lib/auth";
import { clearedSessionCookie } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "That request was not allowed." }, { status: 403 });
  const res = NextResponse.json({ ok: true });
  res.headers.append("Set-Cookie", clearedSessionCookie());
  return res;
}
