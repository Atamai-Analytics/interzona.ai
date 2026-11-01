// A tiny Redis client over Upstash's REST API (works in serverless and in the edge runtime), used for invites and usage logs.
// When no Redis is configured it falls back to an in-process stand-in so the app can be developed and tested locally; in production without
// Redis, callers are told (redisConfigured() is false) and must refuse to create anything that needs to persist.

type Cmd = (string | number)[];

const creds = () => {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ""), token } : null;
};

export const redisConfigured = () => creds() !== null;
/** True when the in-process stand-in is being used (local development only): data is lost on restart and is not shared between servers. */
export const redisIsStandIn = () => creds() === null;

export async function redis(commands: Cmd[]): Promise<unknown[]> {
  const c = creds();
  if (!c) return standIn(commands);
  const send = () =>
    fetch(`${c.url}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(commands),
      signal: AbortSignal.timeout(3000),
      cache: "no-store",
    });
  // The first request on a connection that sat idle during a long answer can time out; one retry opens a fresh connection (commands here are
  // idempotent or counters where one extra count is harmless).
  const r = await send().catch(() => send());
  if (!r.ok) throw new Error(`redis ${r.status}`);
  const out = (await r.json()) as { result?: unknown; error?: string }[];
  const bad = out.find((x) => x.error);
  if (bad) throw new Error(`redis: ${String(bad.error).slice(0, 120)}`);
  return out.map((x) => x.result ?? null);
}

export const redis1 = async (...cmd: Cmd) => (await redis([cmd]))[0];

// ---- Local stand-in (strings, hashes, lists, sets, simple expiry) ----------------------------------------------------------------------------
type Entry = { v: string | Map<string, string> | string[] | Set<string>; exp: number | null };
const g = globalThis as unknown as { __izRedis?: Map<string, Entry> };
const db = (g.__izRedis ??= new Map<string, Entry>());

function standIn(commands: Cmd[]): unknown[] {
  const now = Date.now();
  const live = (k: string) => {
    const e = db.get(k);
    if (e && e.exp !== null && e.exp <= now) {
      db.delete(k);
      return undefined;
    }
    return e;
  };
  return commands.map((c) => {
    const [name, key, ...a] = c as [string, string, ...(string | number)[]];
    const op = String(name).toUpperCase();
    const k = String(key);
    switch (op) {
      case "GET": {
        const e = live(k);
        return typeof e?.v === "string" ? e.v : null;
      }
      case "MGET":
        return [k, ...a.map(String)].map((x) => {
          const e = live(x);
          return typeof e?.v === "string" ? e.v : null;
        });
      case "SET": {
        const opts = a.slice(1).map((x) => String(x).toUpperCase());
        if (opts.includes("NX") && live(k)) return null;
        const exIdx = opts.indexOf("EX");
        db.set(k, { v: String(a[0]), exp: exIdx >= 0 ? now + Number(a.slice(1)[exIdx + 1]) * 1000 : null });
        return "OK";
      }
      case "DEL":
        return [k, ...a.map(String)].reduce((n, x) => n + (db.delete(x) ? 1 : 0), 0);
      case "EXISTS":
        return live(k) ? 1 : 0;
      case "INCR":
      case "INCRBY": {
        const by = op === "INCR" ? 1 : Number(a[0]);
        const e = live(k);
        const cur = e && typeof e.v === "string" ? Number(e.v) : 0;
        db.set(k, { v: String(cur + by), exp: e?.exp ?? null });
        return cur + by;
      }
      case "EXPIRE": {
        const e = live(k);
        if (!e) return 0;
        if (String(a[1] ?? "").toUpperCase() === "NX" && e.exp !== null) return 0;
        e.exp = now + Number(a[0]) * 1000;
        return 1;
      }
      case "SADD": {
        const e = live(k) ?? { v: new Set<string>(), exp: null };
        const s = e.v as Set<string>;
        let added = 0;
        for (const m of a.map(String)) {
          if (s.has(m)) continue;
          s.add(m);
          added++;
        }
        db.set(k, e);
        return added;
      }
      case "SREM": {
        const s = live(k)?.v as Set<string> | undefined;
        return s ? a.map(String).reduce((n, m) => n + (s.delete(m) ? 1 : 0), 0) : 0;
      }
      case "SMEMBERS":
        return [...(((live(k)?.v as Set<string>) ?? new Set()) as Set<string>)];
      case "HSET": {
        const e = live(k) ?? { v: new Map<string, string>(), exp: null };
        const h = e.v as Map<string, string>;
        for (let i = 0; i + 1 < a.length; i += 2) h.set(String(a[i]), String(a[i + 1]));
        db.set(k, e);
        return a.length / 2;
      }
      case "HGET":
        return ((live(k)?.v as Map<string, string> | undefined)?.get(String(a[0]))) ?? null;
      case "HGETALL": {
        const h = live(k)?.v as Map<string, string> | undefined;
        return h ? [...h.entries()].flat() : [];
      }
      case "HINCRBY": {
        const e = live(k) ?? { v: new Map<string, string>(), exp: null };
        const h = e.v as Map<string, string>;
        const next = Number(h.get(String(a[0])) ?? 0) + Number(a[1]);
        h.set(String(a[0]), String(next));
        db.set(k, e);
        return next;
      }
      case "LPUSH": {
        const e = live(k) ?? { v: [] as string[], exp: null };
        (e.v as string[]).unshift(...a.map(String));
        db.set(k, e);
        return (e.v as string[]).length;
      }
      case "LTRIM": {
        const e = live(k);
        if (e) e.v = (e.v as string[]).slice(Number(a[0]), Number(a[1]) + 1);
        return "OK";
      }
      case "LRANGE": {
        const l = (live(k)?.v as string[]) ?? [];
        const end = Number(a[1]);
        return l.slice(Number(a[0]), end < 0 ? undefined : end + 1);
      }
      default:
        throw new Error(`stand-in redis: unsupported command ${op}`);
    }
  });
}
