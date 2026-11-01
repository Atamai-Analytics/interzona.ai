// Signed session cookies for the app's own sign-in (owner password or personal invite link). Uses Web Crypto so the same code runs in the edge
// middleware and in route handlers. The cookie holds who the visitor is and when it expires, signed with a key derived from APP_PASSWORD, so it cannot
// be forged or extended. Whether an invitation has been switched off is checked on the server when a question is asked, not here.

export const SESSION_COOKIE = "iz_session";

export type Session = {
  /** "owner" signed in with the app password; "guest" arrived through a personal invite link. */
  r: "owner" | "guest";
  /** Invite id (guests only). */
  i?: string;
  /** Display name (guests only). */
  n?: string;
  /** Expiry, seconds since the epoch. */
  e: number;
};

const enc = new TextEncoder();
const b64url = (buf: ArrayBuffer | Uint8Array) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const fromB64url = (s: string) => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

async function hmac(payload: string): Promise<string> {
  const secret = process.env.APP_PASSWORD ?? "";
  const key = await crypto.subtle.importKey("raw", enc.encode("session|" + secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(payload)));
}

export async function signSession(s: Session): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify(s)));
  return `${payload}.${await hmac(payload)}`;
}

export async function verifySession(value: string | undefined | null): Promise<Session | null> {
  if (!value || !process.env.APP_PASSWORD) return null;
  const [payload, sig] = value.split(".");
  if (!payload || !sig) return null;
  const expected = await hmac(payload);
  if (expected.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff !== 0) return null;
  try {
    const s = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as Session;
    if ((s.r !== "owner" && s.r !== "guest") || typeof s.e !== "number" || s.e < Math.floor(Date.now() / 1000)) return null;
    if (s.r === "guest" && (typeof s.i !== "string" || !s.i)) return null;
    return s;
  } catch {
    return null;
  }
}

// Secure everywhere except `next dev`, where some browsers drop Secure cookies on http://localhost.
const SECURE = process.env.NODE_ENV === "production" ? "; Secure" : "";

/** The Set-Cookie header value for a session (HttpOnly so scripts cannot read it, SameSite=Lax, Secure in production). */
export function sessionCookie(value: string, expiresAtSec: number): string {
  const maxAge = Math.max(0, expiresAtSec - Math.floor(Date.now() / 1000));
  return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly${SECURE}; SameSite=Lax`;
}
export const clearedSessionCookie = () => `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly${SECURE}; SameSite=Lax`;
