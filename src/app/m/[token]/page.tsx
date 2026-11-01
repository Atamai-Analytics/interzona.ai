import type { Metadata } from "next";
import { MemoView } from "@/components/MemoView";
import { PrintButton } from "@/components/PrintButton";
import { getSharedMemo } from "@/lib/memo";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Investor memo | Interzona", robots: { index: false, follow: false } };

export default async function SharedMemo({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const memo = await getSharedMemo(decodeURIComponent(token));
  if (!memo) return <div className="min-h-screen bg-white p-8 text-sm text-gray-800">This memo link is not valid or has expired. Ask the sender for a new one.</div>;
  return (
    <div className="min-h-screen bg-gray-100 print:bg-white">
      <div className="mx-auto max-w-[820px] px-4 md:px-8 pt-4 print:hidden">
        <PrintButton />
      </div>
      <MemoView m={memo} />
    </div>
  );
}
