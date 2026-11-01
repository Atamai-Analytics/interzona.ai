import { NextRequest, NextResponse } from "next/server";
import { companyIdByName, listSnapshotCompanies } from "@/lib/snapshot";
import { createShareToken } from "@/lib/share";

export const dynamic = "force-dynamic";

// Behind the app password like every other route. GET lists the companies that have enough statements for a snapshot;
// POST {company} creates a 30-day share link for that one snapshot.
export async function GET() {
  return NextResponse.json({ companies: await listSnapshotCompanies() });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const name = typeof body.company === "string" ? body.company.trim() : "";
  if (!name) return NextResponse.json({ error: "Name a company." }, { status: 400 });
  const id = await companyIdByName(name);
  if (!id) return NextResponse.json({ error: "No snapshot is available for that company." }, { status: 404 });
  const { token, expires } = createShareToken(id, 30);
  return NextResponse.json({ url: `${req.nextUrl.origin}/s/${encodeURIComponent(token)}`, expires });
}
