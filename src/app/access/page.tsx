import type { Metadata } from "next";
import { AccessForm } from "@/components/AccessForm";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sign in | Interzona", robots: { index: false, follow: false } };

const MESSAGES: Record<string, string> = {
  invalid: "That invitation link is not valid. Please check you copied the whole link, or ask for a new one.",
  expired: "This invitation has expired. Please ask for a new link.",
  revoked: "This invitation is no longer active. Please contact the person who invited you.",
  slow_down: "Too many attempts from this connection. Please wait a while and try again.",
  unavailable: "Invitations are temporarily unavailable. Please try again in a few minutes.",
};

export default async function Access({ searchParams }: { searchParams: Promise<{ invite?: string; next?: string }> }) {
  const sp = await searchParams;
  const notice = sp.invite ? (MESSAGES[sp.invite] ?? MESSAGES.invalid) : null;
  // Only same-site paths, so the sign-in page cannot be used to send someone elsewhere.
  const next = sp.next && /^\/(?!\/)[A-Za-z0-9/_-]*$/.test(sp.next) ? sp.next : "/";
  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-950 p-6 text-gray-100">
      <div className="w-full max-w-sm">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/interzona-mark.png" alt="Interzona" width={56} height={56} className="mb-4 h-14 w-14" />
        <h1 className="text-lg font-semibold">Interzona Critical Minerals AI Assistant</h1>
        {notice ? (
          <p className="mt-3 rounded-md border border-amber-700/60 bg-amber-950/40 p-3 text-sm text-amber-200">{notice}</p>
        ) : (
          <p className="mt-3 text-sm text-gray-400">This demo is by invitation. Please use the personal link you were sent.</p>
        )}
        <details className="mt-6 text-sm text-gray-400">
          <summary className="cursor-pointer select-none">Owner sign-in</summary>
          <AccessForm next={next} />
        </details>
      </div>
    </main>
  );
}
