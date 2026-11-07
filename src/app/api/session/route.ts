import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getInvite, inviteStatus } from "@/lib/invites";
import { inviteQuestionsToday } from "@/lib/guard";

export const dynamic = "force-dynamic";

// Who the browser is signed in as, for the header of the app: the owner, or a guest with the invitation's remaining allowance for today.
export async function GET(req: NextRequest) {
  const s = await getSession(req);
  if (!s) return NextResponse.json({ role: "none" }, { status: 401 });
  if (s.r === "owner") return NextResponse.json({ role: "owner" });
  // A Redis timeout is not a revoked invitation: report the guest as signed in with an unknown allowance (the chat itself checks the
  // invitation again and asks them to retry if it still cannot be read), instead of telling them their invitation has ended.
  let invite: Awaited<ReturnType<typeof getInvite>> = null;
  try {
    invite = s.i ? await getInvite(s.i) : null;
  } catch (e) {
    console.error("[session] invite lookup failed:", String(e).slice(0, 120));
    return NextResponse.json({ role: "guest", name: s.n ?? "" });
  }
  if (!invite) return NextResponse.json({ role: "guest", name: s.n ?? "", ended: "revoked" });
  const status = inviteStatus(invite);
  if (status !== "active") return NextResponse.json({ role: "guest", name: invite.name, ended: status });
  const used = await inviteQuestionsToday(invite.id).catch(() => 0);
  return NextResponse.json({ role: "guest", name: invite.name, limit: invite.dailyLimit, left: Math.max(0, invite.dailyLimit - used), expires: invite.expires });
}
