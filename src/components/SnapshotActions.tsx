"use client";

import { useState } from "react";
import Link from "next/link";

type Row = { label: string; unit: string; values: (number | null)[] };

function csvText(name: string, years: number[], rows: Row[]) {
  const esc = (v: string | number | null) => (v === null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const lines = [["Company", "Measure", "Unit", ...years], ...rows.map((r) => [name, r.label, r.unit, ...r.values])];
  return "﻿" + lines.map((l) => l.map(esc).join(",")).join("\r\n");
}

export function SnapshotActions({ company, years, rows, canShare }: { company: string; years: number[]; rows: Row[]; canShare: boolean }) {
  const [link, setLink] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function share() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/snapshot", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ company }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not create a link.");
      setLink(j.url);
      try {
        await navigator.clipboard.writeText(j.url);
        setMsg(`Link copied. Anyone with it can view this snapshot until ${j.expires}.`);
      } catch {
        setMsg(`Anyone with this link can view this snapshot until ${j.expires}.`);
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Could not create a link.");
    } finally {
      setBusy(false);
    }
  }

  function download() {
    const blob = new Blob([csvText(company, years, rows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${company.replace(/[^a-z0-9]+/gi, "_")}_financials.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const btn = "rounded border border-gray-400 bg-white px-3 py-1 text-xs text-gray-800 hover:border-blue-600 disabled:opacity-50";
  return (
    <div className="mx-auto mb-3 flex max-w-[820px] flex-wrap items-center gap-2 px-4 md:px-8 pt-4 print:hidden">
      {canShare && <Link href="/" className={btn}>← Back to the assistant</Link>}
      <button className={btn} onClick={() => window.print()}>Print / save as PDF</button>
      <button className={btn} onClick={download}>Download financials (CSV)</button>
      {canShare && (
        <button className={btn} onClick={share} disabled={busy}>
          {busy ? "Creating…" : "Create share link (30 days)"}
        </button>
      )}
      {msg && <span className="text-xs text-gray-600">{msg}</span>}
      {link && <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} className="w-full rounded border border-gray-300 px-2 py-1 text-xs text-gray-700" />}
    </div>
  );
}
