import { NextRequest, NextResponse } from "next/server";
import { findInviteByToken, inviteStatus, touchInvite } from "@/lib/invites";
import { redis, redisConfigured } from "@/lib/redis";
import { clientIp } from "@/lib/auth";
import { sessionCookie, signSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const SESSION_DAYS = 14;

// A personal invite link: checks the secret, starts a signed session for that invitation, and sends the visitor to the app. Wrong guesses are
// counted per connection so the secret cannot be searched for.
export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const back = (reason: string, status = 303) => {
    const url = req.nextUrl.clone();
    url.pathname = "/access";
    url.search = `?invite=${reason}`;
    return NextResponse.redirect(url, status);
  };

  // Without a real database invitations cannot persist; only the local development stand-in is allowed to answer.
  if (!redisConfigured() && process.env.NODE_ENV === "production") return back("unavailable");

  const ip = clientIp(req);
  const key = `badinvite:${ip}`;
  try {
    const seen = Number((await redis([["GET", key]]))[0] ?? 0);
    if (seen >= 20) return back("slow_down");

    const invite = await findInviteByToken(decodeURIComponent(token));
    if (!invite) {
      await redis([["INCR", key], ["EXPIRE", key, 3600, "NX"]]);
      return back("invalid");
    }
    const status = inviteStatus(invite);
    if (status !== "active") return back(status);

    const exp = Math.min(invite.expires, Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400);
    const value = await signSession({ r: "guest", i: invite.id, n: invite.name, e: exp });
    await touchInvite(invite.id).catch(() => undefined);
    const res = NextResponse.redirect(new URL("/", req.nextUrl), 303);
    res.headers.append("Set-Cookie", sessionCookie(value, exp));
    res.headers.set("Cache-Control", "no-store");
    return res;
  } catch (e) {
    console.error("[invite] lookup failed:", String(e).slice(0, 160));
    return back("unavailable");
  }
}
