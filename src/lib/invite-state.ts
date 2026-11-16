import { redis } from "@/lib/redis";

// Invitation status, without Node-only imports, so the middleware (edge runtime) can check it on every guest request.

export type InviteStatus = "active" | "expired" | "revoked";

export const inviteStatus = (i: { revoked: boolean; expires: number }): InviteStatus =>
  i.revoked ? "revoked" : i.expires < Math.floor(Date.now() / 1000) ? "expired" : "active";

/** Status of the invitation behind a guest session; a missing or unreadable record counts as revoked. Throws only if Redis cannot be reached. */
export async function readInviteStatus(id: string): Promise<InviteStatus> {
  if (!/^[a-f0-9]{12}$/.test(id)) return "revoked";
  const raw = (await redis([["GET", `invite:${id}`]]))[0];
  if (typeof raw !== "string") return "revoked";
  try {
    const inv = JSON.parse(raw) as { revoked?: unknown; expires?: unknown };
    if (typeof inv.expires !== "number") return "revoked";
    return inviteStatus({ revoked: inv.revoked === true, expires: inv.expires });
  } catch {
    return "revoked";
  }
}
