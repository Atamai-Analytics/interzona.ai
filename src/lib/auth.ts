import type { NextRequest } from "next/server";
import { SESSION_COOKIE, verifySession, type Session } from "@/lib/session";

// Who is making this request. Works in the edge middleware and in route handlers (no Node-only APIs).
//   owner  - signed in with the app password (Basic header, which older bookmarks and scripts still use, or the owner session cookie)
//   guest  - arrived through a personal invite link; carries the invite id
//   inviter - a partner signed in with the inviter password; may only use /admin/invites for their own invitations
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

// ---- inviter: a partner (e.g. marketing) with their own password who may only create and manage their own invitations.
// Configured with INVITER_NAME and INVITER_PASSWORD; remove or change INVITER_PASSWORD to sign the inviter out everywhere at once.
export function inviterName(): string | null {
  const pw = process.env.INVITER_PASSWORD;
  if (!pw || pw.length < 12 || pw === process.env.APP_PASSWORD) return null;
  return (process.env.INVITER_NAME ?? "Partner").trim().slice(0, 40) || "Partner";
}
export const inviterPasswordOk = (given: string) => {
  const expected = process.env.INVITER_PASSWORD;
  return inviterName() !== null && !!expected && constantTimeEqual(given, expected);
};
/** Fingerprint of the current inviter password (stored in the inviter's session; a mismatch means the password was changed or removed). */
export async function inviterFingerprint(): Promise<string | null> {
  const pw = process.env.INVITER_PASSWORD;
  if (!inviterName() || !pw) return null;
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("inviter|" + pw));
  return Array.from(new Uint8Array(d).slice(0, 12), (b) => b.toString(16).padStart(2, "0")).join("");
}
/** Limits for invitations an inviter creates (adjustable with env vars). */
export const inviterLimits = () => ({
  maxDays: Math.min(90, Math.max(1, Number(process.env.INVITER_MAX_DAYS) || 30)),
  maxDaily: Math.min(200, Math.max(1, Number(process.env.INVITER_MAX_DAILY) || 30)),
  maxActive: Math.min(500, Math.max(1, Number(process.env.INVITER_MAX_ACTIVE) || 25)),
});

/** Verifies a session cookie value, and for an inviter also that the inviter password has not been changed or removed since sign-in. */
export async function sessionFromCookie(value: string | undefined | null): Promise<Session | null> {
  const s = await verifySession(value);
  if (s?.r === "inviter") {
    const fp = await inviterFingerprint();
    if (!fp || s.v !== fp) return null;
  }
  return s;
}

export async function getSession(req: NextRequest): Promise<Session | null> {
  if (basicOwner(req)) return { r: "owner", e: Math.floor(Date.now() / 1000) + 3600 };
  return sessionFromCookie(req.cookies.get(SESSION_COOKIE)?.value);
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
