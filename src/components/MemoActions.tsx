"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

export function MemoActions({ caseId }: { caseId: string }) {
  const [link, setLink] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [owner, setOwner] = useState(false);

  useEffect(() => {
    fetch("/api/session")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setOwner(d?.role === "owner"))
      .catch(() => undefined);
  }, []);

  async function call(action: "share" | "refresh") {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/memo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ case: caseId, action }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Request failed.");
      if (action === "refresh") {
        window.location.reload();
        return;
      }
      setLink(j.url);
      try {
        await navigator.clipboard.writeText(j.url);
        setMsg(`Link copied. Anyone with it can view this memo (as it is today) until ${j.expires}.`);
      } catch {
        setMsg(`Anyone with this link can view this memo (as it is today) until ${j.expires}.`);
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }

  const btn = "rounded border border-gray-400 bg-white px-3 py-1 text-xs text-gray-800 hover:border-blue-600 disabled:opacity-50";
  return (
    <div className="mx-auto mb-3 flex max-w-[820px] flex-wrap items-center gap-2 px-4 md:px-8 pt-4 print:hidden">
      <Link href="/" className={btn}>
        ← Back to the assistant
      </Link>
      <button className={btn} onClick={() => window.print()}>
        Print / save as PDF
      </button>
      <button className={btn} onClick={() => call("share")} disabled={busy}>
        {busy ? "Working…" : "Create share link (30 days)"}
      </button>
      {owner && (
        <button className={btn} onClick={() => call("refresh")} disabled={busy}>
          Rebuild with today&apos;s data
        </button>
      )}
      {msg && <span className="text-xs text-gray-600">{msg}</span>}
      {link && <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} className="w-full rounded border border-gray-300 px-2 py-1 text-xs text-gray-700" />}
    </div>
  );
}
