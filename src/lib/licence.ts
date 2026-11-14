import { runReadOnlyQuery } from "@/lib/db";

// Licence handling for data that leaves the app, in two parts:
//  1. Row limits. Greenland geochemistry (GEUS) was first treated as "derived products only" (GEUS permission letter of 6 May 2026), so queries returning
//     individual Greenland samples were cut to a short list. On 10 Nov 2026 the GEUS metadata catalogue showed every loaded Greenland layer is CC BY 4.0
//     (evidence: Licence_Evidence/GEUS_Greenland/geus_metadata_20261110), so the cap is OFF (GEUS_ROW_CAP_ENABLED). The code stays so it can be switched back on
//     in one line if GEUS's reply on the licence of our December 2025 - March 2026 downloads says otherwise.
//  2. Credits. The open-licence sources (CC BY and similar) require the publisher to be named wherever the data is reused, including in a downloaded CSV, so the
//     publishers behind an answer are worked out from the query and listed in its Sources and in the downloads.

export const GEUS_SAMPLE_ROW_CAP = 25;
/** Cap individual Greenland samples per chat query. Off since 10 Nov 2026 (data are CC BY 4.0 per the GEUS catalogue). */
export const GEUS_ROW_CAP_ENABLED = false;

/**
 * Multivariate tools: while true, Greenland (GEUS) samples can be analysed and plotted, but their sample-level values cannot be listed or
 * downloaded (tables, CSVs, map pop-ups). Unlocked 10 Nov 2026 (CC BY 4.0 per the GEUS catalogue); credit GEUS and MMR.
 */
export const GEUS_RAW_DATA_LOCKED = false;

const GEUS = "GREENLAND_GEUS";

type Cell = Record<string, unknown>;

/** Cuts individual Greenland (GEUS) samples in a query result to a short list. Returns the rows to use and a note for the model when anything was cut. */
export async function limitRestrictedRows(sql: string, rows: Cell[]): Promise<{ rows: Cell[]; note?: string }> {
  if (!GEUS_ROW_CAP_ENABLED || rows.length <= GEUS_SAMPLE_ROW_CAP) return { rows };
  const hasSampleColumn = rows.some((r) => "sample_id" in r || "result_id" in r || "field_id" in r || "sample_number" in r);
  if (!hasSampleColumn) return { rows };
  const mentionsGeus = new RegExp(GEUS, "i").test(sql);
  let restricted: Set<number> | null = null; // null = every row is a GEUS sample
  if (!mentionsGeus) {
    const ids = [...new Set(rows.map((r) => Number(r.sample_id)).filter((n) => Number.isFinite(n)))].slice(0, 500);
    if (ids.length === 0) return { rows };
    const found = await runReadOnlyQuery(`SELECT sample_id FROM geochem.samples WHERE source_system = '${GEUS}' AND sample_id = ANY(ARRAY[${ids.join(",")}]::bigint[])`, 500);
    restricted = new Set(found.rows.map((r) => Number(r.sample_id)));
    if (restricted.size <= GEUS_SAMPLE_ROW_CAP) return { rows };
  }
  let seen = 0;
  let cut = 0;
  const kept = rows.filter((r) => {
    const isGeus = restricted === null || restricted.has(Number(r.sample_id));
    if (!isGeus) return true;
    seen++;
    if (seen <= GEUS_SAMPLE_ROW_CAP) return true;
    cut++;
    return false;
  });
  if (cut === 0) return { rows };
  return {
    rows: kept,
    note:
      `LICENCE LIMIT: our policy under the GEUS permission is to show at most ${GEUS_SAMPLE_ROW_CAP} individual Greenland (GEUS) samples per query (${cut} more were left out of ${seen} found). GEUS allows derived products ` +
      "(analyses, maps, summaries), not the full raw sample or result tables. Do not repeat the query to page through them. Say it consistently: you are showing " +
      `the first ${GEUS_SAMPLE_ROW_CAP} of the ${seen} matching samples, which our policy allows, and the full list cannot be given under the GEUS permission (do not say that no list ` +
      "is allowed while showing one). Then offer summaries, statistics, gridded or clustered areas, a map, or an analysis of all the samples instead.",
  };
}

