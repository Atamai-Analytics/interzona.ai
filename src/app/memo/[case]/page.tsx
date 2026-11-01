import type { Metadata } from "next";
import Link from "next/link";
import { MemoView } from "@/components/MemoView";
import { MemoActions } from "@/components/MemoActions";
import { getMemo } from "@/lib/memo";
import { MEMO_CASES } from "@/lib/memo-cases";

export const dynamic = "force-dynamic";
export const maxDuration = 180;
export const metadata: Metadata = { title: "Investor memo | Interzona", robots: { index: false, follow: false } };

export default async function MemoPage({ params }: { params: Promise<{ case: string }> }) {
  const { case: id } = await params;
  const c = MEMO_CASES[decodeURIComponent(id)];
  if (!c) {
    return (
      <div className="min-h-screen bg-white p-8 text-sm text-gray-900">
        <p className="mb-2 font-semibold">No memo called “{decodeURIComponent(id)}”.</p>
        <ul className="list-disc pl-5">
          {Object.values(MEMO_CASES).map((m) => (
            <li key={m.id}>
              <Link className="text-blue-700 underline" href={`/memo/${m.id}`}>
                {m.title}
              </Link>
            </li>
          ))}
        </ul>
        <p className="mt-4">
          <Link className="text-blue-700 underline" href="/">
            ← Back to the assistant
          </Link>
        </p>
      </div>
    );
  }
  const memo = await getMemo(c.id);
  return (
    <div className="min-h-screen bg-gray-100 print:bg-white">
      <MemoActions caseId={c.id} />
      <MemoView m={memo} />
    </div>
  );
}
