"use client";

import { useMemo, useRef, useState } from "react";
import type { ConversationMeta } from "@/lib/types";

function groupLabel(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "Previous 7 days";
  if (days < 30) return "Previous 30 days";
  return "Older";
}

export function HistoryPanel({
  items,
  activeId,
  busy,
  onOpen,
  onDelete,
  onRename,
  onNew,
  onBackup,
  onImport,
}: {
  items: ConversationMeta[];
  activeId: string | null;
  busy: boolean;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onNew: () => void;
  onBackup: () => void;
  onImport: (file: File) => void;
}) {
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? items.filter((i) => i.title.toLowerCase().includes(needle) || i.searchText.includes(needle)) : items;
  }, [items, q]);

  const groups = useMemo(() => {
    const g = new Map<string, ConversationMeta[]>();
    for (const i of shown) g.set(groupLabel(i.updatedAt), [...(g.get(groupLabel(i.updatedAt)) ?? []), i]);
    return [...g.entries()];
  }, [shown]);

  const commit = () => {
    if (editing && draft.trim()) onRename(editing, draft.trim());
    setEditing(null);
  };

  return (
    <div>
      <button
        onClick={onNew}
        disabled={busy}
        className="mb-3 w-full rounded-lg border border-gray-700 px-3 py-2 text-left text-sm text-gray-200 hover:border-blue-500 hover:bg-gray-800 disabled:opacity-50"
      >
        ＋ New conversation
      </button>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search saved conversations…"
        className="mb-3 w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-1.5 text-xs text-gray-100 placeholder-gray-500 focus:border-blue-500 focus:outline-none"
      />
      {items.length === 0 && <p className="text-xs text-gray-500">Your conversations are saved here automatically after each answer.</p>}
      {items.length > 0 && shown.length === 0 && <p className="text-xs text-gray-500">No conversation matches “{q}”.</p>}
      {groups.map(([label, list]) => (
        <div key={label} className="mb-3">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">{label}</div>
          <ul className="space-y-0.5">
            {list.map((c) => (
              <li key={c.id} className={"group flex items-center gap-1 rounded-md " + (c.id === activeId ? "bg-gray-800" : "hover:bg-gray-900")}>
                {editing === c.id ? (
                  <input
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={commit}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commit();
                      if (e.key === "Escape") setEditing(null);
                    }}
                    className="m-1 w-full rounded border border-blue-500 bg-gray-900 px-2 py-1 text-xs text-gray-100 focus:outline-none"
                  />
                ) : (
                  <>
                    <button
                      onClick={() => onOpen(c.id)}
                      disabled={busy}
                      title={c.title}
                      className="min-w-0 flex-1 truncate px-2 py-1.5 text-left text-xs text-gray-200 disabled:opacity-50"
                    >
                      {c.title}
                    </button>
                    <button
                      onClick={() => {
                        setDraft(c.title);
                        setEditing(c.id);
                      }}
                      title="Rename"
                      aria-label={`Rename ${c.title}`}
                      className="hidden px-1 text-xs text-gray-500 hover:text-gray-200 group-hover:block"
                    >
                      ✎
                    </button>
                    <button
                      onClick={() => {
                        if (window.confirm(`Delete “${c.title}”? This cannot be undone.`)) onDelete(c.id);
                      }}
                      title="Delete"
                      aria-label={`Delete ${c.title}`}
                      className="hidden px-1.5 text-xs text-gray-500 hover:text-red-400 group-hover:block"
                    >
                      ✕
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
      <div className="mt-4 border-t border-gray-800 pt-3 text-[11px] text-gray-500">
        <p className="mb-2">Saved in this browser only. Use a backup to move conversations to another browser or device.</p>
        <div className="flex gap-2">
          <button onClick={onBackup} disabled={items.length === 0} className="rounded border border-gray-700 px-2 py-1 text-gray-300 hover:border-blue-500 disabled:opacity-40">
            Back up all
          </button>
          <button onClick={() => fileRef.current?.click()} className="rounded border border-gray-700 px-2 py-1 text-gray-300 hover:border-blue-500">
            Restore…
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onImport(f);
              e.target.value = "";
            }}
          />
        </div>
      </div>
    </div>
  );
}
