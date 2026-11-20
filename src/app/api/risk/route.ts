import { NextRequest, NextResponse } from "next/server";
import { supplyRisk } from "@/lib/risk";

export const dynamic = "force-dynamic";

// Supply-risk page (/tools/risk): the league table (no mineral) or one mineral's stages with an optional importer view, from the same
// code as the chat's supply_risk tool (signed-in visitors only, via the middleware). Database only, no model cost.
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  try {
    const out = await supplyRisk({ commodity: p.get("mineral") ?? undefined, importer: p.get("importer") ?? undefined, rank_by: p.get("rank_by") ?? undefined, top_n: 40 });
    let data: unknown;
    try { data = JSON.parse(out.content); } catch { return NextResponse.json({ error: out.content }, { status: 400 }); }
    return NextResponse.json({ data, datasets: out.datasets ?? [] }, { headers: { "Cache-Control": "private, max-age=300" } });
  } catch (e) {
    console.error("[risk] failed:", String(e).slice(0, 200));
    return NextResponse.json({ error: "The risk figures could not be loaded. Please try again." }, { status: 503 });
  }
}
