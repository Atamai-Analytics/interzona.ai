import { NextRequest, NextResponse } from "next/server";
import { loadIntervals } from "@/lib/drill-extract";
import { getSession } from "@/lib/auth";
import { getInvite } from "@/lib/invites";
import { recordActivity } from "@/lib/activity";

export const dynamic = "force-dynamic";

// Downhole assay intervals of the chosen holes, for the Drill intercepts page (signed-in visitors only). Each load is noted on the owner's Activity
// page with the element and counts only.
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request." }, { status: 400 });
  }
  try {
    const out = await loadIntervals(body);
    if ("error" in out) return NextResponse.json(out, { status: 400 });
    const session = await getSession(req);
    const invite = session?.r === "guest" && session.i ? await getInvite(session.i).catch(() => null) : null;
    const holes = Array.isArray(body.holes) ? body.holes.length : 0;
    await recordActivity({
      kind: "intercepts_load",
      who: session?.r === "guest" ? { role: "guest", name: invite?.name, inviteId: session.i } : { role: "owner" },
      detail: `Drill intercepts: ${out.intervals.length.toLocaleString("en-US")} intervals from ${holes} holes, ${String(body.element)}${body.secondary ? " + " + String(body.secondary) : ""}; ${out.sources.join(", ")}`,
    });
    return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[drill/intervals] failed:", String(e).slice(0, 200));
    const timeout = /statement timeout|canceling statement/i.test(String(e));
    return NextResponse.json({ error: timeout ? "That took too long. Choose fewer holes and try again." : "The intervals could not be loaded." }, { status: 503 });
  }
}
