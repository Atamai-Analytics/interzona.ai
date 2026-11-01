import { NextResponse } from "next/server";
import { getOptions } from "@/lib/geochem-extract";

export const dynamic = "force-dynamic";

// What the Multivariate tools page can load from geochem.sample_chemistry_wide: datasets, sample types and element coverage (signed-in visitors only).
export async function GET() {
  try {
    return NextResponse.json(await getOptions(), { headers: { "Cache-Control": "private, max-age=600" } });
  } catch (e) {
    console.error("[geochem/options] failed:", String(e).slice(0, 200));
    return NextResponse.json({ error: "The database is not available right now." }, { status: 503 });
  }
}
