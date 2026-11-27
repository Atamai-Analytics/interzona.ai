import { runReadOnlyQuery } from "@/lib/db";
import type { Dataset, Evidence } from "@/lib/types";

// Export-control CLAUSES from Stratellar (formerly the Strategic Materials Policy Tracker, Benjamin Yang), used under a commercial data licence
// (Stratellar LLC - Interzona.ai L.L.C., 26 Nov 2026; term 2026-11-27 to 2027-11-26). Licence rules enforced here and in the database:
// - the app role can only call stratellar.controls(...) (max 25 records per call) and stratellar.material_summary(...) (counts only);
// - every record carries the credit, dataset version, curated-release date and legal-status as-of date; downloads therefore carry them too;
// - coverage is SELECTIVE and HISTORICAL (legal status frozen at the as-of date): never present it as complete, current or legal advice;
// - keep events (instruments) and clauses apart, and statuses dated (scheduled, in force, suspended, expired, concluded ...).

type Out = { content: string; evidence?: Evidence[]; datasets?: Dataset[] };
type Q = Record<string, unknown>;
const lit = (v: string | null) => (v === null ? "NULL" : `'${v.slice(0, 80).replace(/'/g, "''")}'`);
const q = async (sql: string, max = 30) => (await runReadOnlyQuery(sql, max)).rows as unknown as Q[];
const d10 = (x: unknown) => (x instanceof Date ? x.toISOString().slice(0, 10) : x ? String(x).slice(0, 10) : null);

export const STRATELLAR_CREDIT = "Stratellar - stratellar.com (Strategic Materials Policy Tracker, Benjamin Yang)";
export const STRATELLAR_LIMITS =
  "Stratellar coverage is selective (a curated set of public instruments, not a complete inventory) and historical: statuses are as recorded at the legal-status " +
  "as-of date and are not a statement of current legal standing or export-control compliance advice. Coded categories and product codes do not replace the original instrument; " +
  "some product-scope, end-use and party wording is withheld, and a missing qualifier does not mean unrestricted scope - follow the linked official source.";

const STATUS_WORDS: Record<string, string> = {
  in_force: "in force", suspended: "suspended", concluded: "concluded", announced: "announced", scheduled: "scheduled", expired: "expired",
  unresolved_end_passed: "stated end date passed with no later entry (unresolved)", undated_or_not_started: "no dated status on or before the as-of date",
};
const MEASURE_WORDS: Record<string, string> = {
  export_licensing: "export licensing", end_use_restriction: "end-use restriction", customs_enforcement: "customs enforcement", domestic_production_control: "domestic production control",
  investment_divestiture: "investment divestiture order", extraterritorial_licensing: "extraterritorial licensing (foreign-made items)", trade_investigation: "trade investigation",
  suspension: "suspension of other measures", export_prohibition: "export prohibition", contractual_ownership_covenant: "contractual ownership covenant (funding condition)", decontrol: "decontrol (lifting a control)",
};
const ISSUER_WORDS: Record<string, string> = { china: "China", us: "United States", canada: "Canada" };
const nice = (m: Record<string, string>, k: unknown) => m[String(k)] ?? String(k ?? "").replace(/_/g, " ");

