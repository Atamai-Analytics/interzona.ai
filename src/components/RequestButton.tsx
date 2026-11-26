"use client";

import { useState } from "react";

const KINDS: [string, string][] = [
  ["coverage", "Missing data or coverage"],
  ["feature", "New feature or tool"],
  ["wrong", "Something wrong in an answer"],
  ["other", "Other"],
];

// "Suggest an improvement": a small form in the app header for visitors to ask for data, coverage or features, or report a problem.
export function RequestButton() {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState("coverage");
  const [text, setText] = useState("");
  const [about, setAbout] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/requests", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, text, about }) });
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.ok) {
        setMsg({ ok: true, text: "Thank you, your request has been sent to the Interzona team." });
        setText("");
        setAbout("");
      } else setMsg({ ok: false, text: d.error ?? "Could not send your request." });
    } catch {
      setMsg({ ok: false, text: "Could not reach the server. Please try again." });
    }
    setBusy(false);
  }

  const field = "mt-1 w-full rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100 outline-none focus:border-gray-500";
  return (
    <>
      <button onClick={() => { setOpen(true); setMsg(null); }} className="text-xs text-sky-300 underline hover:text-sky-200" title="Ask for missing data or coverage, a new feature, or report something wrong">
        Suggest an improvement
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setOpen(false)}>
          <form onSubmit={send} onClick={(e) => e.stopPropagation()} className="w-full max-w-md space-y-3 rounded-lg border border-gray-700 bg-gray-950 p-5 text-left text-sm text-gray-100 shadow-xl">
            <div className="flex items-baseline justify-between">
              <h2 className="font-semibold">Suggest an improvement</h2>
              <button type="button" onClick={() => setOpen(false)} className="text-xs text-gray-400 hover:text-gray-200">Close</button>
            </div>
            <label className="block text-xs text-gray-400">
              What kind of request?
              <select value={kind} onChange={(e) => setKind(e.target.value)} className={field}>
                {KINDS.map(([k, label]) => (
                  <option key={k} value={k}>{label}</option>
                ))}
              </select>
            </label>
            <label className="block text-xs text-gray-400">
              What would you like?
              <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} maxLength={1500} className={field} placeholder="e.g. Add drill-hole assays for Western Australia; a map of lithium refineries; the 2025 cobalt price is missing" />
            </label>
            <label className="block text-xs text-gray-400">
              Country, region or commodity (optional)
              <input value={about} onChange={(e) => setAbout(e.target.value)} maxLength={120} className={field} />
            </label>
            <p className="text-[11px] text-gray-500">Requests go to the Interzona team, including the person who invited you.</p>
            {msg && <p className={`text-xs ${msg.ok ? "text-emerald-300" : "text-red-400"}`}>{msg.text}</p>}
            <button type="submit" disabled={busy || text.trim().length < 5} className="w-full rounded-md bg-gray-100 px-3 py-2 text-sm font-medium text-gray-900 disabled:opacity-50">
              {busy ? "Sending…" : "Send request"}
            </button>
          </form>
        </div>
      )}
    </>
  );
}
