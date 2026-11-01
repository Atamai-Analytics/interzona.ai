import { runReadOnlyQuery } from "@/lib/db";
import type { Dataset, Evidence } from "@/lib/types";

// Price outlook: ranges around the latest monthly price, not a forecast. markets.price_outlook holds, for 15 monthly IMF and World Bank series, 50% and 80% ranges at 1, 3, 6 and 12 months,
// centred on the latest price (no-change) and widened by a factor re-estimated from the trailing 120 months of known outcomes. markets.price_outlook_backtest holds the pre-registered back-test
// (selection 2005-2015, test 2016 onward): no tested model beat "no change" at any horizon, so no point forecast is published; the ranges hit their stated share on the test period.

type Out = { content: string; evidence?: Evidence[]; datasets?: Dataset[] };

const ALIASES: [RegExp, string][] = [
  [/uranium|u3o8/i, "Uranium"], [/cobalt/i, "Cobalt"], [/palladium/i, "Palladium"], [/platinum/i, "Platinum"], [/gold/i, "Gold"], [/silver/i, "Silver"], [/copper/i, "Copper"],
  [/nickel/i, "Nickel"], [/\btin\b/i, "Tin"], [/zinc/i, "Zinc"], [/\blead\b/i, "Lead"], [/alumin/i, "Aluminum"], [/iron/i, "Iron Ore"], [/phosph/i, "Phosphate"], [/potash|potass/i, "Potassium"],
];
const COVERED = "uranium, cobalt, palladium, platinum, gold, silver, copper, nickel, tin, zinc, lead, aluminium, iron ore, phosphate rock, potash (potassium chloride)";
const num = (x: unknown) => Number(x);
const sig = (x: number) => (Math.abs(x) >= 1000 ? Math.round(x).toLocaleString("en-US") : Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(2));

type Row = { series_id: number; series_name: string; unit: string; source: string; as_of_month: string; horizon_months: number; last_price: string; lo50: string; hi50: string; lo80: string; hi80: string };
type Bt = { horizon_months: number; best_model_selection: string; beat_naive_in_selection: boolean; point_forecast_ships: boolean; test_coverage50: string; test_coverage80: string; per_series: Record<string, { name: string; coverage80: number; coverage50: number }> };

