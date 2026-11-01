import type { Metadata } from "next";
import Link from "next/link";
import { DemoAdmin } from "@/components/DemoAdmin";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Saved answers | Interzona", robots: { index: false, follow: false } };

export default function Demos() {
  return (
    <main className="min-h-screen bg-gray-950 p-6 text-gray-100">
      <div className="mx-auto max-w-2xl">
        <div className="mb-2 flex items-baseline justify-between">
          <h1 className="text-lg font-semibold">Saved answers for the demo cards</h1>
          <div className="flex gap-4 text-xs text-gray-400">
            <Link href="/admin/activity" className="underline">
              Activity
            </Link>
            <Link href="/admin/feedback" className="underline">
              Feedback
            </Link>
            <Link href="/admin/invites" className="underline">
              Invitations
            </Link>
          </div>
        </div>
        <p className="mb-6 text-sm text-gray-400">
          A card with a saved answer responds instantly and at no model cost. Recording asks the question live (it uses model credits once), then you read the draft and approve it. Anyone who types
          the question in different words still gets a live answer.
        </p>
        <DemoAdmin />
      </div>
    </main>
  );
}
