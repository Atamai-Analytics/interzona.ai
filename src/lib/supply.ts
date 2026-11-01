import { runReadOnlyQuery } from "@/lib/db";
import type { Dataset, Evidence } from "@/lib/types";

// Supply concentration: who produces, refines and holds the reserves of each critical mineral, from the USGS Mineral Commodity Summaries 2026 world tables
// (markets.supply_concentration and its country rows, loaded and checked against the MCS PDF). Shares are of the reported world total where there is one,
// otherwise of the countries listed; the HHI counts the named countries only, so it is a lower bound.

type Out = { content: string; evidence?: Evidence[]; datasets?: Dataset[] };

const STAGES: Record<string, string> = {
  mine_production: "Mine production",
  refinery_production: "Refinery production",
  smelter_production: "Smelter production",
  primary_production: "Primary production",
  sponge_production: "Sponge production",
  production: "Production",
  capacity: "Capacity",
  reserves: "Reserves",
};
const STAGE_ORDER = ["mine_production", "primary_production", "refinery_production", "smelter_production", "sponge_production", "production", "capacity", "reserves"];
const ALIASES: Record<string, string> = { ree: "Rare Earths", "rare earth": "Rare Earths", "rare earths": "Rare Earths", pgm: "Platinum-Group Metals", pgms: "Platinum-Group Metals", "platinum group": "Platinum-Group Metals", graphite: "Graphite (Natural)", niobium: "Niobium (Columbium)", columbium: "Niobium (Columbium)", magnesium: "Magnesium Metal", titanium: "Titanium", tio2: "Tio2 Pigment", rutile: "Titanium Mineral Concentrates", ilmenite: "Titanium Mineral Concentrates" };
const CREDIT = "U.S. Geological Survey, Mineral Commodity Summaries 2026 (public domain; courtesy credit)";
const num = (x: unknown) => (x === null || x === undefined ? null : Number(x));
const r1 = (x: number | null) => (x === null ? null : Math.round(x * 10) / 10);

type Group = {
  group_id: number; commodity: string; stage: string; detail: string; unit: string; data_year: number; is_estimate: boolean; n_countries_listed: number; n_countries_with_figure: number;
  denominator: string; denominator_basis: string; world_total_reported: string | null; world_total_is_lower_bound: boolean; named_coverage_pct: string; top1_country: string; top1_share_pct: string;
  top2_country: string | null; top2_share_pct: string | null; top3_share_pct: string; hhi_named: string; flags: string | null;
};

const stageName = (g: Group) => STAGES[g.stage] ?? g.stage;
// Titanium and potash have several products in one stage: name the product when more than one group shares a stage and year.
const label = (g: Group, all: Group[]) => {
  const same = all.filter((x) => x.commodity === g.commodity && x.stage === g.stage && x.data_year === g.data_year).length > 1;
  return same ? `${stageName(g)} (${g.detail.replace(/^(mine production|reserves)[:,]?\s*/i, "").replace(/\s*\(.*$/, "") || g.detail})` : stageName(g);
};

