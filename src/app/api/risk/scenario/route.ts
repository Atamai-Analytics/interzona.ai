import { NextRequest, NextResponse } from "next/server";
import { supplyDisruption } from "@/lib/disruption";

export const dynamic = "force-dynamic";

// Scenario builder on the supply-risk page: runs the same code as the chat's supply_disruption tool (signed-in visitors only, via the
// middleware). Database only, no model cost.
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request." }, { status: 400 });
  }
  const input = { commodity: String(body.commodity ?? ""), country: String(body.country ?? ""), stage: body.stage ? String(body.stage) : undefined, cut_pct: Number(body.cut_pct) || 100 };
  try {
    const out = await supplyDisruption(input);
    let data: unknown;
    try { data = JSON.parse(out.content); } catch { return NextResponse.json({ error: out.content }, { status: 400 }); }
    return NextResponse.json({ data, datasets: out.datasets ?? [], maps: out.maps ?? [] }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[risk/scenario] failed:", String(e).slice(0, 200));
    const timeout = /statement timeout|canceling statement/i.test(String(e));
    return NextResponse.json({ error: timeout ? "The scenario took too long. Please try again." : "The scenario could not be run." }, { status: 503 });
  }
}
