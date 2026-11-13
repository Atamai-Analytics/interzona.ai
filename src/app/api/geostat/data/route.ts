import { NextRequest, NextResponse } from "next/server";
import { fetchSeries, parseDataRequest } from "@/lib/geostat/data";
import { getSession } from "@/lib/auth";
import { getInvite } from "@/lib/invites";
import { recordActivity } from "@/lib/activity";

export const dynamic = "force-dynamic";

// Geostatistics page, step 2: the sample values of one series (one value per sample, with detection limits). The variogram, kriging and
// cross-validation run in the browser on these points. Each load is noted on the owner's Activity page (dataset and counts only).
export async function POST(req: NextRequest) {
  let parsed;
  try {
    parsed = parseDataRequest(await req.json());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Bad request." }, { status: 400 });
  }
  try {
    const out = await fetchSeries(parsed);
    const session = await getSession(req);
    const invite = session?.r === "guest" && session.i ? await getInvite(session.i).catch(() => null) : null;
    await recordActivity({
      kind: "geostat_load",
      who: session?.r === "guest" ? { role: "guest", name: invite?.name, inviteId: session.i } : { role: "owner" },
      detail: `${parsed.element} ${out.points.length.toLocaleString("en-US")} of ${out.matching.toLocaleString("en-US")} samples; ${parsed.source} ${parsed.sampleType}; ${parsed.series.method ?? "method not recorded"}`,
    });
    return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const msg = String(e);
    console.error("[geostat/data] failed:", msg.slice(0, 200));
    if (/Only soil/.test(msg)) return NextResponse.json({ error: (e as Error).message }, { status: 400 });
    const timeout = /statement timeout/i.test(msg);
    return NextResponse.json({ error: timeout ? "That selection took too long. Use a smaller area and try again." : "The samples could not be loaded." }, { status: 503 });
  }
}
