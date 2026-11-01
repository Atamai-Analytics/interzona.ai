import crypto from "crypto";

// Expiring share links for company snapshots. The token is "<companyId>.<expiry>.<signature>", signed with the app password, so it
// cannot be forged or extended, and it opens only that one snapshot (nothing else in the app).

const DEFAULT_DAYS = 30;

function sign(payload: string): string {
  const key = process.env.APP_PASSWORD ?? "";
  return crypto.createHmac("sha256", key).update("snapshot|" + payload).digest("base64url");
}

export function createShareToken(companyId: number, days = DEFAULT_DAYS): { token: string; expires: string } {
  const exp = Math.floor(Date.now() / 1000) + Math.round(days * 86400);
  const payload = `${Math.floor(companyId)}.${exp}`;
  return { token: `${payload}.${sign(payload)}`, expires: new Date(exp * 1000).toISOString().slice(0, 10) };
}

export function verifyShareToken(token: string): { companyId: number; expires: string } | { error: "invalid" | "expired" } {
  if (!process.env.APP_PASSWORD) return { error: "invalid" };
  const parts = token.split(".");
  if (parts.length !== 3) return { error: "invalid" };
  const [id, exp, sig] = parts;
  const expected = sign(`${id}.${exp}`);
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { error: "invalid" };
  const expNum = Number(exp), idNum = Number(id);
  if (!Number.isInteger(expNum) || !Number.isInteger(idNum)) return { error: "invalid" };
  if (expNum < Math.floor(Date.now() / 1000)) return { error: "expired" };
  return { companyId: idNum, expires: new Date(expNum * 1000).toISOString().slice(0, 10) };
}
