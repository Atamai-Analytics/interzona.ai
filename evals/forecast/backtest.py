"""Back-test of simple monthly price forecasts against the naive forecast, exactly as fixed in PREREG.md. Read-only on the database.
Usage: python evals/forecast/backtest.py"""
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
MODELS = ["naive", "drift", "ses", "meanrev", "mom", "reg"]
SEL_START, SEL_END, TEST_START = "2005-01", "2015-12", "2016-01"

def load(sid):
    cur.execute("SELECT s.series_name, p.period_start, p.value FROM markets.prices p JOIN markets.price_series s USING(series_id) WHERE s.series_id=%s AND p.value>0 ORDER BY p.period_start", (sid,))
    rows = cur.fetchall()
    name = rows[0][0]
    months = [r[1].strftime("%Y-%m") for r in rows]
    assert len(set(months)) == len(months)
    # require a gap-free monthly sequence from the first observation
    ym = [int(m[:4]) * 12 + int(m[5:]) - 1 for m in months]
    assert all(b - a == 1 for a, b in zip(ym, ym[1:])), f"gap in series {sid}"
    return name, months, np.log(np.array([float(r[2]) for r in rows]))

def ols(X, y):
    beta, *_ = np.linalg.lstsq(X, y, rcond=None)
    return beta

def features(y):
    n = len(y)
    mom = np.full(n, np.nan); mom[12:] = y[12:] - y[:-12]
    m120 = np.full(n, np.nan)
    c = np.cumsum(np.insert(y, 0, 0.0))
    for t in range(119, n): m120[t] = (c[t + 1] - c[t - 119]) / 120
    return mom, y - m120

def ses_forecast(w):
    """level of simple exponential smoothing with the weight (grid) that minimises one-step squared error on w."""
    best = None
    for a in (0.1, 0.3, 0.5, 0.7, 0.9):
        lv, sse = w[0], 0.0
        for v in w[1:]:
            sse += (v - lv) ** 2; lv = a * v + (1 - a) * lv
        if best is None or sse < best[0]: best = (sse, lv)
    return best[1]

def forecasts(y, mom, dev, t, h, ses_cache):
    """log-price forecasts of y[t+h] for every model, using y[:t+1] only."""
    out = {"naive": y[t]}
    d = np.diff(y[max(0, t - 120): t + 1])
    out["drift"] = y[t] + h * (d.mean() if len(d) else 0.0)
    if t not in ses_cache: ses_cache[t] = ses_forecast(y[max(0, t - 239): t + 1])
    out["ses"] = ses_cache[t]
    # direct regressions on pairs whose target month is known at the origin
    lo = max(120, t - h - 359)
    idx = np.arange(lo, t - h + 1)
    idx = idx[~np.isnan(mom[idx]) & ~np.isnan(dev[idx])]
    if len(idx) >= 60:
        tgt = y[idx + h] - y[idx]
        for name, cols in (("meanrev", [dev]), ("mom", [mom]), ("reg", [mom, dev])):
            X = np.column_stack([np.ones(len(idx))] + [c[idx] for c in cols])
            b = ols(X, tgt)
            x_now = np.array([1.0] + [c[t] for c in cols])
            out[name] = y[t] + float(x_now @ b)
    return out

def interval_scale(y, t, h):
    d = np.diff(y)
    hist = (y[h: t + 1] - y[: t + 1 - h])[-240:]
    vol_recent = d[max(0, t - 24): t].std(); vol_long = d[max(0, t - 240): t].std()
    k = min(2.0, max(0.5, vol_recent / vol_long if vol_long > 0 else 1.0))
    q = lambda p: float(np.quantile(hist - hist.mean(), p))
    return {"50": (q(0.25) * k, q(0.75) * k), "80": (q(0.10) * k, q(0.90) * k)}

res = {}   # (sid, h) -> list of dict(month, actual_change, errs per model, inside50, inside80)
names = {}
for sid in SERIES:
    name, months, y = load(sid); names[sid] = name
    mom, dev = features(y)
    ses_cache = {}
    for h in HORIZONS:
        rows = []
        for t in range(len(y) - h):
            m = months[t]
            if m < SEL_START: continue
            f = forecasts(y, mom, dev, t, h, ses_cache)
            actual = y[t + h]
            e = {k: abs(actual - v) for k, v in f.items()}
            iv = interval_scale(y, t, h)
            chg = actual - y[t]
            drift_c = 0.0
            ins = {k: bool(iv[k][0] <= chg <= iv[k][1]) for k in iv}
            rows.append(dict(month=m, err=e, chg=chg, fchg={k: v - y[t] for k, v in f.items()}, ins=ins))
        res[(sid, h)] = rows
    print("done", sid, name[:40], flush=True)

