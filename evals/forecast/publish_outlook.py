"""Computes the price ranges at the latest month for the 15 series (rolling calibration of PREREG_3.md, trailing 120 months of known outcomes, pooled over series)
and writes them, with the back-test summary, to markets.price_outlook and markets.price_outlook_backtest. Run monthly after the price series are refreshed.
Needs backtest_results.json and ranges_rolling_results.json from the back-test. Uses the write login from .env.local; local use only.
Usage: python evals/forecast/publish_outlook.py [--dry-run]"""
import json, os, sys
import numpy as np
import psycopg2

sys.stdout.reconfigure(encoding="utf8")
HERE = os.path.dirname(os.path.abspath(__file__))
ENV = {}
for l in open(os.path.join(HERE, "..", "..", ".env.local"), encoding="utf8"):
    if "=" in l and not l.startswith("#"):
        k, v = l.rstrip("\r\n").split("=", 1); ENV[k] = v.strip('"')
DRY = "--dry-run" in sys.argv
SERIES = [52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 40, 41]
HORIZONS = [1, 3, 6, 12]
grid = np.round(np.arange(1.0, 2.5001, 0.01), 2)
read = psycopg2.connect(host=ENV["PGHOST"], port=ENV.get("PGPORT", 5432), dbname=ENV["PGDATABASE"], user=ENV["PGUSER"], password=ENV["PGPASSWORD"])
read.set_session(readonly=True, autocommit=True)
rc = read.cursor()

def load(sid):
    rc.execute("SELECT p.period_start, p.value FROM markets.prices p WHERE p.series_id=%s AND p.value>0 ORDER BY p.period_start", (sid,))
    rows = rc.fetchall()
    months = [r[0].strftime("%Y-%m") for r in rows]
    ym = [int(m[:4]) * 12 + int(m[5:]) - 1 for m in months]
    assert all(b - a == 1 for a, b in zip(ym, ym[1:])), f"gap in series {sid}"
    return months, np.array([float(r[1]) for r in rows])

def interval_scale(y, t, h):   # identical to backtest.py / ranges.py
    d = np.diff(y)
    hist = (y[h: t + 1] - y[: t + 1 - h])[-240:]
    vol_recent = d[max(0, t - 24): t].std(); vol_long = d[max(0, t - 240): t].std()
    k = min(2.0, max(0.5, vol_recent / vol_long if vol_long > 0 else 1.0))
    q = lambda p: float(np.quantile(hist - hist.mean(), p))
    return {"50": (q(0.25) * k, q(0.75) * k), "80": (q(0.10) * k, q(0.90) * k)}

data = {s: load(s) for s in SERIES}
ymn = lambda m: int(m[:4]) * 12 + int(m[5:]) - 1
last_month = min(d[0][-1] for d in data.values())     # common latest month
print("latest common month:", last_month)
# --if-new (used by the monthly scheduled task): do nothing unless a month newer than the published one is available; warn if the price tables themselves look stale
import datetime as _dt
rc.execute("SELECT to_char(max(as_of_month), 'YYYY-MM') FROM markets.price_outlook")
published = rc.fetchone()[0]
print("published month:", published)
age_days = (_dt.date.today() - _dt.date(int(last_month[:4]), int(last_month[5:]), 1)).days
if age_days > 100:
    print(f"WARNING: the newest common price month is {last_month}, {age_days} days old - the IMF / World Bank price tables may need refreshing before the ranges can move")
if "--if-new" in sys.argv and published and last_month <= published:
    print(f"nothing new: {last_month} is already published")
    sys.exit(0)           # a normal outcome, not an error: the scheduled task's log must not show it as a failure
