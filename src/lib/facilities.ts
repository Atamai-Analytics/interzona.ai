import { runReadOnlyQuery } from "@/lib/db";
import type { Dataset, Evidence } from "@/lib/types";

// USGS facility lists (capacity) by country and commodity, from core.facility_list (newest figure per complex, 2024 Minerals Yearbook
// table plus older regional releases). Every count - total, by release, by stage, by stage and release, sites - and every row label is
// computed HERE and returned as ready-made statements and labelled rows, because answers that counted and labelled by hand kept
// contradicting their own tables.

type Out = { content: string; evidence?: Evidence[]; datasets?: Dataset[] };
type FRow = {
  n: number; stage_group: string; name: string; country: string; facility_key: string; data_year: number | null; release: string;
  commodities: string; capacity_as_published: string; capacity_sort: string | null; measure: string; shared_capacity_note: string | null;
  status: string | null; owners: string | null; position_accuracy: string | null; occurrence_id: number;
};

const esc = (s: string) => s.replace(/'/g, "''");
const STAGE_ORDER = ["Mine", "Brine operation", "Concentrator", "Smelter", "Refinery", "Other processing plant"];

/** "USGS Southwest Asia mineral-industry GIS compilation (Minerals Yearbook 2018 data)" -> "2018 data - USGS Southwest Asia compilation". */
function shortRelease(r: FRow): string {
  const m = r.release.match(/^(USGS .*?)(?: mineral-industry GIS compilation| global facilities table)?\s*\(Minerals Yearbook (\d{4}) data\)/);
  if (r.release.startsWith("USGS 2024 Minerals Yearbook")) return "2024 data - USGS 2024 Minerals Yearbook table";
  if (m) return `${m[2]} data - ${m[1].replace(/^USGS /, "USGS ")} compilation`;
  return r.data_year ? `${r.data_year} data - ${r.release}` : r.release;
}
const word = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export async function facilityList(input: Record<string, unknown>): Promise<Out> {
  const country = String(input.country ?? "").trim();
  const commodity = String(input.commodity ?? "").trim();
  const stage = String(input.stage ?? "").trim();
  const order = String(input.order ?? "stage") === "capacity" ? "capacity" : "stage";
  const limit = Math.max(5, Math.min(150, Number(input.limit) || 150));
  if (!country && !commodity) return { content: "Give a country and/or a commodity (e.g. country Zambia, commodity copper)." };

  const arg = (v: string) => (v ? `'${esc(v)}'` : "NULL");
  const sql = `SELECT * FROM core.facility_list(${arg(country)}, ${arg(commodity)}, ${arg(stage)}, false)`;
  const rows = (await runReadOnlyQuery(sql, 2000)).rows as unknown as FRow[];
  if (!rows.length) {
    return { content: `No USGS facility capacity rows for ${commodity || "any commodity"}${country ? ` in ${country}` : ""}${stage ? ` at stage ${stage}` : ""}. Country names must match the occurrence catalogue (e.g. 'Democratic Republic of the Congo' may be stored differently - try the common English name). The 2024 Yearbook table omits facilities located only to a province, so absence here is not proof there is none.` };
  }

  // ---- counts (all computed here) -------------------------------------------------------------------------------------------------------
  const total = rows.length;
  const sites = new Set(rows.map((r) => r.occurrence_id)).size;
  const rel = new Map<string, number>();
  const stg = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const lab = shortRelease(r);
    rel.set(lab, (rel.get(lab) ?? 0) + 1);
    if (!stg.has(r.stage_group)) stg.set(r.stage_group, new Map());
    const m = stg.get(r.stage_group)!;
    m.set(lab, (m.get(lab) ?? 0) + 1);
  }
  const relList = [...rel.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  const stages = [...stg.keys()].sort((a, b) => STAGE_ORDER.indexOf(a) - STAGE_ORDER.indexOf(b));
  const where = `${commodity ? `${commodity} ` : ""}facilities${country ? ` in ${country}` : ""}${stage ? ` (${stage} only)` : ""}`;

  const statements: string[] = [];
  statements.push(`The list has ${word(total, "facility line", "facility lines")} on ${word(sites, "site", "sites")} (${where}); a facility line is one USGS facility at one stage, so one complex can have a mine line and a smelter line.`);
  statements.push(`By release: ${relList.map(([l, n]) => `${n} from ${l}`).join("; ")}. Each facility appears once, with its newest USGS figure: older-release lines are facilities the 2024 table does not list (it omits facilities located only to a province).`);
  const sitesBy = (pred: (r: FRow) => boolean) => new Set(rows.filter(pred).map((r) => r.occurrence_id)).size;
  statements.push(`Distinct sites by stage (use these when the question asks how many plants, mines or facilities there are): ${stages.map((s) => `${s} ${sitesBy((r) => r.stage_group === s)}`).join("; ")}; all processing stages together (everything except mines and brine operations) ${sitesBy((r) => !["Mine", "Brine operation"].includes(r.stage_group))} sites. A site with both a mine and a plant counts under each of its stages, so these per-stage site counts add up to more than the ${sites} distinct sites - never add them together.`);
  statements.push(`By stage: ${stages.map((s) => { const m = stg.get(s)!; const t = [...m.values()].reduce((a, b) => a + b, 0); const parts = [...m.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([l, n]) => `${n} ${l.split(" - ")[0]}`); return `${s} ${t}${m.size > 1 ? ` (${parts.join(", ")})` : ` (${parts[0]})`}`; }).join("; ")}.`);
  // 2024 names are location text: a line can be named "... Smelter" while it is the mine line
  const misnamed = rows.filter((r) => (/\b(smelter|refinery|plant|concentrator)\b/i.test(r.name) && r.stage_group === "Mine") || (/\bmine\b/i.test(r.name) && r.stage_group !== "Mine"));
  if (misnamed.length) statements.push(`Names follow USGS's location text, not the stage: ${misnamed.slice(0, 6).map((r) => `'${r.name}' is a ${r.stage_group.toLowerCase()} line`).join("; ")}. Use the Stage column, not the name, to say what each line is.`);
  const noCap = rows.filter((r) => /^capacity not published$/i.test(r.capacity_as_published.trim()));
  if (noCap.length) {
    const byS = stages.map((s) => [s, noCap.filter((r) => r.stage_group === s).length] as const).filter(([, n]) => n > 0);
    statements.push(`${word(noCap.length, "line has", "lines have")} no published capacity (${byS.map(([s, n]) => `${s} ${n}`).join("; ")}); with capacity: ${total - noCap.length} lines. If a table leaves the no-capacity lines out, say "${total - noCap.length} lines with a published capacity; ${noCap.length} more without one" using these numbers.`);
  }
  const nameCount = new Map<string, number>();
  for (const r of rows) nameCount.set(`${r.name}|${r.stage_group}`, (nameCount.get(`${r.name}|${r.stage_group}`) ?? 0) + 1);
  const repeated = [...nameCount.entries()].filter(([, n]) => n > 1).map(([k, n]) => `'${k.split("|")[0]}' (${k.split("|")[1]}, ${n} lines)`);
  if (repeated.length) statements.push(`Some names repeat because USGS lists separate facilities under one name: ${repeated.slice(0, 6).join("; ")}. They are different lines - show each as its own row and never merge them.`);
  const shared = rows.filter((r) => r.shared_capacity_note).length;
  if (shared) statements.push(`${word(shared, "line shares", "lines share")} one capacity figure with other lines of the same complex - count that figure once and never add capacities across lines.`);
  const town = rows.filter((r) => r.position_accuracy === "TOWN_CENTROID").length;
  if (town) statements.push(`${word(town, "line is", "lines are")} placed at the named town (2024 table has no coordinates), so map positions are approximate.`);

  // ---- rows -------------------------------------------------------------------------------------------------------------------------
  const sorted = [...rows].sort((a, b) => order === "capacity"
    ? (Number(b.capacity_sort ?? -1) - Number(a.capacity_sort ?? -1))
    : (STAGE_ORDER.indexOf(a.stage_group) - STAGE_ORDER.indexOf(b.stage_group) || a.name.localeCompare(b.name)));
  const shown = sorted.slice(0, limit);
  const outRows = shown.map((r, i) => ({
    row: i + 1, stage: r.stage_group, facility: r.name, data_year: r.data_year, release: shortRelease(r),
    capacity_as_published: r.capacity_as_published, measure: r.measure, status_as_published: r.status, owners: r.owners,
    shared_capacity: r.shared_capacity_note ? "shared - count once" : null,
  }));
  const dataset: Dataset = {
    id: "facilities-" + Date.now().toString(36),
    title: `USGS facilities: ${where} (${total} lines on ${sites} sites)`,
    columns: ["#", "Stage", "Facility", "Data year", "Release", "Capacity (as published)", "Measure", "Status (USGS assumption)", "Owners"],
    rows: outRows.map((r) => [r.row, r.stage, r.facility, r.data_year, r.release, r.capacity_as_published, r.measure, r.status_as_published, r.owners]),
  };
  const releases = [...new Set(rows.map((r) => r.release))];

  return {
    content: JSON.stringify({
      what: `USGS facility capacity list: ${where}`,
      how_to_use:
        "Use 'statements' word for word for every count (total, sites, by release, by stage) - never count rows yourself and never write a split that is not in a statement. " +
        "Every table you show must have the columns Stage, Facility, Data year, Release, Capacity (as published) and Measure, filled from 'rows' for EVERY row (mines included). " +
        "One table row per entry in 'rows': never merge, group or summarise rows (no 'Baluba (2 lines)', no '5 facilities without capacity' row); if you leave rows out, say how many with the numbers in 'statements'. " +
        (order === "capacity" && total > shown.length ? `Rows are sorted by the largest published capacity number and cut to ${shown.length}; say 'top ${shown.length} of ${total}'. ` : "") +
        "Capacities of different stages or measures are never added. Status is USGS's assumption for the data year, not verified. Name every release in the source line.",
      statements,
      rows: outRows,
      rows_shown: shown.length,
      rows_total: total,
      source_lines: releases.map((r) => `U.S. Geological Survey, ${r}`),
    }),
    evidence: releases.map((r) => ({ kind: "data" as const, label: `U.S. Geological Survey, ${r}` })),
    datasets: [dataset],
  };
}