def pooled_mae(rows_by_series, model, lo, hi):
    tot, n = 0.0, 0
    for rows in rows_by_series:
        for r in rows:
            if lo <= r["month"] <= hi and model in r["err"]: tot += r["err"][model]; n += 1
    return tot / n if n else float("nan")

all_months = sorted({r["month"] for rows in res.values() for r in rows})
test_months = [m for m in all_months if m >= TEST_START]
rng = np.random.default_rng(20261027)
out = dict(prereg="evals/forecast/PREREG.md", run=datetime.datetime.now().isoformat(timespec="seconds"), series={str(s): names[s] for s in SERIES}, horizons={})
for h in HORIZONS:
    rbs = [res[(s, h)] for s in SERIES]
    sel = {m: pooled_mae(rbs, m, SEL_START, SEL_END) for m in MODELS}
    chosen = min(sel, key=sel.get)
    test = {m: pooled_mae(rbs, m, TEST_START, "9999") for m in MODELS}
    # moving-block bootstrap over origin dates (same dates for every series)
    by_month = {}
    for rows in rbs:
        for r in rows:
            if r["month"] >= TEST_START and chosen in r["err"]: by_month.setdefault(r["month"], []).append((r["err"][chosen], r["err"]["naive"]))
    ms = sorted(by_month); B = 24; nb = int(np.ceil(len(ms) / B)); skills = []
    for _ in range(2000):
        pick = []
        for _ in range(nb):
            s0 = int(rng.integers(0, max(1, len(ms) - B + 1))); pick += ms[s0: s0 + B]
        em = sum(e for m in pick for e, _ in by_month[m]); en = sum(n for m in pick for _, n in by_month[m])
        skills.append(1 - em / en)
    lo_ci, hi_ci = float(np.quantile(skills, 0.025)), float(np.quantile(skills, 0.975))
    per = {}
    wins = 0
    for s in SERIES:
        rows = [r for r in res[(s, h)] if r["month"] >= TEST_START and chosen in r["err"]]
        em = np.mean([r["err"][chosen] for r in rows]); en = np.mean([r["err"]["naive"] for r in rows])
        per[str(s)] = dict(skill=float(1 - em / en), n=len(rows)); wins += em < en
    skill = 1 - test[chosen] / test["naive"]
    ships = bool(chosen != "naive" and lo_ci > 0 and wins >= 10)
    cover = {}
    for k in ("50", "80"):
        v = [r["ins"][k] for rows in rbs for r in rows if r["month"] >= TEST_START]
        cover[k] = float(np.mean(v))
    # hit rate on direction for the chosen model
    dirs = [np.sign(r["fchg"][chosen]) == np.sign(r["chg"]) for rows in rbs for r in rows if r["month"] >= TEST_START and chosen in r["fchg"] and chosen != "naive"]
    out["horizons"][str(h)] = dict(selection_mae={k: round(v, 5) for k, v in sel.items()}, chosen=chosen, test_mae={k: round(v, 5) for k, v in test.items()},
                                   test_skill_vs_naive={k: round(1 - test[k] / test["naive"], 4) for k in MODELS},
                                   chosen_skill=round(skill, 4), chosen_skill_ci95=[round(lo_ci, 4), round(hi_ci, 4)], series_beating_naive=int(wins), n_series=len(SERIES),
                                   ships_point_forecast=ships, direction_hit_rate=(round(float(np.mean(dirs)), 3) if dirs else None),
                                   interval_coverage_test=cover, per_series=per, test_origins=len(test_months))
    print(f"h={h}: chosen {chosen}; test skill {skill:+.3%} (95% {lo_ci:+.3%} to {hi_ci:+.3%}); beats naive in {wins}/{len(SERIES)}; ships={ships}; coverage50 {cover['50']:.2f} coverage80 {cover['80']:.2f}", flush=True)
json.dump(out, open(os.path.join(HERE, "backtest_results.json"), "w", encoding="utf8"), indent=1, ensure_ascii=False)
print("saved backtest_results.json")
