import { NextRequest, NextResponse } from "next/server";
import { latestPrices } from "@/lib/drill-extract";

export const dynamic = "force-dynamic";

// Latest monthly metal prices for the Drill intercepts page's metal equivalent (signed-in visitors only, via the middleware). ?elements=Au,Ag
export async function GET(req: NextRequest) {
  const elements = (req.nextUrl.searchParams.get("elements") ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 4);
  if (!elements.length) return NextResponse.json({ error: "Give elements, e.g. ?elements=Au,Ag" }, { status: 400 });
  try {
    return NextResponse.json({ prices: await latestPrices(elements) }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[drill/prices] failed:", String(e).slice(0, 200));
    return NextResponse.json({ error: "The prices could not be loaded." }, { status: 503 });
  }
}
