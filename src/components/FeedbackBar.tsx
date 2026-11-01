"use client";

import { useState } from "react";
import type { Message } from "@/lib/types";

// "Was this helpful?" under a finished answer. Thumbs up is sent straight away; thumbs down opens a short optional comment box first.
// The choice is kept on the message (so it stays when the conversation is reopened) and one rating is sent per answer.
export function FeedbackBar({ question, answer, saved, value, onChange }: { question: string; answer: string; saved: boolean; value?: Message["feedback"]; onChange: (f: NonNullable<Message["feedback"]>) => void }) {
  const [drafting, setDrafting] = useState(false);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(rating: "up" | "down", text: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/feedback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rating, comment: text, question, answer, saved }) });
      if (!res.ok) {
        const msg = ((await res.json().catch(() => null)) as { error?: string } | null)?.error;
        throw new Error(msg ?? `Request failed (${res.status})`);
      }
      onChange({ rating, sent: true });
      setDrafting(false);
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  }

  if (value?.sent) {
    return (
      <p className="mt-2 text-xs text-gray-500">
        {value.rating === "up" ? "👍" : "👎"} Thanks, your feedback was sent to the host.
      </p>
    );
  }

  const btn = "rounded-md border border-gray-700 px-2 py-0.5 text-xs text-gray-300 hover:bg-gray-700 disabled:opacity-50";
  return (
    <div className="mt-2 text-xs text-gray-500">
      {!drafting ? (
        <div className="flex items-center gap-2">
          <span>Was this helpful?</span>
          <button className={btn} disabled={busy} onClick={() => send("up", "")} aria-label="Helpful">
            👍
          </button>
          <button className={btn} disabled={busy} onClick={() => setDrafting(true)} aria-label="Not helpful">
            👎
          </button>
          {error && <span className="text-red-400">{error}</span>}
        </div>
      ) : (
        <div className="space-y-2">
          <label className="block">
            What went wrong? (optional)
            <textarea
              className="mt-1 block w-full max-w-md rounded-md border border-gray-700 bg-gray-900 p-2 text-xs text-gray-100 outline-none focus:border-gray-500"
              rows={3}
              maxLength={800}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="For example: wrong number, missing a source, did not answer the question"
            />
          </label>
          <div className="flex items-center gap-2">
            <button className={btn} disabled={busy} onClick={() => send("down", comment)}>
              Send 👎
            </button>
            <button className={btn} disabled={busy} onClick={() => setDrafting(false)}>
              Cancel
            </button>
            {error && <span className="text-red-400">{error}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
