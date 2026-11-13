import { NextRequest, NextResponse } from "next/server";
import { fetchCatchments } from "@/lib/geostat/data";

export const dynamic = "force-dynamic";

// Geostatistics page, stream sediments: the sample catchment basins of the loaded samples (signed-in visitors only, via the middleware).
export async function POST(req: NextRequest) {
  const b = ((await req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  const ids = Array.isArray(b.ids) ? b.ids.filter((v): v is string => typeof v === "string") : [];
  if (!ids.length) return NextResponse.json({ error: "Load samples first." }, { status: 400 });
  try {
    return NextResponse.json(await fetchCatchments(ids), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[geostat/catchments] failed:", String(e).slice(0, 200));
    return NextResponse.json({ error: "The catchments could not be loaded." }, { status: 503 });
  }
}
