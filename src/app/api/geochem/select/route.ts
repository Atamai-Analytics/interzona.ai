import { NextRequest, NextResponse } from "next/server";
import { parseSelect, selectSamples } from "@/lib/geochem-select";

export const dynamic = "force-dynamic";

// Geochemistry page, step 1: draw the samples and say how many of them each analysis can use (signed-in visitors only, via the middleware).
// No model or sandbox cost, so it is not counted as a question.
export async function POST(req: NextRequest) {
  let parsed;
  try {
    parsed = parseSelect(await req.json());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Bad request." }, { status: 400 });
  }
  try {
    return NextResponse.json(await selectSamples(parsed), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[geochem/select] failed:", String(e).slice(0, 200));
    const timeout = /statement timeout/i.test(String(e));
    return NextResponse.json({ error: timeout ? "That selection took too long. Narrow it (fewer datasets or a smaller area) and try again." : "The samples could not be selected." }, { status: 503 });
  }
}
