import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";

// Public: snapshot share links (signed, expiring tokens checked in the page), invite links, the sign-in page and its API, and the two logo images
// the sign-in page shows. Everything else needs the owner password or a personal invite link; /admin needs the owner.
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

  if (session && (!isAdmin || session.r === "owner")) return NextResponse.next();

  const wantsPage = req.method === "GET" && !path.startsWith("/api/") && (req.headers.get("accept") ?? "").includes("text/html");
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
