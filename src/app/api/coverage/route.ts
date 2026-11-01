import { NextResponse } from "next/server";
import { getCoverage } from "@/lib/coverage";

export const dynamic = "force-dynamic";

// Headline figures about the data, for the intro panel (open to any signed-in visitor, including invited guests).
export async function GET() {
  try {
    return NextResponse.json(await getCoverage(), { headers: { "Cache-Control": "private, max-age=600" } });
  } catch (e) {
    console.error("[coverage] failed:", String(e).slice(0, 200));
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}
