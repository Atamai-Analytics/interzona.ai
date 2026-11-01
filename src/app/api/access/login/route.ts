import { NextRequest, NextResponse } from "next/server";
import { clientIp, passwordOk, sameOrigin } from "@/lib/auth";
import { redis } from "@/lib/redis";
import { sessionCookie, signSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const OWNER_DAYS = 7;
const MAX_FAILS_PER_HOUR = 8;

// Owner sign-in with the app password (the same password as before). Failed attempts are limited per connection.
export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "That request was not allowed." }, { status: 403 });
  const body = (await req.json().catch(() => null)) as { password?: unknown } | null;
  const password = typeof body?.password === "string" ? body.password.slice(0, 200) : "";

  const key = `badlogin:${clientIp(req)}`;
  try {
    const fails = Number((await redis([["GET", key]]))[0] ?? 0);
    if (fails >= MAX_FAILS_PER_HOUR) return NextResponse.json({ error: "Too many attempts. Please wait an hour and try again." }, { status: 429 });
  } catch {
    /* if the counter is unreachable, the password check below still applies */
  }

  if (!passwordOk(password)) {
    await redis([["INCR", key], ["EXPIRE", key, 3600, "NX"]]).catch(() => undefined);
    return NextResponse.json({ error: "That password is not correct." }, { status: 401 });
  }
  const exp = Math.floor(Date.now() / 1000) + OWNER_DAYS * 86400;
  const res = NextResponse.json({ ok: true });
  res.headers.append("Set-Cookie", sessionCookie(await signSession({ r: "owner", e: exp }), exp));
  res.headers.set("Cache-Control", "no-store");
  return res;
}
