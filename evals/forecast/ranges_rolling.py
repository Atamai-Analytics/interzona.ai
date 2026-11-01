"""Step 3 of the forecast back-test (see PREREG_3.md): re-estimate the range widening at every origin from the trailing 120 months of known outcomes. Read-only on the database.
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
out = dict(prereg="evals/forecast/PREREG_3.md", run=datetime.datetime.now().isoformat(timespec="seconds"), horizons={})
grid = np.round(np.arange(1.0, 2.5001, 0.01), 2)
def ym(m): return int(m[:4]) * 12 + int(m[5:]) - 1
for h in HORIZONS:
    R = rows[h]
    mon = np.array([ym(r[1]) for r in R]); chg = np.array([r[2] for r in R]); B = np.array([[r[3], r[4], r[5], r[6]] for r in R]); sid = np.array([r[0] for r in R])
    test_idx = np.where(mon >= ym(TEST_START))[0]
    hit = {"50": [], "80": []}; mult = {"50": [], "80": []}; persid = {}
    cache = {}
    for m in sorted(set(mon[test_idx])):
        win = np.where((mon <= m - h) & (mon > m - h - 120))[0]
        cs = {}
        for lvl, nominal, a, b in (("50", 0.50, 0, 1), ("80", 0.80, 2, 3)):
            lo = B[win, a][:, None] * grid[None, :]; hi = B[win, b][:, None] * grid[None, :]
            ok = ((chg[win][:, None] >= lo) & (chg[win][:, None] <= hi)).mean(axis=0)
            hitg = np.where(ok >= nominal)[0]
            cs[lvl] = float(grid[hitg[0]]) if len(hitg) else float(grid[-1])
        cache[m] = cs
    for i in test_idx:
        cs = cache[mon[i]]
        for lvl, a, b in (("50", 0, 1), ("80", 2, 3)):
            ok = B[i, a] * cs[lvl] <= chg[i] <= B[i, b] * cs[lvl]
            hit[lvl].append(ok); mult[lvl].append(cs[lvl])
            persid.setdefault((int(sid[i]), lvl), []).append(ok)
    res = dict(test_coverage_rolling={k: round(float(np.mean(v)), 3) for k, v in hit.items()},
               multiplier_range={k: [round(min(v), 2), round(max(v), 2), round(float(np.mean(v)), 2)] for k, v in mult.items()}, n_test=len(test_idx))
    res["accepted"] = bool(0.45 <= res["test_coverage_rolling"]["50"] <= 0.55 and 0.75 <= res["test_coverage_rolling"]["80"] <= 0.85)
    res["per_series_test"] = {str(s): dict(name=names[s][:40], c50=round(float(np.mean(persid[(s, "50")])), 2), c80=round(float(np.mean(persid[(s, "80")])), 2)) for s in SERIES}
    out["horizons"][str(h)] = res
    print(f"h={h}: rolling test coverage {res['test_coverage_rolling']}; multiplier min/max/mean {res['multiplier_range']}; accepted={res['accepted']}", flush=True)
    worst = sorted(res["per_series_test"].items(), key=lambda kv: abs(kv[1]["c80"] - 0.8), reverse=True)[:3]
    print("   furthest series on the 80% range:", [(v["name"][:14], v["c80"]) for k, v in worst])
json.dump(out, open(os.path.join(HERE, "ranges_rolling_results.json"), "w", encoding="utf8"), indent=1, ensure_ascii=False)
print("saved ranges_rolling_results.json")
