import type { Metadata } from "next";
import Link from "next/link";
import { SnapshotView } from "@/components/SnapshotView";
import { SnapshotActions } from "@/components/SnapshotActions";
import { buildSnapshot, listSnapshotCompanies } from "@/lib/snapshot";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Company snapshot | Interzona", robots: { index: false, follow: false } };

export default async function SnapshotPage({ params }: { params: Promise<{ company: string }> }) {
  const { company } = await params;
  const name = decodeURIComponent(company);
  const snap = await buildSnapshot(name);
  if (!snap) {
    const list = await listSnapshotCompanies();
    return (
      <div className="min-h-screen bg-white p-8 text-sm text-gray-900">
        <p className="mb-2 font-semibold">No snapshot for “{name}”.</p>
        <p className="mb-3 text-gray-600">A snapshot needs at least a few years of company statements. Companies available:</p>
        <ul className="list-disc pl-5">
          {list.map((c) => (
            <li key={c.name}>
              <a className="text-blue-700 underline" href={`/snapshot/${encodeURIComponent(c.name)}`}>{c.name}</a> <span className="text-gray-500">({c.years} years)</span>
            </li>
          ))}
        </ul>
        <p className="mt-4"><Link className="text-blue-700 underline" href="/">← Back to the assistant</Link></p>
      </div>
    );
  }
  return (
    <div className="min-h-screen bg-gray-100 print:bg-white">
      <SnapshotActions company={snap.company.name} years={snap.history.years} rows={snap.history.rows} canShare />
      <SnapshotView s={snap} />
    </div>
  );
}
