import { NextRequest, NextResponse } from "next/server";
import { fetchLocations } from "@/lib/geostat/data";

export const dynamic = "force-dynamic";

// Geostatistics page, area picker: where the samples of one dataset, sample type and element are (extent + up to 4,000 locations).
export async function POST(req: NextRequest) {
  const b = ((await req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.length > 0 && v.length <= 120 ? v : null);
  const source = str(b.source), sampleType = str(b.sampleType), element = str(b.element);
  if (!source || !sampleType || !element) return NextResponse.json({ error: "Choose a dataset, sample type and element." }, { status: 400 });
  try {
    return NextResponse.json(await fetchLocations({ source, sampleType, element }), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const msg = String(e);
    if (/Only soil|Choose an element/.test(msg)) return NextResponse.json({ error: (e as Error).message }, { status: 400 });
    console.error("[geostat/locations] failed:", msg.slice(0, 200));
    return NextResponse.json({ error: "The sample locations could not be loaded." }, { status: 503 });
  }
}