/** Clause-level export controls for a material and/or issuing country, max 25 records, each credited and dated. */
export async function exportControls(input: Record<string, unknown>): Promise<Out> {
  const material = String(input.commodity ?? input.material ?? "").trim() || null;
  const issuer = String(input.issuer ?? input.country ?? "").trim() || null;
  const measure = String(input.measure_type ?? "").trim() || null;
  const rows = await q(`SELECT * FROM stratellar.controls(${lit(material)}, ${lit(issuer)}, ${lit(measure)})`);
  if (!rows.length) {
    return {
      content: JSON.stringify({
        found: 0,
        message: `No Stratellar clause matches${material ? ` material "${material}"` : ""}${issuer ? ` issuer "${issuer}"` : ""}${measure ? ` measure "${measure}"` : ""}. Stratellar covers selected measures by China, the United States and Canada on rare earths, NdFeB magnets, graphite, lithium, gallium, germanium, antimony, tungsten, cobalt and nickel; absence here does not mean no control exists.`,
        limits: STRATELLAR_LIMITS,
      }),
    };
  }
  const r0 = rows[0];
  const total = Number(r0.total_matching);
  const version = String(r0.dataset_version);
  const curated = d10(r0.curated_release_date);
  const asof = d10(r0.legal_status_as_of);
  const creditLine = `${STRATELLAR_CREDIT}; dataset ${version}; curated release ${curated}; legal status as of ${asof}`;
  const records = rows.map((r) => {
    const hist = (r.status_history as { status: string; from: string | null; until: string | null }[] | null) ?? [];
    const srcs = (r.sources as { title: string; publisher: string; url: string; type: string }[] | null) ?? [];
    const lims = (r.scope_limitations as { field: string; disposition: string }[] | null) ?? [];
    return {
      clause_id: r.clause_id, issuer: nice(ISSUER_WORDS, r.issuer), instrument: r.document_label, instrument_date: d10(r.event_date), issuing_body: r.issuing_body,
      instrument_status_label: r.event_policy_status, clause: r.clause, measure: nice(MEASURE_WORDS, r.measure_type), direction: String(r.direction ?? "").replace(/_/g, " "),
      materials: r.materials, target_jurisdictions: r.target_jurisdictions, stages: r.controlled_stages, item_types: r.controlled_item_types, product_codes: r.product_code_count,
      status_as_of: { status: nice(STATUS_WORDS, r.status_asof), since: d10(r.status_since), until: d10(r.status_until), as_of: asof },
      status_history: hist.map((h) => `${nice(STATUS_WORDS, h.status)}${h.from ? ` from ${h.from}` : " (undated)"}${h.until ? ` until ${h.until}` : ""}`),
      withheld_or_ambiguous: lims.map((l) => `${l.field.replace(/_/g, " ")}: ${l.disposition === "source_wording_withheld" ? "source wording withheld" : "ambiguous evidence in baseline"}`),
      sources: srcs.slice(0, 3).map((s) => ({ title: s.title, publisher: s.publisher, url: s.url })),
      credit: creditLine,
    };
  });
  // A status whose stated end date falls between the legal-status as-of date and today: what happened after it is outside this release.
  const today = new Date().toISOString().slice(0, 10);
  const lapsing = records.filter((r) => r.status_as_of.until && asof && r.status_as_of.until >= asof && r.status_as_of.until <= today);
  const byStatus = new Map<string, number>();
  for (const r of records) byStatus.set(r.status_as_of.status, (byStatus.get(r.status_as_of.status) ?? 0) + 1);
  const instruments = new Set(records.map((r) => r.instrument));
  const statements = [
    `Stratellar records ${total} clause${total === 1 ? "" : "s"} matching this request${total > records.length ? `; the ${records.length} most recent are listed (the platform shows at most 25 Stratellar records at a time - narrow by country, material or measure type for the rest)` : ""}, from ${instruments.size} instrument${instruments.size === 1 ? "" : "s"}.`,
    `Status as of ${asof} (legal-status cut-off of this release): ${[...byStatus.entries()].map(([s, n]) => `${n} ${s}`).join(", ")}.`,
    ...(lapsing.length
      ? [`Recorded end dates reached since ${asof}: ${lapsing.map((r) => `${r.instrument}${r.clause ? ` (${r.clause})` : ""} - ${r.status_as_of.status} until ${r.status_as_of.until}`).join("; ")}. ` +
         `Whether these were extended, replaced or lapsed is after this release's cut-off and not covered here: say so plainly and point to the official source; do not guess.`]
      : []),
  ];
  const dataset: Dataset = {
    id: "controls-" + Date.now().toString(36),
    title: `Export-control clauses (Stratellar, status as of ${asof}; ${records.length} of ${total} shown) - selective historical record, not legal advice`,
    columns: ["Issuer", "Instrument", "Instrument date", "Clause", "Measure", "Materials", `Status as of ${asof}`, "Status since", "Status until", "Official source", "Credit"],
    rows: records.map((r) => [r.issuer, String(r.instrument ?? ""), r.instrument_date, String(r.clause ?? ""), r.measure, ((r.materials as string[]) ?? []).join(", "), r.status_as_of.status,
      r.status_as_of.since, r.status_as_of.until, r.sources[0]?.url ?? null, `Stratellar (stratellar.com), ${version.slice(0, 40)}..., curated ${curated}, status as of ${asof}`]),
  };
  return {
    content: JSON.stringify({
      found: total, shown: records.length, legal_status_as_of: asof, curated_release_date: curated, dataset_version: version,
      statements, records,
      limits: STRATELLAR_LIMITS,
      how_to_answer:
        "Answer from these records only. Keep the instrument (the announcement or law) apart from its clauses, and give each clause's status WITH its date and the as-of date " +
        `(for example 'suspended from 2026-11-11 until 2027-01-10, as recorded on ${asof}'). Say in one sentence that Stratellar's coverage is selective and historical, not a current legal assessment or compliance advice, ` +
        "and link the official source for anyone who needs the exact scope. Never list more than 25 Stratellar records in one answer, and do not page through the data with repeated calls to reproduce it. " +
        "Label your own reading (for example what a measure means for supply) as yours, not Stratellar's. End with a source line: " + creditLine + ".",
      credit: creditLine,
    }),
    evidence: [{ kind: "data", label: creditLine, detail: `${records.length} of ${total} clause records; selective historical coverage; not legal advice` }],
    datasets: [dataset],
  };
}

/** Counts of Stratellar clauses touching a material, by issuer, measure and status at the as-of date (no record content). */
export async function stratellarSummary(material: string): Promise<{ statement: string; credit: string; rows: Q[] } | null> {
  const rows = await q(`SELECT * FROM stratellar.material_summary(${lit(material)})`, 200).catch(() => [] as Q[]);
  if (!rows.length) return null;
  const asof = d10(rows[0].legal_status_as_of);
  const credit = `${STRATELLAR_CREDIT}; dataset ${String(rows[0].dataset_version)}; legal status as of ${asof}`;
  const byIssuer = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const iss = nice(ISSUER_WORDS, r.issuer);
    const m = byIssuer.get(iss) ?? new Map<string, number>();
    const st = nice(STATUS_WORDS, r.status_asof);
    m.set(st, (m.get(st) ?? 0) + Number(r.clauses));
    byIssuer.set(iss, m);
  }
  const parts = [...byIssuer.entries()].map(([iss, m]) => `${iss}: ${[...m.entries()].map(([s, n]) => `${n} clause${n === 1 ? "" : "s"} ${s}`).join(", ")}`);
  return {
    statement: `Measures recorded by Stratellar (selective, legal status as of ${asof}; these include measures after the OECD inventory ends in 2024 and are NOT counted in the scores above): ${parts.join("; ")}. Use the export-controls tool for the individual clauses and their dates.`,
    credit,
    rows,
  };
}
