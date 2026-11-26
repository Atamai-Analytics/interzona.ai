import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { readInviteStatus } from "@/lib/invite-state";
import { redisConfigured } from "@/lib/redis";

// Public: snapshot share links (signed, expiring tokens checked in the page), invite links, the sign-in page and its API, and the two logo images
// the sign-in page shows. Everything else needs the owner password or a personal invite link; /admin needs the owner, except that an inviter
// (partner password) may use /admin/invites for their own invitations and nothing else.
const PUBLIC = ["/s/", "/m/", "/a/", "/invite/", "/access", "/api/access/"];
const PUBLIC_FILES = ["/interzona-mark.png", "/mapbox-logo.png"];

export async function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname;
  if (PUBLIC.some((p) => path === p.replace(/\/$/, "") || path.startsWith(p)) || PUBLIC_FILES.includes(path)) return NextResponse.next();

  if (!process.env.APP_PASSWORD) {
    // Fail closed: if no password is configured, block access rather than leave it open.
    return new NextResponse("Server misconfigured: APP_PASSWORD not set.", { status: 500 });
  }

  const session = await getSession(req);
  const isAdmin = path === "/admin" || path.startsWith("/admin/") || path.startsWith("/api/admin");

  const wantsPage = req.method === "GET" && !path.startsWith("/api/") && (req.headers.get("accept") ?? "").includes("text/html");

  // A guest's sign-in lasts up to 14 days, but the invitation behind it can be switched off or expire sooner: check it on every page and API
  // request, not only when a chat question is asked. /api/session stays open so the header can say the invitation has ended.
  // Without a real Redis (local development) the middleware cannot see the in-process stand-in, so the check is left to the chat as before;
  // production without Redis issues no invitations at all.
  if (session?.r === "guest" && !isAdmin && path !== "/api/session" && redisConfigured()) {
    let status: "active" | "expired" | "revoked" | "unknown";
    try {
      status = await readInviteStatus(session.i ?? "");
    } catch (e) {
      console.error("[middleware] invite check failed:", String(e).slice(0, 120));
      status = "unknown";
    }
    if (status === "expired" || status === "revoked") {
      if (wantsPage) {
        const url = req.nextUrl.clone();
        url.pathname = "/access";
        url.search = `?invite=${status}`;
        return NextResponse.redirect(url);
      }
      return NextResponse.json(
        { error: status === "expired" ? "Your invitation has expired. Please ask for a new link." : "This invitation is no longer active. Please contact the person who invited you.", code: "invite_ended" },
        { status: 403 }
      );
    }
    // Redis unreachable: a page shell holds no data, so let it load; data requests wait and retry (the chat does the same).
    if (status === "unknown" && !wantsPage)
      return NextResponse.json({ error: "We couldn't check your invitation just now. Please try again in a moment.", code: "invite_check_failed" }, { status: 503, headers: { "Retry-After": "10" } });
    return NextResponse.next();
  }

  // An inviter (partner with the inviter password) may only use the invitations page and its API; everything else, including the app's
  // data and AI tools, sends them back to the invitations page. (They can create an invitation for themselves to try the app as a guest.)
  if (session?.r === "inviter") {
    if (path === "/admin/invites" || path === "/api/admin/invites" || path === "/api/session") return NextResponse.next();
    if (wantsPage) {
      const url = req.nextUrl.clone();
      url.pathname = "/admin/invites";
      url.search = "";
      return NextResponse.redirect(url);
    }
    return NextResponse.json({ error: "This sign-in can only manage invitations.", code: "forbidden" }, { status: 403 });
  }

  if (session && (!isAdmin || session.r === "owner")) return NextResponse.next();

  if (wantsPage) {
    const url = req.nextUrl.clone();
    url.pathname = "/access";
    url.search = "";
    if (isAdmin) url.searchParams.set("next", path);
    return NextResponse.redirect(url);
  }
  return NextResponse.json(
    { error: session ? "That area is for the owner only." : "Please sign in, or use your personal invite link.", code: session ? "forbidden" : "auth_required" },
    { status: session ? 403 : 401 }
  );
}

export const config = {
  matcher: "/((?!_next/static|_next/image|favicon.ico).*)",
};
