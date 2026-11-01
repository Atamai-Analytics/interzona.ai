import type { Metadata } from "next";
import Link from "next/link";
import { ActivityAdmin } from "@/components/ActivityAdmin";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Activity | Interzona", robots: { index: false, follow: false } };

export default function Activity() {
  return (
    <main className="min-h-screen bg-gray-950 p-6 text-gray-100">
      <div className="mx-auto max-w-4xl">
        <div className="mb-2 flex items-baseline justify-between">
          <h1 className="text-lg font-semibold">Activity</h1>
          <div className="flex gap-4 text-xs text-gray-400">
            <Link href="/" className="underline">
              Assistant
            </Link>
            <Link href="/admin/invites" className="underline">
              Invitations
            </Link>
            <Link href="/admin/feedback" className="underline">
              Feedback
            </Link>
            <Link href="/admin/demos" className="underline">
              Saved answers
            </Link>
          </div>
        </div>
        <p className="mb-6 text-sm text-gray-400">
          How the app is being used: questions from you, guests and automated tests, refused questions, problems, and Multivariate tools database loads.
          Only the question text, who asked, the tools used and cost are kept; Multivariate loads record the datasets and counts, never the data.
        </p>
        <ActivityAdmin />
      </div>
    </main>
  );
}
