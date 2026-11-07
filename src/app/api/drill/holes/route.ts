import { NextRequest, NextResponse } from "next/server";
import { findHoles } from "@/lib/drill-extract";

export const dynamic = "force-dynamic";

// Drill holes with downhole assay intervals for an element, for the Drill intercepts page (signed-in visitors only, via the middleware).
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request." }, { status: 400 });
  }
  try {
    const out = await findHoles(body);
    if ("error" in out) return NextResponse.json(out, { status: 400 });
    return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[drill/holes] failed:", String(e).slice(0, 200));
    const timeout = /statement timeout|canceling statement/i.test(String(e));
    return NextResponse.json({ error: timeout ? "That search took too long. Add a name or narrow the area and try again." : "The holes could not be loaded." }, { status: 503 });
  }
}
