"use client";

import { useState } from "react";

// "Share this answer" under a finished answer: makes a 30-day link to a frozen copy of this one question and answer (the server keeps the answer for a day for this).
export function ShareAnswer({ answerId }: { answerId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function share() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/answer-share", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: answerId }) });
      const j = (await res.json().catch(() => null)) as { url?: string; expires?: string; error?: string } | null;
      if (!res.ok || !j?.url) throw new Error(j?.error ?? `Request failed (${res.status})`);
      setUrl(j.url);
      let copied = false;
      try {
        await navigator.clipboard.writeText(j.url);
        copied = true;
      } catch {
        /* the link is shown below to copy by hand */
      }
      setMsg(`${copied ? "Link copied. " : ""}Anyone with it can see this question and answer (not the rest of your conversation) until ${j.expires}.`);
    } catch (e) {
      setMsg((e as Error).message);
    }
    setBusy(false);
  }

  return (
    <div className="mt-2 text-xs text-gray-500">
      <button className="rounded-md border border-gray-700 px-2 py-0.5 text-xs text-gray-300 hover:bg-gray-700 disabled:opacity-50" disabled={busy} onClick={share}>
        {busy ? "Working…" : url ? "🔗 Copy link again" : "🔗 Share this answer"}
      </button>
      {msg && <span className="ml-2">{msg}</span>}
      {url && <input readOnly value={url} onFocus={(e) => e.currentTarget.select()} className="mt-1 block w-full rounded border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-300" />}
    </div>
  );
}
