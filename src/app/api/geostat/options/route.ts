import { NextResponse } from "next/server";
import { geostatOptions } from "@/lib/geostat/data";

export const dynamic = "force-dynamic";

// Geostatistics page: datasets x sample types that can be gridded (soil, till, lake sediment) and the elements each holds (signed-in visitors only, via the middleware).
export async function GET() {
  try {
    return NextResponse.json(await geostatOptions(), { headers: { "Cache-Control": "private, max-age=600" } });
  } catch (e) {
    console.error("[geostat/options] failed:", String(e).slice(0, 200));
    return NextResponse.json({ error: "The database is not available right now." }, { status: 503 });
  }
}