out_rows = []
for h in HORIZONS:
    # pooled calibration rows: origins whose outcome is known at the latest month, trailing 120 months of origins
    cal = []
    for s in SERIES:
        months, p = data[s]; y = np.log(p)
        end = months.index(last_month)
        for t in range(end - h - 119, end - h + 1):
            iv = interval_scale(y, t, h)
            cal.append((y[t + h] - y[t], *iv["50"], *iv["80"]))
    cal = np.array(cal)
    c = {}
    for lvl, nominal, a, b in (("50", 0.5, 1, 2), ("80", 0.8, 3, 4)):
        ok = ((cal[:, [0]] >= cal[:, [a]] * grid[None, :]) & (cal[:, [0]] <= cal[:, [b]] * grid[None, :])).mean(axis=0)
        hit = np.where(ok >= nominal)[0]
        c[lvl] = float(grid[hit[0]]) if len(hit) else float(grid[-1])
    for s in SERIES:
        months, p = data[s]; y = np.log(p); t = months.index(last_month)
        iv = interval_scale(y, t, h); last = float(p[t])
        out_rows.append((s, last_month + "-01", h, last, float(last * np.exp(iv["50"][0] * c["50"])), float(last * np.exp(iv["50"][1] * c["50"])),
                         float(last * np.exp(iv["80"][0] * c["80"])), float(last * np.exp(iv["80"][1] * c["80"])), c["50"], c["80"]))
    print(f"h={h}: multipliers 50%={c['50']:.2f} 80%={c['80']:.2f}")
bt = json.load(open(os.path.join(HERE, "backtest_results.json"), encoding="utf8"))
rr = json.load(open(os.path.join(HERE, "ranges_rolling_results.json"), encoding="utf8"))
PROTOCOL = ("Pre-registered back-test (evals/forecast/PREREG.md, PREREG_3.md): monthly IMF and World Bank price series, selection origins 2005-2015, test origins 2016 onward. "
            "Models tried: naive, drift, exponential smoothing, mean reversion, momentum, and a regression on both. Ranges are centred on the latest price (no-change) and widened by a factor re-estimated each month from the trailing 120 months of known outcomes.")
bt_rows = []
for h in HORIZONS:
    b = bt["horizons"][str(h)]; r = rr["horizons"][str(h)]
    per = {s: dict(name=bt["series"][s], coverage80=r["per_series_test"][s]["c80"], coverage50=r["per_series_test"][s]["c50"]) for s in bt["series"]}
    bt_rows.append((h, b["chosen"], b["chosen"] != "naive", b["ships_point_forecast"], r["test_coverage_rolling"]["50"], r["test_coverage_rolling"]["80"], json.dumps(per), PROTOCOL))
for r in out_rows[:3]: print(r)
if DRY: sys.exit("dry run: nothing written")
w = psycopg2.connect(host=ENV["PGHOST"], port=ENV.get("PGPORT", 5432), dbname=ENV["PGDATABASE"], user=ENV["PGUSER_WRITE"], password=ENV["PGPASSWORD_WRITE"])
wc = w.cursor()
for r in out_rows:
    wc.execute("""INSERT INTO markets.price_outlook (series_id, as_of_month, horizon_months, last_price, lo50, hi50, lo80, hi80, mult50, mult80, method)
                  VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'no-change centre; rolling-calibrated empirical range')
                  ON CONFLICT (series_id, as_of_month, horizon_months) DO UPDATE SET last_price=EXCLUDED.last_price, lo50=EXCLUDED.lo50, hi50=EXCLUDED.hi50, lo80=EXCLUDED.lo80, hi80=EXCLUDED.hi80, mult50=EXCLUDED.mult50, mult80=EXCLUDED.mult80, computed_at=now()""", r)
for r in bt_rows:
    wc.execute("""INSERT INTO markets.price_outlook_backtest (horizon_months, best_model_selection, beat_naive_in_selection, point_forecast_ships, test_coverage50, test_coverage80, per_series, protocol)
                  VALUES (%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (horizon_months) DO UPDATE SET best_model_selection=EXCLUDED.best_model_selection, beat_naive_in_selection=EXCLUDED.beat_naive_in_selection,
                  point_forecast_ships=EXCLUDED.point_forecast_ships, test_coverage50=EXCLUDED.test_coverage50, test_coverage80=EXCLUDED.test_coverage80, per_series=EXCLUDED.per_series, protocol=EXCLUDED.protocol, computed_at=now()""", r)
w.commit()
print("wrote", len(out_rows), "outlook rows and", len(bt_rows), "back-test rows")
