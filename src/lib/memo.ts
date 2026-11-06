import crypto from "crypto";
import { runReadOnlyQuery } from "@/lib/db";
import { embedQuery, toVectorLiteral } from "@/lib/voyage";
import { findGeochemicalAnomalies } from "@/lib/anomalies";
import { depositFingerprint } from "@/lib/fingerprint";
import { companyAssets } from "@/lib/assets";
import { priceHistory } from "@/lib/finance-tools";
import { mapFromAnomalies } from "@/lib/map";
import { creditsForSource, creditsFromText } from "@/lib/licence";
import { redis } from "@/lib/redis";
import { MEMO_CASES, type MemoCase } from "@/lib/memo-cases";
import type { MapData } from "@/lib/types";

// Investor memo: a 2-page brief for one region and commodity, built ONLY from stored data and the document library (no generated prose): the leads from the anomaly screen,
// the deposit-type signature of the enriched rocks, the catalogued occurrences, who holds the projects, short quoted passages from the literature with their sources, price
// context where we have it, and a plain list of what is not known. A built memo is kept for a week; a share link keeps a frozen copy for 30 days.

export type Memo = {
  caseId: string;
  title: string;
  subtitle: string;
  commodity: string;
  generated: string;
  keyPoints: string[];
  leads: null | {
    indicator: string;
    basisNote: string;
    samplesWithData: number;
    rows: { area: string; anomalous: number; analysed: number; highest: number | null; types: string; nearest: string | null; km: number | null; group: string }[];
    map: MapData | null;
    note?: string;
  };
  fingerprint: null | {
    survey: string;
    filter: string;
    nLead: number;
    nBackground: number;
    elements: string[];
    accuracy: { first: number; topThree: number; types: number; chance: number };
    ranked: { type: string; deposits: number; lead: number; background: number; difference: number; small: boolean }[];
    drivers: { element: string; fold: number; towards: boolean }[];
    farFromAll: boolean;
  };
  fingerprintNote: string | null;
  occurrences: null | { label: string; total: number; byStatus: { status: string; n: number }[]; named: { name: string; status: string; country: string | null }[] };
  holders: null | { rows: { asset: string; company: string; interest: number | null; status: string | null; type: string | null; owners: string }[]; unplaced: number; map: MapData | null; notFound: string[] };
  literature: { query: string; items: { title: string; page: number | null; excerpt: string }[] }[];
  /** Project status, permitting and finance: quoted passages by topic, from documents of different dates. */
  context: { topic: string; items: { title: string; page: number | null; excerpt: string }[] }[];
  prices: null | { title: string; columns: string[]; rows: (string | number | null)[][] };
  unknowns: string[];
  sources: { data: string[]; documents: { title: string; pages: number[] }[] };
  disclaimer: string;
};

const DAY = 86400;
const coord = (lat: number, lon: number) => `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? "N" : "S"}, ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? "E" : "W"}`;
const n0 = (v: unknown) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));

