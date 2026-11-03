import { getPool } from "@/lib/db";
import { peerGroupMembers, type Evidence, type ToolOutput } from "@/lib/finance-tools";
import type { MapData, MapPoint } from "@/lib/types";

// A company's mines, plants and projects with the company's interest in each, and a map of those that have a position. A position comes
// from the project's own site-level geom, else the linked catalogue occurrence, else the project's town- or city-level geom
// (core.projects.location_precision says how exact it is and location_source where it came from); the rest are listed without one and counted.

const COMMODITY_NAME: Record<string, string> = {
  Cu: "Copper", U: "Uranium", Li: "Lithium", REE: "Rare earths", Au: "Gold", Zn: "Zinc", Ni: "Nickel", Fe: "Iron ore", Al: "Aluminium", Pb: "Lead",
  PGE: "Platinum group metals", Co: "Cobalt", Mn: "Manganese", Ag: "Silver", "Heavy Mineral Sand": "Heavy mineral sands", Coal: "Coal", Bauxite: "Bauxite",
};
const STATUS_WORD: Record<string, string> = { PRODUCER: "Producing", PAST_PRODUCER: "Past producing", CARE_AND_MAINTENANCE: "Care and maintenance", DEVELOPMENT: "Development", EXPLORATION: "Exploration" };
const ASSET_WORD: Record<string, string> = { MINE: "Mine", MILL: "Mill", PROCESSING: "Processing plant", REFINERY: "Refinery", PROJECT: "Project", MAGNET: "Magnet plant", RECYCLING: "Recycling plant", SUBSTITUTION: "Substitution project" };
const word = (m: Record<string, string>, v: unknown) => (v === null || v === undefined || v === "" ? null : m[String(v)] ?? String(v));
const ACC_WORD: Record<string, string> = { TOWN_CENTROID: "position is the nearest town", AREA_CENTROID: "position is the centre of an area", COUNTY_CENTROID: "position is the centre of a county", REGIONAL: "position is approximate (regional scale)" };
// Where an asset record (and its stake) came from: the Austrade Prospectus, the EU CRMA strategic-project list, NRCan's Canadian project lists, or the company's own reports.
const RECORD_CREDITS = {
  prospectus: "Austrade, Australian Critical Minerals Prospectus (October 2026), CC BY 4.0; company-supplied, not verified by Austrade",
  crma: "European Commission, Critical Raw Materials Act strategic projects (selection decisions and factsheets)",
  company: "Company reports (annual reports, filings and presentations)",
  nrcan: "Natural Resources Canada, critical minerals projects list and Major Projects Inventory (Open Government Licence - Canada)",
} as const;
const recordKind = (r: Record<string, unknown>): keyof typeof RECORD_CREDITS => (r.source_type === "Prospectus" ? "prospectus" : r.is_crma ? "crma" : r.is_nrcan ? "nrcan" : "company");
const PRECISION_WORD: Record<string, string> = { SITE: "site position", TOWN: "approximate: the town or suburb named for the site, not the plant itself", CITY: "approximate: only the city is published" };
// Publisher credits for project positions, keyed on the start of core.projects.location_source.
const POSITION_CREDITS: [string, string][] = [
  ["Geoscience Australia, Australian Critical Minerals Map", "Geoscience Australia, Australian Critical Minerals Map 2025 (CC BY 4.0)"],
  ["Geoscience Australia, Composite Gazetteer", "Geoscience Australia, Composite Gazetteer of Australia (CC BY 4.0)"],
  ["Australian Bureau of Statistics", "Australian Bureau of Statistics, ASGS 2021 Suburbs and Localities (CC BY 4.0)"],
  ["NRCan", "Natural Resources Canada (Open Government Licence - Canada)"],
];

