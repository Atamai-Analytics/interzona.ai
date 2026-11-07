"""Back-test of Athabasca uranium halo indicators in sandstone drill core (GSC Open File 7792, source CANADA_ATHABASCA_OF7792).

Question: are drill holes whose SANDSTONE samples show the strongest halo signal closer to a known uranium deposit than comparable holes?
Rules fixed before running (2026-11-06) - do not change them after seeing results; add new variants as clearly separate, labelled tests:
  * unit = drill hole (collar position) with Athabasca core samples whose lithology is 'Sandstone' (the halo above the unconformity; basement
    samples are left out because they include the ore and its host)
  * indicators, per hole, over its sandstone samples (a hole needs >= 3 sandstone samples with that indicator):
      RPB  max 206Pb/204Pb   (radiogenic lead; partial-digest isotopes, else total; samples with Pb204 below detection or 0 left out)
      LPB  min 207Pb/206Pb   (low = radiogenic; same samples)
      B    max boron         (total / fusion value, else partial)
      U    max uranium       (partial digest, ppm)
  * flagged = the top 10 % of holes by the indicator (bottom 10 % for LPB)
  * target = a catalogued Saskatchewan / Alberta uranium occurrence with a precise position and status PROSPECT, EXPLORATION, FEASIBILITY,
    DEVELOPMENT, PRODUCER or PAST_PRODUCER, excluding occurrences named after drill holes ('Drill hole(s) ...'), which would be circular
  * hit = a target within 1 km of the collar (sensitivity: 500 m and 2 km)
  * because a hole with more samples has a higher maximum by chance, flagged holes are compared with UNFLAGGED holes having a similar number of
    samples (quartile strata of the per-indicator sample count): lift = observed hit rate of flagged holes / hit rate expected for them from
    unflagged holes in the same strata
  * 95 % interval from a block bootstrap over 0.25 x 0.25 degree blocks (neighbouring holes are not independent), 2000 resamples
What it does NOT show: that the indicators find undiscovered deposits. Exploration drilling clusters around known deposits (so expected hit
rates are high), the deposits were partly found with this kind of data, and the halo can include ore-bearing sandstone itself.
Read-only. Usage: python evals/backtest_athabasca.py   -> evals/backtest/athabasca_backtest_<date>.json
"""
import json, os, sys, datetime
import numpy as np
import psycopg2

sys.stdout.reconfigure(encoding="utf8")
HERE = os.path.dirname(os.path.abspath(__file__))
ENV = {}
for l in open(os.path.join(HERE, "..", ".env.local"), encoding="utf8"):
    if "=" in l and not l.startswith("#"):
        k, v = l.rstrip("\r\n").split("=", 1); ENV[k] = v.strip('"')
TOP, BLOCK, BOOT, SEED, MIN_N = 0.10, 0.25, 2000, 20261106, 3
DISTS = [500, 1000, 2000]
con = psycopg2.connect(host=ENV["PGHOST"], port=ENV.get("PGPORT", 5432), dbname=ENV["PGDATABASE"], user=ENV["PGUSER"], password=ENV["PGPASSWORD"])
con.set_session(readonly=True, autocommit=True)
cur = con.cursor()
cur.execute("SET statement_timeout = 300000")

cur.execute("""
WITH s AS (
  SELECT s.drillhole_id,
    CASE WHEN w.pb204_p > 0 AND w.pb206_p > 0 AND NOT ('pb204_p' = ANY(coalesce(w.bdl_codes, '{}'))) THEN w.pb206_p / w.pb204_p
         WHEN w.pb204_t > 0 AND w.pb206_t > 0 AND NOT ('pb204_t' = ANY(coalesce(w.bdl_codes, '{}'))) THEN w.pb206_t / w.pb204_t END AS r64,
    CASE WHEN w.pb204_p > 0 AND w.pb206_p > 0 AND w.pb207_p > 0 AND NOT ('pb204_p' = ANY(coalesce(w.bdl_codes, '{}'))) THEN w.pb207_p / w.pb206_p
         WHEN w.pb204_t > 0 AND w.pb206_t > 0 AND w.pb207_t > 0 AND NOT ('pb204_t' = ANY(coalesce(w.bdl_codes, '{}'))) THEN w.pb207_t / w.pb206_t END AS r76,
    coalesce(w.b_t, w.b_p) AS b, w.u_p AS u
  FROM geochem.samples s JOIN geochem.sample_chemistry_wide w USING (sample_id)
  WHERE s.source_system = 'CANADA_ATHABASCA_OF7792' AND s.drillhole_id IS NOT NULL AND s.sample_type_local LIKE 'OF7792: drill core - Sandstone%'),
h AS (
  SELECT drillhole_id, max(r64) rpb, count(r64) n_rpb, min(r76) lpb, count(r76) n_lpb, max(b) b, count(b) n_b, max(u) u, count(u) n_u
  FROM s GROUP BY 1),
t AS (
  SELECT o.geom FROM core.occurrences o
  WHERE o.is_active AND o.position_accuracy IS NULL AND o.status IN ('PROSPECT','EXPLORATION','FEASIBILITY','DEVELOPMENT','PRODUCER','PAST_PRODUCER')
    AND o.name !~* '^drill ?holes? ' AND EXISTS (SELECT 1 FROM unnest(o.commodities) k WHERE k ~* '^u$|uranium|u3o8')
    AND ST_Intersects(o.geom, ST_MakeEnvelope(-112, 56.5, -101.5, 60.5, 4326)))
SELECT h.*, ST_X(d.geom), ST_Y(d.geom),
  (SELECT min(ST_Distance(d.geog, t.geom::geography)) FROM t WHERE ST_DWithin(d.geog, t.geom::geography, 5000)) AS dist_m
FROM h JOIN drilling.drillholes d USING (drillhole_id)""")
cols = [c[0] for c in cur.description]
rows = [dict(zip(cols, r)) for r in cur.fetchall()]
cur.execute("""SELECT count(*) FROM core.occurrences o WHERE o.is_active AND o.position_accuracy IS NULL
  AND o.status IN ('PROSPECT','EXPLORATION','FEASIBILITY','DEVELOPMENT','PRODUCER','PAST_PRODUCER') AND o.name !~* '^drill ?holes? '
  AND EXISTS (SELECT 1 FROM unnest(o.commodities) k WHERE k ~* '^u$|uranium|u3o8') AND ST_Intersects(o.geom, ST_MakeEnvelope(-112, 56.5, -101.5, 60.5, 4326))""")
