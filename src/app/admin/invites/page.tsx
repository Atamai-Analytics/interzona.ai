import type { Metadata } from "next";
import Link from "next/link";
import { InviteAdmin } from "@/components/InviteAdmin";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Invitations | Interzona", robots: { index: false, follow: false } };

export default function Invites() {
  return (
    <main className="min-h-screen bg-gray-950 p-6 text-gray-100">
      <div className="mx-auto max-w-2xl">
        <div className="mb-6 flex items-baseline justify-between">
          <h1 className="text-lg font-semibold">Invitations</h1>
          <div className="flex gap-4 text-xs text-gray-400">
            <Link href="/admin/activity" className="underline">
              Activity
            </Link>
            <Link href="/admin/feedback" className="underline">
              Feedback
            </Link>
            <Link href="/admin/demos" className="underline">
              Saved answers
            </Link>
            <Link href="/" className="underline">
              Back to the app
            </Link>
          </div>
        </div>
        <InviteAdmin />
      </div>
    </main>
  );
}
