"use client";

import { useEffect, useState } from "react";

type Entry = { id: string; t: number; rating: "up" | "down"; comment: string; q: string; a: string; saved: boolean; who: { r: "owner" | "guest"; inviteId?: string; name?: string } };

const when = (s: number) => new Date(s * 1000).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });

export function FeedbackAdmin() {
  const [data, setData] = useState<{ items: Entry[]; counts: { up: number; down: number } } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [only, setOnly] = useState<"all" | "down">("all");

  useEffect(() => {
    fetch("/api/feedback?limit=500")
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error((d as { error?: string }).error ?? `Request failed (${r.status})`);
        setData(d);
      })
      .catch((e) => setError((e as Error).message));
  }, []);

  if (error) return <p className="rounded-md border border-red-800 bg-red-950/40 p-3 text-sm text-red-300">{error}</p>;
  if (!data) return <p className="text-sm text-gray-500">Loading…</p>;
  const items = data.items.filter((e) => only === "all" || e.rating === "down");
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <span>
          👍 {data.counts.up} · 👎 {data.counts.down}
        </span>
        <div className="flex gap-1 text-xs">
          {(["all", "down"] as const).map((k) => (
            <button key={k} onClick={() => setOnly(k)} className={"rounded-md border px-2 py-1 " + (only === k ? "border-gray-400 text-gray-100" : "border-gray-700 text-gray-400")}>
              {k === "all" ? "All" : "Thumbs down only"}
            </button>
          ))}
        </div>
      </div>
      {items.length === 0 && <p className="text-sm text-gray-500">No feedback yet.</p>}
      {items.map((e) => (
        <div key={e.id} className="rounded-lg border border-gray-800 p-3 text-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span>
              {e.rating === "up" ? "👍" : "👎"} <span className="text-gray-400">{e.who.r === "guest" ? (e.who.name ?? "guest") : "owner"}</span>
              {e.saved && <span className="ml-2 rounded bg-gray-800 px-1.5 py-0.5 text-[11px] text-gray-400">saved answer</span>}
            </span>
            <span className="text-xs text-gray-500">{when(e.t)}</span>
          </div>
          {e.comment && <p className="mt-2 rounded bg-gray-900 p-2 text-gray-200">“{e.comment}”</p>}
          <p className="mt-2 text-xs text-gray-400">
            <span className="text-gray-500">Question:</span> {e.q}
          </p>
          <p className="mt-1 text-xs text-gray-500">
            <span>Answer began:</span> {e.a}
            {e.a.length >= 700 ? "…" : ""}
          </p>
        </div>
      ))}
    </div>
  );
}