export async function supplyConcentration(input: Record<string, unknown>): Promise<Out> {
  const query = String(input.commodity ?? "").trim();
  const stageIn = String(input.stage ?? "").trim().toLowerCase().replace(/\s+/g, "_");
  const yearIn = Number(input.year);
  const rankBy = String(input.rank_by ?? "top_share") === "hhi" ? "hhi" : "top_share";
  const topN = Math.max(3, Math.min(20, Number(input.top_n) || 12));
  const evidence: Evidence[] = [{ kind: "data", label: `Supply concentration: ${CREDIT}`, detail: "2025 production and capacity are USGS estimates; USGS withholds some company data" }];

  const all = (await runReadOnlyQuery(`SELECT * FROM markets.supply_concentration WHERE is_active ORDER BY commodity, data_year DESC, group_id`, 400)).rows as unknown as Group[];
  const commodities = [...new Set(all.map((g) => g.commodity))].sort();

  // ---- league table across commodities --------------------------------------------------------------------------------------------------
  if (!query) {
    const stage = STAGES[stageIn] ? stageIn : "mine_production";
    const year = yearIn === 2024 ? 2024 : 2025;
    const sel = all.filter((g) => g.stage === stage && g.data_year === year);
    const sorted = [...sel].sort((a, b) => (rankBy === "hhi" ? Number(b.hhi_named) - Number(a.hhi_named) : Number(b.top1_share_pct) - Number(a.top1_share_pct)));
    const rows = sorted.slice(0, topN).map((g) => [label(g, all) === stageName(g) ? g.commodity : `${g.commodity} (${label(g, all).replace(/^.*\(|\)$/g, "")})`, g.top1_country, r1(num(g.top1_share_pct)), r1(num(g.top3_share_pct)), Math.round(Number(g.hhi_named)), r1(num(g.named_coverage_pct))]);
    const dataset: Dataset = {
      id: "supply-" + Date.now().toString(36),
      title: `Most concentrated critical-mineral supply: ${STAGES[stage].toLowerCase()}, ${year}${year === 2025 && stage !== "reserves" ? " (estimate)" : ""}`,
      columns: ["Commodity", "Largest country", "Largest share (%)", "Top three (%)", "HHI (named countries)", "Countries named cover (% of total)"],
      rows,
      bars: { unit: `% of world ${STAGES[stage].toLowerCase()} from the largest country`, legend: ["Largest country"], items: sorted.slice(0, Math.min(topN, 12)).map((g) => ({ label: `${g.commodity} (${g.top1_country})`, value: r1(num(g.top1_share_pct)) ?? 0 })) },
    };
    return {
      content: JSON.stringify({
        what: "League table of the critical minerals whose supply is most concentrated, from the USGS Mineral Commodity Summaries 2026",
        stage: STAGES[stage], year, ranked_by: rankBy === "hhi" ? "HHI of named countries" : "share of the largest country", commodities_covered: sel.length,
        rows: sorted.slice(0, topN).map((g) => ({ commodity: g.commodity, detail: g.detail, largest: g.top1_country, largest_share_pct: r1(num(g.top1_share_pct)), top3_share_pct: r1(num(g.top3_share_pct)), hhi_named: Math.round(Number(g.hhi_named)), named_coverage_pct: r1(num(g.named_coverage_pct)), flags: g.flags })),
        other_production_stages_same_year: stage === "mine_production"
          ? all
              .filter((g) => g.data_year === year && ["refinery_production", "smelter_production", "primary_production", "sponge_production", "production"].includes(g.stage))
              .sort((x, y) => Number(y.top1_share_pct) - Number(x.top1_share_pct))
              .slice(0, 12)
              .map((g) => ({ commodity: g.commodity, stage: stageName(g), largest: g.top1_country, largest_share_pct: r1(num(g.top1_share_pct)), top3_share_pct: r1(num(g.top3_share_pct)) }))
          : undefined,
        not_in_this_table: "Commodities USGS does not break down by country for this stage, and boron, silicon and scandium (see how_to_read). Stages differ by commodity: a commodity with no refinery row has no refining figure here.",
        how_to_read: HOW_TO_READ,
        credit: CREDIT,
      }),
      evidence,
      datasets: [dataset],
    };
  }

  // ---- one commodity --------------------------------------------------------------------------------------------------------------------
  const q = query.toLowerCase();
  const alias = ALIASES[q];
  let match = commodities.filter((c) => (alias ? c === alias || c.startsWith(alias) : c.toLowerCase() === q));
  if (!match.length) match = commodities.filter((c) => c.toLowerCase().includes(q) || (q.length > 3 && q.includes(c.toLowerCase())));
  if (!match.length) return { content: `No supply-concentration data for "${query}". Commodities available (USGS critical minerals with a country breakdown): ${commodities.join("; ")}. Boron, silicon and scandium are not included because their USGS tables are split by product or have no country breakdown.` };

  const mine = all.filter((g) => match.includes(g.commodity));
  const latest = Math.max(...mine.map((g) => g.data_year));
  const year = yearIn === 2024 || yearIn === 2025 ? yearIn : latest;
  let groups = mine.filter((g) => (g.stage === "reserves" ? true : g.data_year === year));
  if (stageIn && STAGES[stageIn]) groups = groups.filter((g) => g.stage === stageIn);
  groups = groups.filter((g) => g.stage === "reserves" || g.data_year === year);
  groups.sort((a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage));
  if (!groups.length) return { content: `${match.join(", ")} has no ${stageIn ? STAGES[stageIn] ?? stageIn : "supply"} table for ${year} in the USGS data. Stages available: ${[...new Set(mine.map((g) => `${stageName(g)} ${g.data_year}`))].join("; ")}.` };

  const ids = groups.map((g) => g.group_id).join(",");
  const rowsDb = (await runReadOnlyQuery(`SELECT group_id, country, value_num, share_pct, rank, row_kind FROM markets.supply_concentration_countries WHERE group_id IN (${ids}) ORDER BY group_id, rank NULLS LAST`, 600)).rows as unknown as { group_id: number; country: string; value_num: string | null; share_pct: string | null; rank: number | null; row_kind: string }[];
  const datasets: Dataset[] = [];
  const out = groups.map((g) => {
    const cs = rowsDb.filter((r) => r.group_id === g.group_id);
    const listed = cs.filter((r) => r.row_kind === "listed").slice(0, 8);
    const noFig = cs.filter((r) => r.row_kind !== "listed" && r.row_kind !== "zero" && r.row_kind !== "other").map((r) => r.country);
    const zero = cs.filter((r) => r.row_kind === "zero").map((r) => r.country);
    const other = cs.find((r) => r.row_kind === "other");
    const unit = g.unit.trim();
    const name = label(g, all);
    const title = `${g.commodity}: ${name.toLowerCase()}, ${g.data_year}`;
    datasets.push({
      id: `supply-${g.group_id}`,
      title,
      columns: ["Rank", "Country", `Quantity (${unit})`, "Share (%)"],
      rows: [...listed.map((r, i) => [i + 1, r.country, num(r.value_num), r1(num(r.share_pct))]), ...(other?.value_num ? [["", "Other countries (USGS combined)", num(other.value_num), r1(num(other.share_pct))]] : [])],
      bars: { unit: `% of ${g.denominator_basis.startsWith("reported") ? "the reported world total" : "the countries listed"}`, legend: ["Share"], items: listed.slice(0, 6).map((r) => ({ label: r.country, value: r1(num(r.share_pct)) ?? 0 })) },
    });
    const hhi = Number(g.hhi_named);
    return {
      stage: name, year: g.data_year, is_usgs_estimate: g.is_estimate, detail: g.detail, unit,
      world_total: g.world_total_reported ? `${g.world_total_is_lower_bound ? ">" : ""}${Number(g.world_total_reported).toLocaleString("en-US")}` : null,
      shares_are_of: g.denominator_basis, named_countries_cover_pct: r1(num(g.named_coverage_pct)),
      top: listed.slice(0, 6).map((r) => ({ country: r.country, quantity: num(r.value_num), share_pct: r1(num(r.share_pct)) })),
      top3_share_pct: r1(num(g.top3_share_pct)),
      hhi_named_countries: Math.round(hhi),
      as_if_equal_suppliers_at_most: Math.round((10000 / hhi) * 10) / 10,
      countries_listed: g.n_countries_listed, countries_with_a_figure: g.n_countries_with_figure,
      zero_listed_by_usgs: zero, no_figure_listed: noFig, other_countries_combined: other?.value_num ? { quantity: num(other.value_num), share_pct: r1(num(other.share_pct)) } : null,
      notes: g.flags,
    };
  });
  const top1s = out.filter((o) => o.top.length).map((o) => `${o.stage} ${o.year}: ${o.top[0].country} ${o.top[0].share_pct}%`);
  return {
    content: JSON.stringify({
      what: `Who supplies ${match.join(" / ")}: country shares at each stage, from the USGS Mineral Commodity Summaries 2026`,
      commodity: match, year_shown: year, stages: out, headline_by_stage: top1s,
      stages_not_available: "Only the stages above are in the USGS tables for this commodity; if refining or processing is not listed, there is no figure here and none should be quoted.",
      how_to_read: HOW_TO_READ,
      credit: CREDIT,
    }),
    evidence,
    datasets,
  };
}

const HOW_TO_READ =
  "USGS estimates, not audited statistics: 2025 production and capacity are estimates, 2024 is the latest reported year, reserves are as listed for 2025. " +
  "Shares are of the reported world total when there is one and the countries' figures fit within its rounding, otherwise of the sum of the countries listed (the basis is given for each row). USGS rounds world totals and withholds some company data (shown as W), " +
  "so the United States can be missing; a dash in the USGS table means zero, and some countries have no figure. HHI counts only the named countries (the sum of squared percentage shares, 0 to 10,000), so the true value is higher; " +
  "'as if N equal suppliers' is an upper bound on N. Quantities are in the unit given (metal or oxide content, or gross weight, depending on the commodity), so do not add numbers across different stages. " +
  "Reserves are what USGS lists country by country under differing national definitions and are not directly comparable with production or with resources. " +
  "Do not describe how a mineral is produced (for example as a by-product) unless a cited document says so. "
  + "Do not say that refining or processing is generally more concentrated than mining: compare stages only where this data has both for the same commodity, and quote the figures. " +
  "This is where material is produced, not who owns it, and it says nothing about trade, stocks, export controls or substitutes: do not infer causes or risks from the shares alone. Boron, silicon and scandium are not included.";
