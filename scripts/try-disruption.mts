// Runs the supply_disruption tool directly (no model) and prints its statements and caveats, for checking scenarios by hand.
// Reads the database settings from .env.local (never printed). Run: npx tsx scripts/try-disruption.mts cobalt DRC [cut_pct] [stage]
import { readFileSync } from "node:fs";
for (const l of readFileSync(new URL("../.env.local", import.meta.url), "utf-8").split(/\r?\n/)) {
  const m = l.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}
const { supplyDisruption } = await import("../src/lib/disruption");
const [commodity, country, cut, stage] = process.argv.slice(2);
const t0 = Date.now();
const out = await supplyDisruption({ commodity, country, cut_pct: cut ? Number(cut) : undefined, stage });
const j = (() => { try { return JSON.parse(out.content); } catch { return null; } })();
if (!j) { console.log(out.content); process.exit(0); }
console.log(`${j.what}\n(${Date.now() - t0} ms; other stages: ${j.other_stages_available.join(", ")})\n`);
for (const s of j.statements) console.log("-", s);
console.log("\nCAVEATS:"); for (const c of j.caveats) console.log("*", c.slice(0, 220));
console.log(`\ndatasets: ${(out.datasets ?? []).map((d) => `${d.title} (${d.rows.length})`).join(" | ")}; maps: ${(out.maps ?? []).map((m) => m.points.length).join(",")}`);
if (j.past_restrictions?.length) console.log("last events:", JSON.stringify(j.past_restrictions.slice(-3)));
