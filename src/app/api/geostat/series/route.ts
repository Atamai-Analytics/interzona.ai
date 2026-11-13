import { NextRequest, NextResponse } from "next/server";
import { listSeries, parseSeriesRequest } from "@/lib/geostat/data";

export const dynamic = "force-dynamic";

// Geostatistics page, step 1b: the surveys, methods, fractions and units available for one dataset, sample type and element in the area.
export async function POST(req: NextRequest) {
  let parsed;
  try {
    parsed = parseSeriesRequest(await req.json());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Bad request." }, { status: 400 });
  }
  try {
    return NextResponse.json(await listSeries(parsed), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const msg = String(e);
    console.error("[geostat/series] failed:", msg.slice(0, 200));
    if (/Only soil/.test(msg)) return NextResponse.json({ error: (e as Error).message }, { status: 400 });
    const timeout = /statement timeout/i.test(msg);
    return NextResponse.json({ error: timeout ? "That area took too long to search. Use a smaller area and try again." : "The surveys could not be listed." }, { status: 503 });
  }
}
