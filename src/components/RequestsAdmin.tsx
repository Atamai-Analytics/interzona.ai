"use client";

import { useEffect, useMemo, useState } from "react";

type Entry = { id: string; t: number; kind: string; text: string; about: string; who: { r: "owner" | "guest"; name?: string; invitedBy?: string } };
const KIND_LABEL: Record<string, string> = { coverage: "Missing data or coverage", feature: "New feature or tool", wrong: "Something wrong in an answer", other: "Other" };
const when = (s: number) => new Date(s * 1000).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });

export function RequestsAdmin() {
  const [items, setItems] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState("all");

  useEffect(() => {
    fetch("/api/requests")
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error((d as { error?: string }).error ?? `Request failed (${r.status})`);
        setItems((d as { items: Entry[] }).items);
      })
      .catch((e) => setError((e as Error).message));
  }, []);

  const shown = useMemo(() => (items ?? []).filter((e) => kind === "all" || e.kind === kind), [items, kind]);
  if (error) return <p className="rounded-md border border-red-800 bg-red-950/40 p-3 text-sm text-red-300">{error}</p>;
  if (!items) return <p className="text-sm text-gray-500">Loading…</p>;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 text-xs">
        {["all", ...Object.keys(KIND_LABEL)].map((k) => (
          <button key={k} onClick={() => setKind(k)} className={`rounded-md border px-2 py-1 ${kind === k ? "border-gray-300 text-gray-100" : "border-gray-700 text-gray-400"}`}>
            {k === "all" ? `All (${items.length})` : `${KIND_LABEL[k]} (${items.filter((e) => e.kind === k).length})`}
          </button>
        ))}
      </div>
      {shown.length === 0 && <p className="text-sm text-gray-500">None yet.</p>}
      {shown.map((e) => (
        <div key={e.id} className="rounded-lg border border-gray-800 p-3 text-sm">
          <p className="text-xs text-gray-400">
            {when(e.t)} · {e.who.r === "guest" ? e.who.name ?? "Guest" : "You"}
            {e.who.invitedBy && <span className="ml-1 rounded bg-sky-900/50 px-1.5 py-0.5 text-sky-300">invited by {e.who.invitedBy}</span>} · {KIND_LABEL[e.kind] ?? e.kind}
            {e.about && <> · {e.about}</>}
          </p>
          <p className="mt-1 whitespace-pre-wrap">{e.text}</p>
        </div>
      ))}
    </div>
  );
}
