"use client";

import { useCallback, useEffect, useState } from "react";

type Row = {
  id: string;
  name: string;
  note: string;
  created: number;
  expires: number;
  dailyLimit: number;
  status: "active" | "expired" | "revoked";
  stats: { questions: number; units: number; lastSeen: number | null; up: number; down: number };
};
type LogRow = { t: number; q: string; units: number; tools?: string[] };

const when = (s: number | null) => (s ? new Date(s * 1000).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "never");
const STATUS_STYLE = { active: "text-emerald-400", expired: "text-amber-400", revoked: "text-red-400" } as const;

async function api(body?: unknown, query = "") {
  const res = await fetch("/api/admin/invites" + query, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data;
}

export function InviteAdmin() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [days, setDays] = useState(14);
  const [limit, setLimit] = useState(30);
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<{ name: string; link: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [openLog, setOpenLog] = useState<{ id: string; rows: LogRow[] } | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(((await api(undefined)) as { invites: Row[] }).invites);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const out = (await api({ action: "create", name, note, days, dailyLimit: limit })) as { invite: Row; link: string };
      setFresh({ name: out.invite.name, link: out.link });
      setCopied(false);
      setName("");
      setNote("");
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  }

  async function setRevoked(id: string, revoke: boolean) {
    try {
      await api({ action: revoke ? "revoke" : "restore", id });
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function showLog(id: string) {
    if (openLog?.id === id) return setOpenLog(null);
    try {
      setOpenLog({ id, rows: ((await api(undefined, `?log=${id}`)) as { log: LogRow[] }).log });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const field = "w-full rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100 outline-none focus:border-gray-500";
  return (
    <div className="space-y-8">
      {error && <p className="rounded-md border border-red-800 bg-red-950/40 p-3 text-sm text-red-300">{error}</p>}

      <form onSubmit={create} className="grid gap-3 rounded-lg border border-gray-800 p-4 sm:grid-cols-2">
        <h2 className="text-sm font-semibold sm:col-span-2">New invitation</h2>
        <label className="text-xs text-gray-400">
          Who is it for?
          <input className={field + " mt-1"} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Jane Smith, Acme Capital" maxLength={80} />
        </label>
        <label className="text-xs text-gray-400">
          Note (only you see this)
          <input className={field + " mt-1"} value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
        </label>
        <label className="text-xs text-gray-400">
          Valid for (days, 1–90)
          <input className={field + " mt-1"} type="number" min={1} max={90} value={days} onChange={(e) => setDays(Number(e.target.value))} />
        </label>
        <label className="text-xs text-gray-400">
          Questions per day (1–200)
          <input className={field + " mt-1"} type="number" min={1} max={200} value={limit} onChange={(e) => setLimit(Number(e.target.value))} />
        </label>
        <button type="submit" disabled={busy || !name.trim()} className="rounded-md bg-gray-100 px-3 py-2 text-sm font-medium text-gray-900 disabled:opacity-50 sm:col-span-2">
          {busy ? "Creating…" : "Create invitation link"}
        </button>
      </form>

      {fresh && (
        <div className="rounded-lg border border-emerald-700 bg-emerald-950/30 p-4 text-sm">
          <p className="font-medium text-emerald-300">Link for {fresh.name}</p>
          <p className="mt-1 text-xs text-gray-400">This is the only time the full link is shown. Copy it now and send it to them yourself.</p>
          <p className="mt-2 break-all rounded bg-gray-900 p-2 font-mono text-xs">{fresh.link}</p>
          <button
            className="mt-2 rounded-md border border-gray-600 px-3 py-1 text-xs"
            onClick={() => navigator.clipboard.writeText(fresh.link).then(() => setCopied(true))}
          >
            {copied ? "Copied" : "Copy link"}
          </button>
        </div>
      )}

      <section>
        <h2 className="mb-2 text-sm font-semibold">Invitations</h2>
        {rows === null ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-gray-500">None yet.</p>
        ) : (
          <div className="space-y-3">
            {rows.map((r) => (
              <div key={r.id} className="rounded-lg border border-gray-800 p-3 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">{r.name}</span>
                  <span className={STATUS_STYLE[r.status]}>{r.status}</span>
                </div>
                {r.note && <p className="text-xs text-gray-500">{r.note}</p>}
                <p className="mt-1 text-xs text-gray-400">
                  Expires {when(r.expires)} · {r.dailyLimit} questions/day · {r.stats.questions} asked · 👍 {r.stats.up} · 👎 {r.stats.down} · last seen {when(r.stats.lastSeen)} · {Math.round(r.stats.units / 1000).toLocaleString("en-US")}k cost units
                </p>
                <div className="mt-2 flex gap-2">
                  <button className="rounded-md border border-gray-700 px-2 py-1 text-xs" onClick={() => showLog(r.id)}>
                    {openLog?.id === r.id ? "Hide questions" : "Recent questions"}
                  </button>
                  {r.status === "revoked" ? (
                    <button className="rounded-md border border-gray-700 px-2 py-1 text-xs" onClick={() => setRevoked(r.id, false)}>
                      Switch back on
                    </button>
                  ) : (
                    <button className="rounded-md border border-red-800 px-2 py-1 text-xs text-red-300" onClick={() => setRevoked(r.id, true)}>
                      Switch off
                    </button>
                  )}
                </div>
                {openLog?.id === r.id && (
                  <ul className="mt-2 space-y-1 border-t border-gray-800 pt-2 text-xs text-gray-300">
                    {openLog.rows.length === 0 && <li className="text-gray-500">No questions yet.</li>}
                    {openLog.rows.map((l, k) => (
                      <li key={k}>
                        <span className="text-gray-500">{when(l.t)}</span> — {l.q}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
