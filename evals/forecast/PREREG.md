# Forecast back-test: pre-registration (written 2026-10-27, before any model was run)

Question: can a simple model forecast monthly commodity prices better than "next month equals this month" (the naive forecast)? A forecast ships to users only if the answer is yes under the rule below. Otherwise the module shows calibrated ranges and says plainly that no tested model beat naive.

## Data
Monthly prices from `markets.prices`: IMF (series 52-64: uranium, cobalt, palladium, platinum, gold, silver, copper, nickel, tin, zinc, lead, aluminium, iron ore) and World Bank phosphate rock (40) and potassium chloride (41). 15 series. Coal and series duplicated between sources are left out. All modelling is on log prices. Horizons h = 1, 3, 6, 12 months.

## Models (every one uses only data up to the forecast origin)
1. `naive`: last value (the benchmark).
2. `drift`: last value plus h times the mean monthly change of the last 120 months.
3. `ses`: simple exponential smoothing of log price, smoothing weight chosen by grid on the trailing 240 months.
4. `meanrev`: direct regression of the h-month change on (log price minus its trailing 120-month mean).
5. `mom`: direct regression of the h-month change on the past 12-month change.
6. `reg`: direct regression of the h-month change on both of the above.
Regressions are fitted on at most the trailing 360 months of pairs that were fully observed at the origin (target date no later than the origin). No other models, features or tuning are tried.

## Split
* Selection period: origins 2005-01 to 2015-12. The best model per horizon is the one with the lowest pooled mean absolute error (log scale) over this period, naive included.
* Test period: origins 2016-01 to the last origin with a known outcome. Only the model chosen in the selection period is tested against naive. Other models are reported for information only and cannot ship.

## Decision rule (a point forecast ships for a horizon only if all hold)
1. The chosen model is not naive.
2. Pooled over series, skill = 1 - MAE_model / MAE_naive on the test period is above 0 with the lower end of its 95% interval above 0 (moving-block bootstrap, 24-month blocks of origin dates, same dates for all series).
3. It beats naive on at least 10 of the 15 series on the test period.
If any fail, no point forecast ships for that horizon.

## Ranges (ship regardless, with measured hit rate)
For each series and horizon: 50% and 80% intervals from the empirical quantiles of h-month changes of the trailing 240 months, scaled by recent volatility (trailing 24-month volatility over trailing 240-month volatility, limited to 0.5-2). Reported: share of test-period outcomes that fell inside each interval (should be about 50% and 80%).

## Reporting
Both the shipped and not-shipped results are reported, with the per-series table. Nothing here is edited after the run; any later change is a new, dated pre-registration.
