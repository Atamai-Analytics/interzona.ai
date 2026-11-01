"use client";

import { useState } from "react";

export function AccessForm({ next }: { next: string }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/access/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
      if (res.ok) {
        window.location.assign(next);
        return;
      }
      setError(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? "Sign-in failed.");
    } catch {
      setError("Could not reach the server. Please try again.");
    }
    setBusy(false);
  }

  return (
    <form onSubmit={submit} className="mt-4 space-y-3">
      <label className="block text-xs text-gray-400" htmlFor="pw">
        Owner password
      </label>
      <input
        id="pw"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="w-full rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100 outline-none focus:border-gray-500"
      />
      {error && <p className="text-xs text-red-400">{error}</p>}
      <button type="submit" disabled={busy || !password} className="w-full rounded-md bg-gray-100 px-3 py-2 text-sm font-medium text-gray-900 disabled:opacity-50">
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
