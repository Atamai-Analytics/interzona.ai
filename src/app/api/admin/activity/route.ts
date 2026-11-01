import { NextResponse } from "next/server";
import { activitySummary } from "@/lib/activity";
import { listInvites } from "@/lib/invites";
import { listFeedback } from "@/lib/feedback";

export const dynamic = "force-dynamic";

// The owner's Activity page data (the middleware allows /api/admin for the owner only): daily totals for 30 days, tool use, the latest events,
// each invitation's totals and the feedback counts.
export async function GET() {
  try {
    const [summary, invites, feedback] = await Promise.all([activitySummary(30, 300), listInvites(), listFeedback(1)]);
    return NextResponse.json(
      {
        ...summary,
        invites: invites.map((i) => ({ id: i.id, name: i.name, status: i.status, dailyLimit: i.dailyLimit, expires: i.expires, stats: i.stats })),
        feedback: feedback.counts,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    console.error("[admin/activity] failed:", String(e).slice(0, 200));
    return NextResponse.json({ error: "The activity data could not be loaded." }, { status: 503 });
  }
}
