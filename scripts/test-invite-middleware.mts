// Checks the middleware's invitation gate with a mocked Upstash (fake fetch) and signed sessions. Run: npx tsx scripts/test-invite-middleware.mts
process.env.APP_PASSWORD = "test-password-not-real";
process.env.UPSTASH_REDIS_REST_URL = "https://redis.invalid";
process.env.UPSTASH_REDIS_REST_TOKEN = "fake";
const { NextRequest } = await import("next/server");
const { middleware } = await import("../src/middleware");
const { signSession, SESSION_COOKIE } = await import("../src/lib/session");

const now = Math.floor(Date.now() / 1000);
let store: Record<string, string | null> = {};
let down = false;
globalThis.fetch = (async (_url: string, init: { body: string }) => {
  if (down) throw new Error("network down");
  const cmds = JSON.parse(init.body) as string[][];
  return new Response(JSON.stringify(cmds.map((c) => ({ result: c[0] === "GET" ? store[c[1]] ?? null : null }))), { status: 200 });
}) as typeof fetch;

const ID = "abcdef123456";
const guest = await signSession({ r: "guest", i: ID, n: "Test", e: now + 3600 });
const owner = await signSession({ r: "owner", e: now + 3600 });
const req = (path: string, cookie: string, page: boolean) =>
  new NextRequest(new URL("https://app.example" + path), { headers: { cookie: `${SESSION_COOKIE}=${cookie}`, accept: page ? "text/html" : "application/json" } });
const result = (r: Response) => (r.status === 307 || r.status === 308 ? `redirect ${new URL(r.headers.get("location")!).pathname}${new URL(r.headers.get("location")!).search}` : r.headers.get("x-middleware-next") ? "pass" : `${r.status}`);

let fails = 0;
async function check(label: string, path: string, cookie: string, page: boolean, want: string) {
  const got = result(await middleware(req(path, cookie, page)));
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${got}${ok ? "" : ` (want ${want})`}`);
}
const set = (s: object | null) => (store = { [`invite:${ID}`]: s ? JSON.stringify(s) : null });

set({ id: ID, revoked: false, expires: now + 86400 });
await check("active guest, page", "/tools/geostatistics", guest, true, "pass");
await check("active guest, data API", "/api/geostat/data", guest, false, "pass");
set({ id: ID, revoked: true, expires: now + 86400 });
await check("revoked guest, page", "/tools/geochemistry", guest, true, "redirect /access?invite=revoked");
await check("revoked guest, data API", "/api/geochem/samples", guest, false, "403");
await check("revoked guest, /api/session still open", "/api/session", guest, false, "pass");
set({ id: ID, revoked: false, expires: now - 10 });
await check("expired guest, page", "/", guest, true, "redirect /access?invite=expired");
await check("expired guest, drill API", "/api/drill/intervals", guest, false, "403");
set(null);
await check("deleted invite, data API", "/api/coverage", guest, false, "403");
set({ id: ID, revoked: false, expires: now + 86400 });
down = true;
await check("Redis down, page loads", "/", guest, true, "pass");
await check("Redis down, data API waits", "/api/geostat/data", guest, false, "503");
down = false;
await check("guest on admin", "/api/admin/invites", guest, false, "403");
await check("owner unaffected", "/api/geostat/data", owner, false, "pass");
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
