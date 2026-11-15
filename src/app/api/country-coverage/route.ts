import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";

export const dynamic = "force-dynamic";

// World coverage map (/tools/coverage): per-country counts from core.country_coverage, which the data script
// gold_schema/build_country_coverage.py rebuilds after data loads (signed-in visitors only, via the middleware).
// Not /api/coverage: that one serves the intro headline figures.
export async function GET() {
  try {
    const { rows } = await getPool().query(
      `SELECT adm0_a3 AS a3, name, samples::float8 AS samples, analyses::float8 AS analyses, occurrences::float8 AS occurrences,
              deposits::float8 AS deposits, drill_holes::float8 AS drill_holes, documents::float8 AS documents, sample_sources, updated_at
         FROM core.country_coverage
        WHERE samples + analyses + occurrences + drill_holes + documents > 0
        ORDER BY samples DESC`
    );
    return NextResponse.json({ rows }, { headers: { "Cache-Control": "private, max-age=600" } });
  } catch (e) {
    console.error("[country-coverage] failed:", String(e).slice(0, 200));
    return NextResponse.json({ error: "The database is not available right now." }, { status: 503 });
  }
}