// ---- Credits ---------------------------------------------------------------------------------------------------------------------------------
const CREDITS: [RegExp, string][] = [
  [/greenland_geus|greenland/i, "Geological Survey of Denmark and Greenland (GEUS) and the Mineral Resources Authority (MMR), Government of Greenland; Greenland Mineral Resources Portal; CC BY 4.0"],
  [/argentina_segemar|argentin|sigam|segemar/i, "SEGEMAR / SIGAM, Argentina (CC BY 4.0)"],
  [/finland_gtk/i, "Geological Survey of Finland (GTK), CC BY 4.0"],
  [/sweden_sgu/i, "Geological Survey of Sweden (SGU), CC0"],
  [/spain_igme|igme/i, "Source: © NC Geological Survey of Spain (IGME); FOREGS campaigns via IGME"],
  [/usa_usgs_ngdb/i, "U.S. Geological Survey, National Geochemical Database"],
  [/usa_nure_hssr/i, "U.S. Geological Survey, NURE HSSR data (Smith 1997, OFR 97-492), from the U.S. Department of Energy NURE program"],
  [/australia_vic|victoria/i, "Geological Survey of Victoria, State of Victoria (DEECA), CC BY 4.0"],
  [/australia_tas|tasmania|drilling\./i, "Mineral Resources Tasmania, Department of State Growth (State of Tasmania), bulk data package BDR2023_01, CC BY 3.0 AU"],
  [/global_deposit_geochem_ga|sample_deposit_context/i, "Geoscience Australia / Critical Minerals Mapping Initiative with the Geological Survey of Canada and the USGS, Critical Minerals in Ores - geochemistry database (CC BY 4.0)"],
  [/global_zircon/i, "Wu, Fang and Ji (2023), zircon database (CC BY 4.0)"],
  [/washington/i, "Washington Geological Survey (Washington State Department of Natural Resources)"],
  [/mrds/i, "U.S. Geological Survey, Mineral Resources Data System"],
  [/usgs_africa|migration_usgs_africa/i, "U.S. Geological Survey, Compilation of Geospatial Data (GIS) for the Mineral Industries and Related Infrastructure of Africa (2021), doi:10.5066/P97EQWXP"],
  // \bcanada\b catches country filters ('Canada'); source codes such as canada_qc_sigeom are matched by their own patterns
  [/\bcanada\b|qu[eé]bec|sigeom|canada_qc|migration_canada_occ|drilling\./i, "Ministère des Ressources naturelles et des Forêts, Québec, SIGÉOM (Indices, gîtes, mines et carrières; Géochimie; Sondages), CC BY 4.0"],
  [/\bcanada\b|saskatchewan|smdi|canada_sk|migration_canada_occ|drilling\./i, "Saskatchewan Mining and Petroleum GeoAtlas, Saskatchewan Geological Survey (Mineral Deposit Index; drill holes; till and lake-sediment geochemistry, incl. Geological Survey of Canada lake-sediment data), retrieved 3 November 2026; Government of Saskatchewan Standard Unrestricted Use Data Licence v2.0"],
  [/\bcanada\b|\bnrcan\b|migration_nrcan/i, "Natural Resources Canada, critical minerals projects list and Major Projects Inventory (Open Government Licence - Canada)"],
  [/\bcanada\b|cdogs|canada_nrcan/i, "Natural Resources Canada, Geological Survey of Canada, Canadian Database of Geochemical Surveys (CDoGS) (Open Government Licence - Canada)"],
  // the Athabasca core samples hang off Saskatchewan drill holes, so any drilling query may use them
  [/\bcanada\b|athabasca|of_?7792|canada_athabasca|saskatchewan|drilling\./i, "Wright, Potter and Comeau (2015), Athabasca Basin Uranium Geochemistry Database v.2, Geological Survey of Canada, Open File 7792 (Open Government Licence - Canada)"],
];

/** The publishers behind a query, worked out from the names in it. */
export function creditsFromText(text: string): string[] {
  const out: string[] = [];
  for (const [re, credit] of CREDITS) if (re.test(text) && !out.includes(credit)) out.push(credit);
  return out;
}

export function creditsForSource(sourceSystem: string | undefined): string[] {
  return sourceSystem ? creditsFromText(sourceSystem) : [];
}
