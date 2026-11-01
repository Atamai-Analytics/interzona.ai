# Pre-registration 2: calibrating the ranges (written 2026-10-27, after backtest.py was run, before ranges.py was run)

What backtest.py found (see backtest_results.json): no tested model beat naive in the selection period at any horizon, so under PREREG.md no point forecast ships. The 50% and 80% ranges covered 39-45% and 71-74% of test outcomes, i.e. they were too narrow by about 5-10 points.

Step 2 changes only the ranges. For each horizon h, a single widening multiplier c50(h) and c80(h) (the same for all 15 series) is chosen as the smallest value, on a grid from 1.00 to 2.50 in steps of 0.01, at which the pooled coverage over selection-period origins (2005-01 to 2015-12) reaches the nominal 50% and 80%. The multipliers are then applied unchanged to the test period (2016-01 onward) and the coverage is reported. No other setting is changed (same centre = no change, same trailing 240-month quantiles, same volatility scaling).

Acceptance for shipping the ranges: test-period coverage of the 80% range between 75% and 85%, and of the 50% range between 45% and 55%, at every horizon. If a horizon misses, its range is shown only with the measured test coverage printed beside it and the words "narrower than stated" or "wider than stated" as appropriate.

Per-series test coverage is also reported, since pooled coverage can hide a series that is far off.
