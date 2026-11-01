import type { NextRequest } from "next/server";
import { SESSION_COOKIE, verifySession, type Session } from "@/lib/session";

// Who is making this request. Works in the edge middleware and in route handlers (no Node-only APIs).
//   owner  - signed in with the app password (Basic header, which older bookmarks and scripts still use, or the owner session cookie)
//   guest  - arrived through a personal invite link; carries the invite id
// The invite itself (revoked? expired? daily allowance?) is checked where questions are asked, because that needs the database.

const constantTimeEqual = (a: string, b: string) => {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
};

export const passwordOk = (given: string) => {
  const expected = process.env.APP_PASSWORD;
  return !!expected && constantTimeEqual(given, expected);
};

function basicOwner(req: NextRequest): boolean {
  const auth = req.headers.get("authorization");
  if (!auth) return false;
  const [scheme, encoded] = auth.split(" ");
  if (scheme !== "Basic" || !encoded) return false;
  try {
    const decoded = atob(encoded);
    const i = decoded.indexOf(":");
    return passwordOk(i >= 0 ? decoded.slice(i + 1) : decoded);
  } catch {
    return false;
  }
}

export async function getSession(req: NextRequest): Promise<Session | null> {
  if (basicOwner(req)) return { r: "owner", e: Math.floor(Date.now() / 1000) + 3600 };
  return verifySession(req.cookies.get(SESSION_COOKIE)?.value);
}

/** Same-origin check for state-changing requests made with a cookie (stops another site from making the owner's browser create or revoke invites). */
export function sameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host === req.nextUrl.host || new URL(origin).host === req.headers.get("host");
  } catch {
    return false;
  }
}

export const clientIp = (req: NextRequest) => (req.headers.get("x-forwarded-for") ?? req.headers.get("x-real-ip") ?? "unknown").split(",")[0].trim();
