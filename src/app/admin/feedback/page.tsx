import type { Metadata } from "next";
import Link from "next/link";
import { FeedbackAdmin } from "@/components/FeedbackAdmin";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Feedback | Interzona", robots: { index: false, follow: false } };

export default function Feedback() {
  return (
    <main className="min-h-screen bg-gray-950 p-6 text-gray-100">
      <div className="mx-auto max-w-2xl">
        <div className="mb-2 flex items-baseline justify-between">
          <h1 className="text-lg font-semibold">Answer feedback</h1>
          <div className="flex gap-4 text-xs text-gray-400">
            <Link href="/admin/activity" className="underline">
              Activity
            </Link>
            <Link href="/admin/invites" className="underline">
              Invitations
            </Link>
            <Link href="/admin/demos" className="underline">
              Saved answers
            </Link>
          </div>
        </div>
        <p className="mb-6 text-sm text-gray-400">Thumbs up and down that visitors gave to answers, newest first, with their comments. Guests are shown by the name on their invitation.</p>
        <FeedbackAdmin />
      </div>
    </main>
  );
}