n_targets = cur.fetchone()[0]
print(f"holes with sandstone samples: {len(rows)}; target deposits: {n_targets}", flush=True)
rng = np.random.default_rng(SEED)


def test(ind, ncol, low_is_signal, dist):
    hs = [r for r in rows if r[ind] is not None and (r[ncol] or 0) >= MIN_N]
    if len(hs) < 40:
        return {"indicator": ind, "dist_m": dist, "status": f"not tested: only {len(hs)} holes with >= {MIN_N} samples"}
    v = np.array([float(r[ind]) for r in hs]); n = np.array([r[ncol] for r in hs])
    hit = np.array([r["dist_m"] is not None and r["dist_m"] <= dist for r in hs])
    cut = np.quantile(v, TOP) if low_is_signal else np.quantile(v, 1 - TOP)
    flag = v <= cut if low_is_signal else v >= cut
    edges = np.unique(np.quantile(n, [0, .25, .5, .75, 1]))
    strat = np.clip(np.searchsorted(edges, n, side="right") - 1, 0, max(len(edges) - 2, 0))
    blk = np.array([f"{int(np.floor(r['st_x'] / BLOCK))}:{int(np.floor(r['st_y'] / BLOCK))}" for r in hs])

    def lift(idx):
        f, h, s = flag[idx], hit[idx], strat[idx]
        if f.sum() == 0: return None, None, None
        exp = 0.0
        for k in np.unique(s[f]):
            u = (~f) & (s == k)
            if u.sum() == 0: return None, None, None
            exp += (f & (s == k)).sum() * h[u].mean()
        obs = h[f].sum()
        return (obs / exp if exp > 0 else None), obs / f.sum(), exp / f.sum()
    L, obs_rate, exp_rate = lift(np.arange(len(hs)))
    ub = np.unique(blk); bidx = {b: np.where(blk == b)[0] for b in ub}; boots = []
    for _ in range(BOOT):
        pick = rng.choice(ub, size=len(ub), replace=True)
        idx = np.concatenate([bidx[b] for b in pick]); x = lift(idx)[0]
        if x is not None: boots.append(x)
    lo, hi = (np.quantile(boots, [0.025, 0.975]) if boots else (None, None))
    verdict = "better than chance" if lo is not None and lo > 1 else "worse than chance" if hi is not None and hi < 1 else "no clear difference"
    return {"indicator": ind, "dist_m": dist, "status": "tested", "holes": len(hs), "flagged": int(flag.sum()), "threshold": round(float(cut), 3),
            "flagged_hits": int(hit[flag].sum()), "hit_rate_flagged": round(float(obs_rate), 3), "hit_rate_expected": round(float(exp_rate), 3),
            "lift": round(float(L), 2) if L else None, "lift_ci95": [round(float(lo), 2), round(float(hi), 2)] if boots else None,
            "verdict": verdict, "blocks": len(ub)}


out = []
for ind, ncol, low in [("rpb", "n_rpb", False), ("lpb", "n_lpb", True), ("b", "n_b", False), ("u", "n_u", False)]:
    for d in DISTS:
        r = test(ind, ncol, low, d); out.append(r)
        print({k: r[k] for k in r if k in ("indicator", "dist_m", "status", "holes", "flagged", "threshold", "hit_rate_flagged", "hit_rate_expected", "lift", "lift_ci95", "verdict")}, flush=True)
fn = os.path.join(HERE, "backtest", f"athabasca_backtest_{datetime.date.today()}.json")
json.dump({"run_date": str(datetime.date.today()), "rules": {"top": TOP, "min_samples": MIN_N, "block_deg": BLOCK, "bootstrap": BOOT, "dists_m": DISTS},
           "holes": len(rows), "targets": n_targets, "results": out}, open(fn, "w", encoding="utf8"), indent=2)
print("saved", fn)
