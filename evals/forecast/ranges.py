"""Step 2 of the forecast back-test (see PREREG_2.md): calibrate the widening of the empirical ranges on 2005-2015 and test on 2016 onward. Read-only on the database.
Usage: python evals/forecast/ranges.py"""
import json, os, sys, datetime
import numpy as np
import psycopg2

sys.stdout.reconfigure(encoding="utf8")
HERE = os.path.dirname(os.path.abspath(__file__))
ENV = {}
for l in open(os.path.join(HERE, "..", "..", ".env.local"), encoding="utf8"):
    if "=" in l and not l.startswith("#"):
        k, v = l.rstrip("\r\n").split("=", 1); ENV[k] = v.strip('"')
con = psycopg2.connect(host=ENV["PGHOST"], port=ENV.get("PGPORT", 5432), dbname=ENV["PGDATABASE"], user=ENV["PGUSER"], password=ENV["PGPASSWORD"])
con.set_session(readonly=True, autocommit=True)
cur = con.cursor()
SERIES = [52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 40, 41]
HORIZONS = [1, 3, 6, 12]
SEL_START, SEL_END, TEST_START = "2005-01", "2015-12", "2016-01"

def load(sid):
    cur.execute("SELECT s.series_name, p.period_start, p.value FROM markets.prices p JOIN markets.price_series s USING(series_id) WHERE s.series_id=%s AND p.value>0 ORDER BY p.period_start", (sid,))
    rows = cur.fetchall()
    months = [r[1].strftime("%Y-%m") for r in rows]
    ym = [int(m[:4]) * 12 + int(m[5:]) - 1 for m in months]
    assert all(b - a == 1 for a, b in zip(ym, ym[1:])), f"gap in series {sid}"
    return rows[0][0], months, np.log(np.array([float(r[2]) for r in rows]))

def interval_scale(y, t, h):
    d = np.diff(y)
    hist = (y[h: t + 1] - y[: t + 1 - h])[-240:]
    vol_recent = d[max(0, t - 24): t].std(); vol_long = d[max(0, t - 240): t].std()
    k = min(2.0, max(0.5, vol_recent / vol_long if vol_long > 0 else 1.0))
    q = lambda p: float(np.quantile(hist - hist.mean(), p))
    return {"50": (q(0.25) * k, q(0.75) * k), "80": (q(0.10) * k, q(0.90) * k)}

rows = {h: [] for h in HORIZONS}   # (sid, month, chg, lo50, hi50, lo80, hi80)
names = {}
for sid in SERIES:
    name, months, y = load(sid); names[sid] = name
    for h in HORIZONS:
        for t in range(len(y) - h):
            if months[t] < SEL_START: continue
            iv = interval_scale(y, t, h)
            rows[h].append((sid, months[t], y[t + h] - y[t], *iv["50"], *iv["80"]))
out = dict(prereg="evals/forecast/PREREG_2.md", run=datetime.datetime.now().isoformat(timespec="seconds"), horizons={})
grid = np.round(np.arange(1.0, 2.5001, 0.01), 2)
def cov(rs, c, lo_i, hi_i): return float(np.mean([r[lo_i] * c <= r[2] <= r[hi_i] * c for r in rs])) if rs else float("nan")
for h in HORIZONS:
    sel = [r for r in rows[h] if SEL_START <= r[1] <= SEL_END]; test = [r for r in rows[h] if r[1] >= TEST_START]
    c = {}
    for lvl, nominal, lo_i, hi_i in (("50", 0.50, 3, 4), ("80", 0.80, 5, 6)):
        c[lvl] = next((float(g) for g in grid if cov(sel, g, lo_i, hi_i) >= nominal), float(grid[-1]))
    res = dict(multiplier={k: v for k, v in c.items()},
               selection_coverage={"50": round(cov(sel, c["50"], 3, 4), 3), "80": round(cov(sel, c["80"], 5, 6), 3)},
               test_coverage_uncalibrated={"50": round(cov(test, 1.0, 3, 4), 3), "80": round(cov(test, 1.0, 5, 6), 3)},
               test_coverage_calibrated={"50": round(cov(test, c["50"], 3, 4), 3), "80": round(cov(test, c["80"], 5, 6), 3)})
    res["accepted"] = bool(0.45 <= res["test_coverage_calibrated"]["50"] <= 0.55 and 0.75 <= res["test_coverage_calibrated"]["80"] <= 0.85)
    per = {}
    for sid in SERIES:
        rs = [r for r in test if r[0] == sid]
        per[str(sid)] = dict(name=names[sid][:40], c50=round(cov(rs, c["50"], 3, 4), 2), c80=round(cov(rs, c["80"], 5, 6), 2), n=len(rs))
    res["per_series_test"] = per
    out["horizons"][str(h)] = res
    print(f"h={h}: multipliers 50%={c['50']:.2f} 80%={c['80']:.2f}; selection coverage {res['selection_coverage']}; test uncalibrated {res['test_coverage_uncalibrated']} -> calibrated {res['test_coverage_calibrated']}; accepted={res['accepted']}", flush=True)
    worst = sorted(per.items(), key=lambda kv: abs(kv[1]["c80"] - 0.8), reverse=True)[:3]
    print("   furthest series on the 80% range:", [(v["name"][:14], v["c80"]) for k, v in worst])
json.dump(out, open(os.path.join(HERE, "ranges_results.json"), "w", encoding="utf8"), indent=1, ensure_ascii=False)
print("saved ranges_results.json")
