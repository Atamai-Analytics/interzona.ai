import type { Metadata } from "next";
import Link from "next/link";
import { RequestsAdmin } from "@/components/RequestsAdmin";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Requests | Interzona", robots: { index: false, follow: false } };

export default function Requests() {
  return (
    <main className="min-h-screen bg-gray-950 p-6 text-gray-100">
      <div className="mx-auto max-w-2xl">
        <div className="mb-2 flex items-baseline justify-between">
          <h1 className="text-lg font-semibold">Improvement requests</h1>
          <div className="flex gap-4 text-xs text-gray-400">
            <Link href="/admin/activity" className="underline">
              Activity
            </Link>
            <Link href="/admin/invites" className="underline">
              Invitations
            </Link>
            <Link href="/admin/feedback" className="underline">
              Feedback
            </Link>
            <Link href="/" className="underline">
              Back to the app
            </Link>
          </div>
        </div>
        <p className="mb-6 text-sm text-gray-400">
          Requests for data, coverage or features sent with &quot;Suggest an improvement&quot;, newest first. Guests are shown by the name on their invitation, with
          who invited them; an inviter sees only the requests from their own invitees.
        </p>
        <RequestsAdmin />
      </div>
    </main>
  );
}