export async function priceOutlook(input: Record<string, unknown>): Promise<Out> {
  const q = String(input.commodity ?? "").trim();
  const hit = ALIASES.find(([re]) => re.test(q));
  if (!hit) return { content: `No monthly price series for "${q}", so there is no price outlook for it. Monthly series cover: ${COVERED}. Lithium, rare earths, graphite and most other critical minerals have only annual USGS prices here, which are too few for a tested range. Say so and do not estimate one.` };
  const key = hit[1];
  const rows = (await runReadOnlyQuery(
    `SELECT o.series_id, s.series_name, s.unit, s.source, to_char(o.as_of_month,'YYYY-MM') AS as_of_month, o.horizon_months, o.last_price, o.lo50, o.hi50, o.lo80, o.hi80
       FROM markets.price_outlook o JOIN markets.price_series s USING (series_id)
      WHERE s.series_name ILIKE '${key === "Iron Ore" ? "%Iron Ore%" : key + "%"}' AND o.as_of_month = (SELECT max(as_of_month) FROM markets.price_outlook)
      ORDER BY (s.source='IMF_PCPS') DESC, o.series_id, o.horizon_months`, 20)).rows as unknown as Row[];
  if (!rows.length) return { content: `The price outlook table has no rows for ${key}.` };
  const sid = rows[0].series_id;
  const mine = rows.filter((r) => r.series_id === sid);
  const bt = (await runReadOnlyQuery(`SELECT * FROM markets.price_outlook_backtest ORDER BY horizon_months`, 10)).rows as unknown as Bt[];
  const hist = (await runReadOnlyQuery(`SELECT to_char(period_start,'YYYY-MM') AS m, value FROM markets.prices WHERE series_id = ${Number(sid)} AND value IS NOT NULL ORDER BY period_start DESC LIMIT 60`, 60)).rows as unknown as { m: string; value: string }[];
  hist.reverse();
  const r0 = mine[0];
  const unit = r0.unit;
  // A price that has not moved by more than 0.1% for several months looks like a stale or administered quote, not a live market: say so, because the ranges are built from this series.
  const lastV = num(hist[hist.length - 1]?.value);
  let flat = 0;
  for (let i = hist.length - 1; i >= 0 && lastV > 0 && Math.abs(num(hist[i].value) / lastV - 1) < 0.001; i--) flat++;
  const staleWarning = flat >= 4 ? `The monthly price has been within 0.1% of ${sig(lastV)} for the last ${flat} months. That looks like a stale or administered quote rather than a moving market, so treat the ranges for this series with caution and suggest checking a live price.` : undefined;
  const per = (h: number) => bt.find((b) => b.horizon_months === h)?.per_series?.[String(sid)];
  const rowsOut = mine.map((r) => [`${r.horizon_months} month${r.horizon_months > 1 ? "s" : ""}`, `${sig(num(r.lo50))} to ${sig(num(r.hi50))}`, `${sig(num(r.lo80))} to ${sig(num(r.hi80))}`]);
  const dataset: Dataset = {
    id: "outlook-" + Date.now().toString(36),
    title: `${r0.series_name.replace(/\s*\((IMF|World Bank Pink Sheet)\)\s*$/, "")}: range around ${r0.as_of_month} price (${unit}), not a forecast`,
    columns: ["Looking ahead", "50% range", "80% range"],
    rows: rowsOut,
    chart: { unit, series: [{ name: "Monthly price", points: hist.map((h) => [h.m, num(h.value)] as [string, number]) }] },
  };
  const covered = bt.map((b) => ({ horizon_months: b.horizon_months, best_model_in_selection: b.best_model_selection, any_model_beat_no_change: b.beat_naive_in_selection, point_forecast_published: b.point_forecast_ships, share_of_outcomes_inside_50pct_range_2016_on: num(b.test_coverage50), share_inside_80pct_range_2016_on: num(b.test_coverage80) }));
  return {
    content: JSON.stringify({
      series: r0.series_name, source: r0.source, unit, latest_month: r0.as_of_month, latest_price: num(r0.last_price),
      data_quality_warning: staleWarning,
      ranges: mine.map((r) => ({ looking_ahead_months: r.horizon_months, range_50pct: [num(r.lo50), num(r.hi50)], range_80pct: [num(r.lo80), num(r.hi80)] })),
      this_series_test_coverage_80pct: [1, 3, 6, 12].map((h) => ({ months: h, share_inside: per(h)?.coverage80 ?? null })),
      how_to_read: [
        "These are ranges around the latest monthly price, not a forecast: the centre is 'no change' and nothing here says which way the price will go.",
        "In a back-test (selection 2005-2015, test 2016 onward, rules written before running) NO tested model beat 'no change' at 1, 3, 6 or 12 months, so we publish no point forecast and no direction.",
        "About half of past outcomes fell inside the 50% range and about 80% inside the 80% range across the 15 series (see back_test); for a single series the share can differ, and low-volatility or administered prices such as phosphate and potash were inside less often (see this_series_test_coverage_80pct).",
        "A price outside the range is possible: roughly one outcome in five fell outside the 80% range.",
        "Do not describe the range as a prediction, a target, a bullish or bearish view or a probability that the price will reach a level; say 'in the past, one month/year-ahead prices stayed inside a range of this width about 4 times in 5'.",
      ],
      back_test: covered,
      not_covered: `Monthly series exist only for ${COVERED}. Lithium, rare earths, graphite and other critical minerals have only annual USGS prices here and no tested range.`,
      ranges_updated: "monthly, after the IMF and World Bank series are refreshed",
    }),
    evidence: [{ kind: "data", label: `Price outlook: ${r0.series_name}`, detail: `Ranges from a back-tested method (selection 2005-2015, test 2016 onward); latest price ${r0.as_of_month}. Not a forecast.` }],
    datasets: [dataset],
  };
}