export async function companyAssets(input: Record<string, unknown>): Promise<ToolOutput> {
  let names = Array.isArray(input.companies) ? (input.companies as unknown[]).map(String) : typeof input.company === "string" ? [input.company] : [];
  if (names.length === 0 && typeof input.peer_group === "string" && input.peer_group.trim()) {
    const g = await peerGroupMembers(input.peer_group);
    if (!g.matched) return { content: JSON.stringify({ found: false, note: "No peer group with that name.", available_peer_groups: g.available }) };
    names = g.names;
  }
  if (names.length === 0) throw new Error("Name at least one company or a peer group.");
  const commodity = typeof input.commodity === "string" ? input.commodity.trim() : "";
  // A company needs asset records, not financial statements (Greenland Mines, Amaroq, ETM and 80 Mile have projects but no statements).
  const ids: number[] = [];
  const unresolved: string[] = [];
  for (const raw of names.slice(0, 6)) {
    const n = raw.trim();
    if (!n) continue;
    const r = await getPool().query(
      `SELECT c.company_id FROM core.companies c
       WHERE EXISTS (SELECT 1 FROM core.projects p WHERE p.company_id = c.company_id AND p.is_active)
         AND (upper(c.ticker) = upper($1) OR c.short_name ILIKE $2 OR c.name ILIKE $2)
       ORDER BY (upper(c.ticker) = upper($1)) DESC, (lower(c.short_name) = lower($1)) DESC, c.company_id LIMIT 1`,
      [n, `%${n}%`]
    );
    if (r.rows[0]) ids.push(r.rows[0].company_id as number);
    else unresolved.push(n);
  }
  if (ids.length === 0) return { content: JSON.stringify({ found: false, not_found: unresolved, note: "No asset records are loaded for that company (ownership and assets have been loaded for only some companies)." }) };

  const rows = (
    await getPool().query(
      `SELECT COALESCE(c.short_name, c.name) AS company, p.project_id, p.name, p.asset_type, p.status, cm.commodity_name AS commodity, j.name AS country,
              po.share_pct::float8 AS share, po.as_of_year, o.name AS occ_name, o.lat, o.lon, o.position_accuracy,
              ST_Y(p.geom) AS p_lat, ST_X(p.geom) AS p_lon, p.location_precision, p.location_source,
              d.title AS source_title, d.document_type AS source_type, p.source_page, (p.created_by LIKE 'migration_eu_crma%') AS is_crma, (p.created_by LIKE 'migration_nrcan%') AS is_nrcan
       FROM core.projects p
       LEFT JOIN docs.documents d ON d.document_id = p.source_document_id
       JOIN core.companies c ON c.company_id = p.company_id
       LEFT JOIN core.commodities cm ON cm.commodity_id = p.primary_commodity_id
       LEFT JOIN core.jurisdictions j ON j.jurisdiction_id = p.jurisdiction_id
       LEFT JOIN core.project_ownership po ON po.project_id = p.project_id AND po.company_id = p.company_id AND po.is_active
       LEFT JOIN core.occurrences o ON o.occurrence_id = p.occurrence_id AND o.is_active AND o.position_accuracy IS DISTINCT FROM 'UNRELIABLE'
       WHERE p.is_active AND p.company_id = ANY($1) ${commodity ? "AND (cm.commodity_name ILIKE $2 OR p.name ILIKE $2 OR p.description ILIKE $2)" : ""}
       ORDER BY company, po.share_pct DESC NULLS LAST, p.name`,
      commodity ? [ids, `%${commodity.replace(/[%_]/g, "")}%`] : [ids]
    )
  ).rows;
  if (rows.length === 0) return { content: JSON.stringify({ found: false, not_found: unresolved, note: "No asset records are loaded for that company (ownership has been loaded for only some companies)." }) };

  // Every recorded owner of these projects (the company's own stake and its partners), so ownership questions see the whole picture.
  const owners = new Map<number, { owner: string; share_pct: number | null }[]>();
  const ownerRows = (
    await getPool().query(
      `SELECT project_id, owner_name, share_pct::float8 AS share FROM core.project_ownership WHERE project_id = ANY($1) AND is_active ORDER BY share_pct DESC NULLS LAST, owner_name`,
      [rows.map((r) => r.project_id)]
    )
  ).rows;
  for (const o of ownerRows) owners.set(o.project_id, [...(owners.get(o.project_id) ?? []), { owner: String(o.owner_name), share_pct: o.share }]);

  const points: MapPoint[] = [];
  const unplaced: string[] = [];
  const credits = new Set<string>();
  const recordKinds = new Set<keyof typeof RECORD_CREDITS>();
  let fromCatalogue = 0, fromProject = 0, approximate = 0;
  const assets = rows.map((r) => {
    // A project's own site-level position (e.g. Geoscience Australia's current mine point) wins over a linked catalogue entry, which
    // can be kilometres off; a town- or city-level one is used only when there is no catalogue entry.
    const hasOwn = typeof r.p_lat === "number" && typeof r.p_lon === "number";
    const onCatalogue = !(hasOwn && r.location_precision === "SITE") && typeof r.lat === "number" && typeof r.lon === "number";
    const onProject = !onCatalogue && hasOwn;
    const placed = onCatalogue || onProject;
    const status = word(STATUS_WORD, r.status);
    const kind = word(ASSET_WORD, r.asset_type);
    const com = word(COMMODITY_NAME, r.commodity);
    if (placed) {
      const src = String(r.location_source ?? "");
      if (onCatalogue) fromCatalogue++;
      else {
        fromProject++;
        if (r.location_precision === "TOWN" || r.location_precision === "CITY") approximate++;
      }
      const credit = onProject ? POSITION_CREDITS.find(([prefix]) => src.startsWith(prefix))?.[1] : undefined;
      if (credit) credits.add(credit);
      const position = onCatalogue
        ? `Position from catalogue entry "${r.occ_name}"${r.position_accuracy ? `; ${ACC_WORD[String(r.position_accuracy)] ?? "approximate position"}` : ""}`
        : `Position: ${PRECISION_WORD[String(r.location_precision)] ?? "approximate position"}${credit ? ` (${credit})` : ""}`;
      const lines = [
        [kind, status].filter(Boolean).join(", "),
        r.share !== null ? `${r.company} interest: ${r.share}%${r.as_of_year ? ` (${r.as_of_year})` : ""}` : "",
        (owners.get(r.project_id) ?? []).filter((x) => x.owner.toLowerCase() !== String(r.company).toLowerCase() && !String(r.company).toLowerCase().includes(x.owner.toLowerCase())).length
          ? `Other owners: ${(owners.get(r.project_id) ?? []).filter((x) => !x.owner.toLowerCase().includes(String(r.company).toLowerCase())).slice(0, 4).map((x) => `${x.owner}${x.share_pct !== null ? ` ${x.share_pct}%` : ""}`).join(", ")}`
          : "",
        r.country ? String(r.country) : "",
        position,
      ].filter(Boolean);
      points.push({ lat: onCatalogue ? r.lat : r.p_lat, lon: onCatalogue ? r.lon : r.p_lon, label: r.name, group: names.length > 1 || ids.length > 1 ? String(r.company) : com ?? "Asset", detail: lines.join("\n") });
    } else unplaced.push(`${r.name}${r.company && ids.length > 1 ? ` (${r.company})` : ""}`);
    recordKinds.add(recordKind(r));
    return {
      company: r.company, asset: r.name, type: kind, status, commodity: com, country: r.country, interest_pct: r.share, interest_as_of: r.as_of_year,
      record_source: r.source_title ? `${r.source_title}${r.source_page ? `, p. ${r.source_page}` : ""}` : RECORD_CREDITS[recordKind(r)],
      all_recorded_owners: owners.get(r.project_id) ?? [], has_position: placed,
      position_precision: onCatalogue ? "catalogue entry" : onProject ? String(r.location_precision ?? "").toLowerCase() || null : null,
      // The place the point stands for (mine, deposit or town), so the answer can name it: from the catalogue entry, or the feature named in location_source.
      position_place: onCatalogue ? r.occ_name : onProject ? ([...String(r.location_source ?? "").matchAll(/:\s([^:(;]+?)\s\(/g)].pop()?.[1] ?? null) : null,
    };
  });

  const map: MapData | null =
    points.length >= 2
      ? {
          id: "map-" + Date.now() + "-" + Math.floor(Math.random() * 1e4),
          title: `${ids.length > 1 ? "Company" : String(rows[0].company)} assets with a known position`,
          note: (
            (fromCatalogue ? `${fromCatalogue} position${fromCatalogue === 1 ? "" : "s"} come from the matching catalogue entry and may differ from the actual site by kilometres to tens of kilometres. ` : "") +
            (fromProject ? `${fromProject} come${fromProject === 1 ? "s" : ""} from published mine, deposit and place-name data${approximate ? `; ${approximate === 1 ? "1 of these marks" : `${approximate} of these mark`} only the town or city named for the site, not the plant itself` : ""}. ` : "") +
            (unplaced.length ? `${unplaced.length} of ${rows.length} assets are not shown because no position could be matched with confidence.` : "")
          ).trim(),
          points,
        }
      : null;
  const evidence: Evidence[] = [
    ...(["company", "prospectus", "crma", "nrcan"] as const).filter((k) => recordKinds.has(k)).map((k) => ({ kind: "data", label: RECORD_CREDITS[k], detail: "asset and ownership records" }) as Evidence),
    ...(fromCatalogue ? [{ kind: "data", label: "Mineral occurrence catalogue (positions)", detail: `${fromCatalogue} positions` } as Evidence] : []),
    ...[...credits].map((label) => ({ kind: "data", label, detail: "asset positions" }) as Evidence),
  ];
  return {
    content: JSON.stringify({
      assets,
      positions_available: points.length,
      assets_without_position: unplaced,
      not_found: unresolved,
      caveats: [
        "Each asset's record_source names the document it comes from (a company report, the Austrade Prospectus or the EU CRMA strategic-project list); cite that, not \"the annual report\", when saying what is or is not stated. Interests are the company's share as recorded there for the year shown; a blank interest means the share is not stated in the data.",
        "Describe only the assets listed here; do not add other sites or owners from general knowledge. If the user may expect an asset that is missing, say it is not in the records instead of naming it.",
        "Only assets with a catalogue entry or a recorded position can be placed on a map; many processing plants, smelters and in-situ uranium operations have neither. Say how many assets could not be placed.",
        ...(approximate ? [`${approximate} mapped asset(s) are placed only at the town or city named for the site (position_precision "town" or "city"); say so if their exact location matters.`] : []),
        "The data list assets and stakes but not output or size, so do not call an asset the biggest or most important without another source.",
        map ? "A map of the placed assets is shown to the user automatically; do not describe how to draw it or list coordinates." : "No map is shown (fewer than two assets have a position).",
      ],
    }),
    evidence,
    maps: map ? [map] : [],
  };
}
