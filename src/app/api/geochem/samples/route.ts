import { NextRequest, NextResponse } from "next/server";
import { fetchSamples, parseRequest, validColumns } from "@/lib/geochem-extract";
import { getSession } from "@/lib/auth";
import { getInvite } from "@/lib/invites";
import { recordActivity } from "@/lib/activity";

export const dynamic = "force-dynamic";

// A random sample of rows from geochem.sample_chemistry_wide for the Multivariate tools page (signed-in visitors only).
// Each load is noted on the owner's Activity page with the datasets and counts only, never the sample data.
export async function POST(req: NextRequest) {
  let parsed;
  try {
    parsed = parseRequest(await req.json(), await validColumns());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Bad request." }, { status: 400 });
  }
  try {
    const out = await fetchSamples(parsed);
    const session = await getSession(req);
    const invite = session?.r === "guest" && session.i ? await getInvite(session.i).catch(() => null) : null;
    const datasets = [...new Set(parsed.groups.map((g) => g.source))].join(", ");
    await recordActivity({
      kind: "multivariate_load",
      who: session?.r === "guest" ? { role: "guest", name: invite?.name, inviteId: session.i } : { role: "owner" },
      detail: `${out.rows.length.toLocaleString("en-US")} of ${out.matching.toLocaleString("en-US")} samples, ${parsed.columns.length} elements; ${datasets}${parsed.bbox ? "; area box" : ""}${out.restricted ? "; Greenland locked" : ""}`,
    });
    return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[geochem/samples] failed:", String(e).slice(0, 200));
    const timeout = /statement timeout/i.test(String(e));
    return NextResponse.json({ error: timeout ? "That selection took too long. Narrow it (fewer datasets or a smaller area) and try again." : "The samples could not be loaded." }, { status: 503 });
  }
}
