"use client";

import { useCallback, useEffect, useState } from "react";

type Card = { hash: string; title: string; prompt: string; status: "none" | "approved" | "draft" | "both"; approvedAt: number | null; draftAt: number | null };
type Draft = { prompt: string; asOf: number; text: string; maps: number; datasets: number; images: number; sources: number };

const when = (s: number | null) => (s ? new Date(s * 1000).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "never");

async function api(body?: unknown, query = "") {
  const res = await fetch("/api/admin/demos" + query, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data;
}

export function DemoAdmin() {
  const [cards, setCards] = useState<Card[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState<string | null>(null);
  const [review, setReview] = useState<{ hash: string; draft: Draft } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setCards(((await api(undefined)) as { cards: Card[] }).cards);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  // Asks the card's question live, as the owner, with the recording header; the server stores the finished answer as a draft.
  async function record(c: Card) {
    setRecording(c.hash);
    setError(null);
    try {
      const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json", "x-demo-record": "1" }, body: JSON.stringify({ messages: [{ role: "user", content: c.prompt }] }) });
      if (!res.ok || !res.body) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `Request failed (${res.status})`);
      const reader = res.body.getReader();
      while (!(await reader.read()).done) {
        /* the answer is read to the end so the server can store it */
      }
      await new Promise((r) => setTimeout(r, 1500));
      await load();
      await showDraft(c.hash);
    } catch (e) {
      setError((e as Error).message);
    }
    setRecording(null);
  }

  async function showDraft(hash: string) {
    try {
      setReview({ hash, draft: (await api(undefined, `?draft=${hash}`)) as Draft });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function saveEdit(hash: string) {
    if (editing === null) return;
    try {
      await api({ action: "edit", hash, text: editing });
      setEditing(null);
      await showDraft(hash);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function act(body: { action: string; hash: string; which?: string }) {
    try {
      await api(body);
      if (body.action === "approve" || body.which === "draft") setReview(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const btn = "rounded-md border border-gray-700 px-2 py-1 text-xs disabled:opacity-50";
  return (
    <div className="space-y-3">
      {error && <p className="rounded-md border border-red-800 bg-red-950/40 p-3 text-sm text-red-300">{error}</p>}
      {cards === null ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : (
        cards.map((c) => (
          <div key={c.hash} className="rounded-lg border border-gray-800 p-3 text-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-medium">{c.title}</span>
              <span className={c.status === "approved" || c.status === "both" ? "text-emerald-400" : "text-gray-500"}>
                {c.status === "none" ? "not saved" : c.status === "draft" ? "draft only" : `saved ${when(c.approvedAt)}`}
              </span>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <button className={btn} disabled={recording !== null} onClick={() => record(c)}>
                {recording === c.hash ? "Recording… (up to a minute)" : c.status === "none" ? "Record answer" : "Record a new answer"}
              </button>
              {(c.status === "draft" || c.status === "both") && (
                <button className={btn} onClick={() => showDraft(c.hash)}>
                  Review draft ({when(c.draftAt)})
                </button>
              )}
              {(c.status === "approved" || c.status === "both") && (
                <button className={btn + " border-red-800 text-red-300"} onClick={() => act({ action: "remove", hash: c.hash, which: "approved" })}>
                  Stop using saved answer
                </button>
              )}
            </div>
            {review?.hash === c.hash && (
              <div className="mt-3 border-t border-gray-800 pt-3">
                <p className="text-xs text-gray-400">
                  Draft from {when(review.draft.asOf)}: {review.draft.maps} map(s), {review.draft.datasets} table(s), {review.draft.images} chart image(s), {review.draft.sources} source(s).
                </p>
                {editing === null ? (
                  <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded bg-gray-900 p-3 text-xs text-gray-200">{review.draft.text}</pre>
                ) : (
                  <textarea
                    className="mt-2 h-96 w-full rounded bg-gray-900 p-3 font-mono text-xs text-gray-200 outline-none"
                    value={editing}
                    onChange={(e) => setEditing(e.target.value)}
                  />
                )}
                <div className="mt-2 flex flex-wrap gap-2">
                  {editing === null ? (
                    <button className={btn} onClick={() => setEditing(review.draft.text)}>
                      Edit text
                    </button>
                  ) : (
                    <>
                      <button className={btn + " border-emerald-700 text-emerald-300"} onClick={() => saveEdit(c.hash)}>
                        Save edit
                      </button>
                      <button className={btn} onClick={() => setEditing(null)}>
                        Cancel edit
                      </button>
                    </>
                  )}
                  <button className={btn + " border-emerald-700 text-emerald-300"} disabled={editing !== null} onClick={() => act({ action: "approve", hash: c.hash })}>
                    Approve and use this answer
                  </button>
                  <button className={btn} onClick={() => act({ action: "remove", hash: c.hash, which: "draft" })}>
                    Discard draft
                  </button>
                </div>
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
}
