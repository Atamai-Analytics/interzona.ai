import type { Metadata } from "next";
import { SnapshotView } from "@/components/SnapshotView";
import { SnapshotActions } from "@/components/SnapshotActions";
import { buildSnapshotById } from "@/lib/snapshot";
import { verifyShareToken } from "@/lib/share";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Company snapshot | Interzona", robots: { index: false, follow: false } };

function Message({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-white p-8 text-sm text-gray-800">{children}</div>;
}

export default async function SharedSnapshot({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const v = verifyShareToken(decodeURIComponent(token));
  if ("error" in v) {
    return <Message>{v.error === "expired" ? "This share link has expired. Ask the sender for a new one." : "This share link is not valid."}</Message>;
  }
  const snap = await buildSnapshotById(v.companyId);
  if (!snap) return <Message>This snapshot is no longer available.</Message>;
  return (
    <div className="min-h-screen bg-gray-100 print:bg-white">
      <SnapshotActions company={snap.company.name} years={snap.history.years} rows={snap.history.rows} canShare={false} />
      <SnapshotView s={snap} sharedUntil={v.expires} />
    </div>
  );
}
