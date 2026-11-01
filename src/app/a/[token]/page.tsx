import type { Metadata } from "next";
import { AnswerView } from "@/components/AnswerView";
import { PrintButton } from "@/components/PrintButton";
import { getSharedAnswer } from "@/lib/shared-answers";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Shared answer | Interzona", robots: { index: false, follow: false } };

export default async function SharedAnswerPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const a = await getSharedAnswer(decodeURIComponent(token));
  if (!a) return <div className="min-h-screen bg-white p-8 text-sm text-gray-800">This link is not valid or has expired. Ask the sender for a new one.</div>;
  return (
    <div className="min-h-screen bg-gray-100 print:bg-white">
      <div className="mx-auto max-w-[820px] px-4 md:px-8 pt-4 print:hidden">
        <PrintButton />
      </div>
      <AnswerView a={a} />
    </div>
  );
}