// ---- literature ---------------------------------------------------------------------------------------------------------------------------------
function excerpt(content: string, query: string, chars = 420, anchors?: RegExp[]): string {
  const text = content.replace(/^\[[^\]]*\]\s*/, "").replace(/\s+/g, " ").trim();
  const terms = Array.from(new Set(query.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []));
  let best = 0;
  let bestScore = -1;
  for (let start = 0; start + chars <= text.length + 200; start += 120) {
    const win = text.slice(start, start + chars).toLowerCase();
    const score = terms.filter((t) => win.includes(t)).length;
    if (score > bestScore) {
      bestScore = score;
      best = start;
    }
  }
  // when the passage must mention a topic, centre the quotation on where it does
  for (const a of anchors ?? []) {
    const at = text.search(a);
    if (at >= 0) {
      best = Math.max(0, at - 140);
      break;
    }
  }
  // begin at a sentence start and end at a sentence end, so a quotation does not stop in the middle of a statement
  let start = best;
  if (start > 0) {
    const back = text.slice(Math.max(0, start - 160), start);
    const m = [...back.matchAll(/[.!?]["”)]?\s+/g)].pop();
    if (m && m.index !== undefined) start = Math.max(0, start - 160) + m.index + m[0].length;
  }
  let end = Math.min(best + chars, text.length);
  if (end < text.length) {
    const fwd = /[.!?]["”)]?\s/.exec(text.slice(end, Math.min(text.length, end + 260)));
    if (fwd) end = end + fwd.index + 1;
  }
  return (start > 0 ? "… " : "") + text.slice(start, end).trim() + (end < text.length ? " …" : "");
}

async function searchLiterature(query: string, seen: Set<string>, must: RegExp, needs?: string[]) {
  const vec = toVectorLiteral(await embedQuery(query));
  const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const { rows } = await runReadOnlyQuery(
    `SELECT document_id, page_number, (SELECT title FROM docs.documents d WHERE d.document_id = c.document_id) AS title, content
     FROM docs.hybrid_search(${lit(query)}, '${vec}'::vector, NULL, NULL, NULL, NULL, NULL, NULL,
       ARRAY['DISCLAIMER','TABLE_OF_CONTENTS','GLOSSARY','LEGAL','HEADER_FOOTER','REFERENCES']::varchar[], 150, 14, 1) c`,
    14
  );
  const items: { title: string; page: number | null; excerpt: string }[] = [];
  const anchors = needs?.map((n) => new RegExp(n, "i"));
  const need = needs ? new RegExp(needs.join("|"), "i") : undefined;
  for (const r of rows) {
    const title = String(r.title ?? "");
    if (!title || seen.has(title) || items.length >= 2) continue;
    // project status goes out of date quickly: for the status section skip documents whose title carries only years before 2024
    if (needs) {
      const years = (title.match(/\b(20\d\d)\b/g) ?? []).map(Number);
      if (years.length && Math.max(...years) < 2024) continue;
    }
    const content = String(r.content ?? "");
    if (!must.test(content)) continue;
    // the passage shown is the window of the chunk around the region terms and the query terms, and must itself be about the region
    const shown = excerpt(content, `${query} ${must.source.replace(/[^a-z| ]/gi, " ")}`, needs ? 560 : 420, anchors);
    if (!must.test(shown)) continue;
    if (need && !need.test(shown)) continue;
    // scanned-PDF debris (download banners, run-together words and numbers) makes a poor quotation
    const letters = (shown.match(/[A-Za-z\s,.;:'"()\-]/g) ?? []).length / Math.max(1, shown.length);
    if (/downloadedfrom|pubs\.geoscienceworld|={4,}|\.html?\b/i.test(shown) || letters < 0.82) continue;
    // running prose has many small function words; map labels and table debris do not
    const words = shown.toLowerCase().match(/[a-z']+/g) ?? [];
    const small = words.filter((w) => ["the", "of", "and", "is", "are", "in", "to", "a", "for", "with", "by", "at", "on", "that", "has", "was", "its", "from"].includes(w)).length;
    if (words.length < 20 || small / words.length < 0.14) continue;
    seen.add(title);
    items.push({ title, page: n0(r.page_number), excerpt: shown });
  }
  return items;
}

// ---- build --------------------------------------------------------------------------------------------------------------------------------------
export async function buildMemo(caseId: string): Promise<Memo> {
  const c: MemoCase | undefined = MEMO_CASES[caseId];
  if (!c) throw new Error(`Unknown memo "${caseId}". Available: ${Object.keys(MEMO_CASES).join(", ")}.`);
  const unknowns: string[] = [];
  const dataCredits = new Set<string>();
  const usedSources = new Set<string>([c.leads.source_system]);

  // 1. leads
  const leadsP = (async (): Promise<Memo["leads"]> => {
    const r = (await findGeochemicalAnomalies({ ...c.leads, limit: 30 })) as {
      indicator: string; cells: Record<string, unknown>[]; coverage_by_sample_type: { n_with_required_elements: number }[]; grid_deg: number;
    };
    const newCells = r.cells.filter((x) => x.group === "NEW_LEAD").slice(0, 8);
    const cells = newCells.length ? newCells : r.cells.slice(0, 8);
    const samples = (r.coverage_by_sample_type ?? []).reduce((s, x) => s + (n0(x.n_with_required_elements) ?? 0), 0);
    creditsForSource(c.leads.source_system).forEach((x) => dataCredits.add(x));
    return {
      indicator: r.indicator,
      basisNote: `Each survey flags the top 5% of every sample type; a cell is listed when at least 3 flagged samples fall in it. ${newCells.length ? "Only cells with no catalogued occurrence of any kind within 15 km are shown." : "No cell was free of catalogued occurrences, so the strongest cells are shown."}`,
      samplesWithData: samples,
      ...(c.sedimentSurvey ? { note: "This survey is of stream sediments and soils: an anomaly points to a drainage catchment, not to a spot, and values for some elements are partial-leach analyses." } : {}),
      rows: cells.map((x) => ({
        area: coord(Number(x.anom_lat), Number(x.anom_lon)),
        anomalous: Number(x.n_anomalous),
        analysed: Number(x.n_analysed),
        highest: n0(x.max_value_ppm),
        types: String(x.anomalous_sample_types ?? ""),
        nearest: x.nearest_any_occurrence ? String(x.nearest_any_occurrence) : null,
        km: n0(x.km_to_any_occurrence),
        group: String(x.group),
      })),
      map: mapFromAnomalies({ indicator: r.indicator, grid_deg: r.grid_deg, cells }),
    };
  })();

  // 2. fingerprint
  const fpP = (async () => {
    if (!c.fingerprint) return { fp: null as Memo["fingerprint"], note: "A deposit-type signature compares rock samples with known deposits. The survey behind this memo is sediments or soils, so it is not applicable here." };
    const { area, ...fpArgs } = c.fingerprint;
    const out = await depositFingerprint({ ...fpArgs });
    if (!out.content.startsWith("{")) return { fp: null as Memo["fingerprint"], note: out.content };
    const j = JSON.parse(out.content) as {
      survey: string; lead: { samples_used: number; filter: string }; background: { samples_used: number }; elements_used: string[];
      ranked_types: { type: string; reference_deposits: number; lead_share_pct: number; background_share_pct: number; difference_points: number; small_reference: boolean }[];
      elements_behind_best_type: { items: { element: string; lead_vs_background_fold: number; points_towards_type: boolean }[] };
      does_not_resemble_any_type_well: boolean;
      reference_accuracy: { known_deposits: number; types: number; correct_first_guess_pct: number; correct_in_top_three_pct: number; chance_first_guess_pct: number };
    };
    creditsForSource(c.fingerprint.source_system).forEach((x) => dataCredits.add(x));
    dataCredits.add("Geoscience Australia / Critical Minerals Mapping Initiative with the Geological Survey of Canada and the USGS, Critical Minerals in Ores - geochemistry database (CC BY 4.0)");
    return {
      fp: {
        survey: j.survey,
        filter: area ? `${j.lead.filter}, ${area}` : j.lead.filter,
        nLead: j.lead.samples_used,
        nBackground: j.background.samples_used,
        elements: j.elements_used,
        accuracy: { first: j.reference_accuracy.correct_first_guess_pct, topThree: j.reference_accuracy.correct_in_top_three_pct, types: j.reference_accuracy.types, chance: j.reference_accuracy.chance_first_guess_pct },
        ranked: j.ranked_types.slice(0, 5).map((t) => ({ type: t.type, deposits: t.reference_deposits, lead: t.lead_share_pct, background: t.background_share_pct, difference: t.difference_points, small: t.small_reference })),
        drivers: j.elements_behind_best_type.items.filter((d) => d.lead_vs_background_fold > 1.25 || d.lead_vs_background_fold < 0.8).slice(0, 5).map((d) => ({ element: d.element, fold: d.lead_vs_background_fold, towards: d.points_towards_type })),
        farFromAll: j.does_not_resemble_any_type_well,
      },
      note: null as string | null,
    };
  })();

  // 3. catalogued occurrences
  const occP = (async (): Promise<Memo["occurrences"]> => {
    const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
    const jur = c.occurrences.jurisdiction ? ` AND o.jurisdiction_id IN (SELECT jurisdiction_id FROM core.jurisdictions WHERE name = ${lit(c.occurrences.jurisdiction)})` : "";
    const where = `o.is_active AND o.country_name = ${lit(c.occurrences.country)}${jur} AND EXISTS (SELECT 1 FROM unnest(o.commodities) k WHERE k ~* ${lit(c.occurrences.pattern)})`;
    const by = await runReadOnlyQuery(`SELECT coalesce(o.status, 'UNKNOWN') AS status, count(*) AS n FROM core.occurrences o WHERE ${where} GROUP BY 1 ORDER BY 2 DESC`, 20);
    const named = await runReadOnlyQuery(
      `SELECT o.name, coalesce(o.status, 'UNKNOWN') AS status, o.country_name FROM core.occurrences o WHERE ${where} AND o.name !~* '^(mrds|unnamed)'
       ORDER BY CASE o.status WHEN 'PRODUCER' THEN 0 WHEN 'DEVELOPMENT' THEN 1 WHEN 'FEASIBILITY' THEN 2 WHEN 'EXPLORATION' THEN 3 WHEN 'PAST_PRODUCER' THEN 4 ELSE 5 END, o.name LIMIT 10`,
      10
    );
    const total = by.rows.reduce((s, r) => s + Number(r.n), 0);
    creditsFromText(c.occurrences.jurisdiction ?? c.occurrences.country).forEach((x) => dataCredits.add(x));
    dataCredits.add("Mineral occurrence catalogue (USGS and national surveys)");
    return { label: c.occurrences.label, total, byStatus: by.rows.map((r) => ({ status: String(r.status), n: Number(r.n) })), named: named.rows.map((r) => ({ name: String(r.name), status: String(r.status), country: r.country_name ? String(r.country_name) : null })) };
  })();

  // 4. who holds the projects
  const holdP = (async (): Promise<Memo["holders"]> => {
    const out = await companyAssets({ companies: c.companies, ...(c.companyCommodity ? { commodity: c.companyCommodity } : {}) });
    const j = JSON.parse(out.content) as { found?: boolean; assets?: Record<string, unknown>[]; assets_without_position?: string[]; not_found?: string[] };
    if (j.assets && c.companyRegion) { const re = new RegExp(c.companyRegion, "i"); j.assets = j.assets.filter((a) => re.test(String(a.country ?? ""))); }
    if (j.found === false || !j.assets?.length) return null;
    dataCredits.add("Company asset and ownership records (annual reports)");
    return {
      rows: j.assets.slice(0, 14).map((a) => ({
        asset: String(a.asset), company: String(a.company), interest: n0(a.interest_pct), status: a.status ? String(a.status) : null, type: a.type ? String(a.type) : null,
        owners: ((a.all_recorded_owners as { owner: string; share_pct: number | null }[]) ?? []).slice(0, 4).map((o) => `${o.owner}${o.share_pct !== null ? ` ${o.share_pct}%` : ""}`).join("; "),
      })),
      unplaced: (j.assets_without_position ?? []).length,
      map: out.maps?.[0] ?? null,
      notFound: j.not_found ?? [],
    };
  })();

  // 5. literature
  const litP = (async () => {
    const seen = new Set<string>();
    const out: Memo["literature"] = [];
    const must = new RegExp(c.literatureMust, "i");
    for (const q of c.literature) out.push({ query: q, items: await searchLiterature(q, seen, must) });
    return out;
  })();

  // 5b. project status, permitting and finance: the same library search, one topic at a time, with a longer quotation
  const ctxP = (async () => {
    const seen = new Set<string>();
    const must = new RegExp(c.literatureMust, "i");
    const out: Memo["context"] = [];
    for (const t of c.context ?? []) out.push({ topic: t.topic, items: await searchLiterature(t.query, seen, must, t.require) });
    return out;
  })();

  // 6. prices
  const priceP = (async (): Promise<Memo["prices"]> => {
    if (!c.priceCommodity) return null;
    const out = await priceHistory({ commodity: c.priceCommodity });
    const ds = out.datasets?.[0];
    if (!ds) return null;
    dataCredits.add("Commodity prices (World Bank, IMF and USGS)");
    return { title: ds.title, columns: ds.columns, rows: ds.rows.slice(-12) };
  })();

  const [leadsR, fpR, occR, holdR, litR, priceR, ctxR] = await Promise.allSettled([leadsP, fpP, occP, holdP, litP, priceP, ctxP]);
  const val = <T,>(r: PromiseSettledResult<T>, what: string): T | null => {
    if (r.status === "fulfilled") return r.value;
    unknowns.push(`The ${what} section could not be built when this memo was made (${String(r.reason?.message ?? r.reason).slice(0, 100)}).`);
    return null;
  };
  const leads = val(leadsR, "geochemical leads");
  const fpv = val(fpR, "deposit-type signature");
  const occ = val(occR, "catalogued occurrences");
  const holders = val(holdR, "project holders");
  const literature = val(litR, "literature") ?? [];
  const context = val(ctxR, "project status, permitting and finance") ?? [];
  const prices = val(priceR, "price context");

  // key points: plain restatements of the numbers above
  const keyPoints: string[] = [];
  if (leads) {
    keyPoints.push(
      leads.rows.length
        ? `${leads.rows.length} areas with anomalous ${c.commodity} chemistry${leads.rows.some((r) => r.group === "NEW_LEAD") ? " and no catalogued occurrence close by" : " (every one has a catalogued occurrence within 15 km, so none is a new lead)"}, found by screening ${leads.samplesWithData.toLocaleString("en-US")} samples; the strongest is near ${leads.rows[0].area} (${leads.rows[0].anomalous} of ${leads.rows[0].analysed} samples anomalous).`
        : `No new-lead areas were found for ${c.commodity} in this survey with the screen's settings.`
    );
  }
  if (fpv?.fp) {
    const best = fpv.fp.ranked[0];
    keyPoints.push(
      fpv.fp.farFromAll
        ? `The enriched rocks do not resemble any known deposit type well.`
        : `The enriched rocks (${fpv.fp.filter}) most resemble "${best.type}" deposits: ${best.lead}% of the samples against ${best.background}% of the regional background. On known deposits this method gets the right type first about ${Math.round(fpv.fp.accuracy.first)}% of the time and within three about ${Math.round(fpv.fp.accuracy.topThree)}%.`
    );
  }
  if (occ) {
    const live = occ.byStatus.filter((s) => ["PRODUCER", "DEVELOPMENT", "FEASIBILITY"].includes(s.status)).reduce((s, x) => s + x.n, 0);
    keyPoints.push(`${occ.total.toLocaleString("en-US")} catalogued ${occ.label}; ${live === 1 ? "1 is" : `${live} are`} producing or at development or feasibility stage.`);
  }
  if (holders) {
    const cos = [...new Set(holders.rows.map((r) => r.company))];
    keyPoints.push(`Project holders on record: ${cos.join(", ")} (${holders.rows.length} assets${holders.unplaced ? `, ${holders.unplaced} without a map position` : ""}).`);
  }
  if (prices) keyPoints.push(`Price context is limited to the series shown (annual averages), which is too short for a statistical link to company results.`);

  // what is not known
  if (leads) unknowns.push(`The leads are single-sample assays in regional surveys, not grades or resources; ${leads.samplesWithData.toLocaleString("en-US")} samples had the elements, and where surveys sampled shapes the counts.`);
  unknowns.push("Catalogued occurrence positions are only as good as the catalogue (some are accurate to tens of kilometres), so 'no occurrence nearby' means nothing is catalogued, not that nothing is there.");
  if (fpv?.fp) {
    unknowns.push(`The signature is a screening hint, not a classification: it used ${fpv.fp.elements.length} elements, and types that depend on elements not measured here (for example copper, molybdenum, gold, silver, lead) cannot be separated.`);
    if (fpv.fp.ranked.some((r) => r.small)) unknowns.push("At least one deposit type in the comparison has a small reference group (fewer than 15 usable deposits), so its match is less certain.");
  } else if (fpv?.note) unknowns.push(fpv.note);
  if (holders) unknowns.push("Ownership is loaded for only some companies, only the assets matched to the catalogue can be placed on a map, and the data hold no output or size figures, so no asset is called the biggest.");
  else unknowns.push("No project ownership is loaded for the companies named for this region.");
  if ([...literature.flatMap((l) => l.items), ...context.flatMap((t) => t.items)].some((i) => /internal summary|reference list/i.test(i.title))) unknowns.push("Passages marked 'Internal summary' are compiled notes, not primary sources.");
  if (!prices && !c.priceCommodity) unknowns.push(`Our data hold no market price series for ${c.commodity} that is long enough to be useful, so price exposure is not assessed here.`);
  if (prices) unknowns.push("The price series are annual averages for a few years, too short to test how company results move with price.");
  if (context.some((t) => t.items.length > 0)) unknowns.push("The project status, permitting and finance passages are quotations from documents of different dates (see each title); project status can change quickly, so check them against current company and government announcements before relying on them.");
  unknowns.push("This memo does not estimate resources or reserves, value any project, or give its own view on permitting or financing; where it quotes such figures they are the sources' own. It is a data brief, not advice.");

  // sources
  const docs = new Map<string, Set<number>>();
  for (const i of [...literature.flatMap((l) => l.items), ...context.flatMap((t) => t.items)]) docs.set(i.title, new Set([...(docs.get(i.title) ?? []), ...(i.page ? [i.page] : [])]));
  const attribution = await runReadOnlyQuery(
    `SELECT attribution_text FROM core.data_sources WHERE source_system = ANY(ARRAY[${[...usedSources, ...(c.fingerprint ? [c.fingerprint.source_system, "GLOBAL_DEPOSIT_GEOCHEM_GA"] : [])].map((s) => `'${s}'`).join(",")}]) AND attribution_text IS NOT NULL`,
    20
  ).catch(() => ({ rows: [] as Record<string, unknown>[] }));

  return {
    caseId: c.id,
    title: c.title,
    subtitle: c.subtitle,
    commodity: c.commodity,
    generated: new Date().toISOString().slice(0, 10),
    keyPoints,
    leads,
    fingerprint: fpv?.fp ?? null,
    fingerprintNote: fpv?.fp ? null : (fpv?.note ?? null),
    occurrences: occ,
    holders,
    literature,
    context,
    prices,
    unknowns,
    sources: { data: [...new Set([...attribution.rows.map((r) => String(r.attribution_text)), ...dataCredits])], documents: [...docs.entries()].map(([title, pages]) => ({ title, pages: [...pages].sort((a, b) => a - b) })) },
    disclaimer: "Prepared by an AI assistant from Interzona's stored datasets and document library. Check important figures against the sources listed. Not investment advice.",
  };
}

// ---- storage ------------------------------------------------------------------------------------------------------------------------------------
export async function getMemo(caseId: string, refresh = false): Promise<Memo> {
  const key = `memo:case:${caseId}`;
  if (!refresh) {
    const hit = (await redis([["GET", key]]).catch(() => [null]))[0];
    if (typeof hit === "string") {
      try {
        return JSON.parse(hit) as Memo;
      } catch {
        /* rebuild */
      }
    }
  }
  const memo = await buildMemo(caseId);
  await redis([["SET", key, JSON.stringify(memo), "EX", 7 * DAY]]).catch(() => undefined);
  return memo;
}

export async function createMemoShare(caseId: string): Promise<{ token: string; expires: string }> {
  const memo = await getMemo(caseId);
  const token = "mt_" + crypto.randomBytes(18).toString("base64url");
  await redis([["SET", `memo:share:${token}`, JSON.stringify(memo), "EX", 30 * DAY]]);
  return { token, expires: new Date(Date.now() + 30 * DAY * 1000).toISOString().slice(0, 10) };
}

export async function getSharedMemo(token: string): Promise<Memo | null> {
  if (!/^mt_[A-Za-z0-9_-]{20,40}$/.test(token)) return null;
  const hit = (await redis([["GET", `memo:share:${token}`]]).catch(() => [null]))[0];
  if (typeof hit !== "string") return null;
  try {
    return JSON.parse(hit) as Memo;
  } catch {
    return null;
  }
}
