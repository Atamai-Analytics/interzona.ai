// Runs the supply_risk tool directly (no model). Run: npx tsx scripts/try-risk.mts [mineral|-] [importer] [rank_by]
import { readFileSync } from "node:fs";
for (const l of readFileSync(new URL("../.env.local", import.meta.url), "utf-8").split(/\r?\n/)) {
  const m = l.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}
const { supplyRisk } = await import("../src/lib/risk");
const [mineral, importer, rank_by] = process.argv.slice(2);
const t0 = Date.now();
const out = await supplyRisk({ commodity: mineral && mineral !== "-" ? mineral.replace(/_/g, " ") : undefined, importer, rank_by });
const j = (() => { try { return JSON.parse(out.content); } catch { return null; } })();
if (!j) { console.log(out.content); process.exit(0); }
console.log(`${j.what} (${Date.now() - t0} ms)`);
for (const s of j.statements) console.log("-", s);
if (j.rows) for (const r of j.rows) console.log(`  ${r.mineral} | ${r.stage} | rwHHI ${r.restriction_weighted_hhi} | HHI ${r.hhi} | ctl ${r.supply_under_export_controls_pct}% | any ${r.under_any_measure_incl_taxes_pct}% | new ${r.new_measures_2020_2024}`);
