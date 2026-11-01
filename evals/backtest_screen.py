"""Back-test of the geochemical anomaly screen against catalogued deposits.

Question: do the cells the screen flags sit near catalogued occurrences of the same commodity more often than comparable cells it does not flag?

How it works (read-only; the screen's own rules are copied from src/lib/anomalies.ts):
  * per survey and indicator, a sample is anomalous if its indicator is at or above the 95th percentile of its own sample type (types with >= 30 qualifying samples);
  * samples are binned to 0.25 degree cells; a cell is FLAGGED when it holds >= 3 anomalous samples (the screen's rule);
  * a cell is a HIT when a catalogued occurrence of the commodity with a precise position (position_accuracy IS NULL) lies within 15 km of the cell's centre of samples;
  * because anomaly counts rise with how many samples a cell holds (and surveys sampled known deposits harder), flagged cells are compared with UNFLAGGED cells of
    similar sampling density (strata of the number of analysed samples): lift = observed hit rate of flagged cells / hit rate expected for them from unflagged cells in the same strata;
  * the 95% interval comes from a block bootstrap (1 x 1 degree blocks), because neighbouring cells are not independent.
Every pre-listed survey x indicator combination is reported, including the ones that cannot be tested and the ones where the screen does worse than chance.

What it does NOT show: that the screen finds deposits nobody knows about. It tests recovery of known systems (known deposits may have been found partly with the same survey data), and the
catalogue's own gaps count against the screen. Usage: python evals/backtest_screen.py [--quick]
"""
import json, os, sys, time, datetime
import numpy as np
import psycopg2

sys.stdout.reconfigure(encoding="utf8")
HERE = os.path.dirname(os.path.abspath(__file__))
ENV = {}
for l in open(os.path.join(HERE, "..", ".env.local"), encoding="utf8"):
    if "=" in l and not l.startswith("#"):
        k, v = l.rstrip("\r\n").split("=", 1); ENV[k] = v.strip('"')

GRID, PCT, MIN_ANOM, NEAR_KM, MIN_CELL, BOOT, SEED = 0.25, 0.95, 3, 15.0, 3, 1000, 20261027
SURVEYS = ["GREENLAND_GEUS", "ARGENTINA_SEGEMAR", "FINLAND_GTK_ROCK", "SWEDEN_SGU_LITHOGEOCHEMISTRY", "USA_USGS_NGDB", "AUSTRALIA_VIC_GSV_GEOCHEMISTRY"]
REE = ["la", "ce", "pr", "nd", "sm", "eu", "gd", "tb", "dy", "ho", "er", "tm", "yb", "lu", "y"]
INDICATORS = {  # name: (elements, required key elements, occurrence commodity pattern)
    "REE": (REE, ["la", "ce", "nd"], "rare earth|^l?h?ree$|^y2o3$|^(la|ce|pr|nd|sm|eu|gd|tb|dy|ho|er|tm|yb|lu|y)$"),
    "Li": (["li"], [], "^li$|lithium"),
    "Cu": (["cu"], [], "^cu$"),
    "Zn": (["zn"], [], "^zn$"),
    "Ni": (["ni"], [], "^ni$"),
    "W": (["w"], [], "^w$"),
    "Sn": (["sn"], [], "^sn$"),
    "Mo": (["mo"], [], "^mo$"),
    "U": (["u"], [], "^u$"),
}
QUICK = "--quick" in sys.argv
if QUICK:
    SURVEYS = ["GREENLAND_GEUS", "ARGENTINA_SEGEMAR"]
    INDICATORS = {k: INDICATORS[k] for k in ("REE", "Li", "Cu")}

def connect():
    global con, cur
    con = psycopg2.connect(host=ENV["PGHOST"], port=ENV.get("PGPORT", 5432), dbname=ENV["PGDATABASE"], user=ENV["PGUSER"], password=ENV["PGPASSWORD"])
    con.set_session(readonly=True, autocommit=True)
    cur = con.cursor()
    cur.execute("SET statement_timeout = 600000")


connect()
cur.execute("SELECT column_name FROM information_schema.columns WHERE table_schema='geochem' AND table_name='sample_chemistry_wide'")
COLS = {r[0] for r in cur.fetchall()}


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def cell_sql(elements, required, survey):
    """Same indicator rules as the screen with basis 'any': value = total-digestion value, else partial-leach value; below detection counts as 0."""
    used = []
    for e in elements:
        c = [x for x in (f"{e}_t", f"{e}_p") if x in COLS]
        if c: used.append(c)
    if not used: return None
    val = " + ".join(f"coalesce({', '.join(c)}, 0)" for c in used)
    analysed = lambda c: " OR ".join(f"{x} IS NOT NULL OR '{x}' = ANY(bdl_codes)" for x in c)
    pres = " + ".join(f"(CASE WHEN {analysed(c)} THEN 1 ELSE 0 END)" for c in used)
    req = [[x for x in (f"{e}_t", f"{e}_p") if x in COLS] for e in required]
    ok = " AND ".join([f"({analysed(c)})" for c in req if c] + [f"({pres}) >= 1"])
    return f"""
WITH s AS (SELECT sample_type_name AS st, lat, lon, ({val}) AS v, ({ok}) AS ok FROM geochem.sample_chemistry_wide WHERE source_system = '{survey}' AND lat IS NOT NULL AND lon IS NOT NULL),
p AS (SELECT st, count(*) FILTER (WHERE ok) AS n_ok, percentile_cont({PCT}) WITHIN GROUP (ORDER BY v) FILTER (WHERE ok) AS thr FROM s GROUP BY st),
a AS (SELECT s.*, (s.v >= p.thr AND s.v > 0) AS anom FROM s JOIN p USING (st) WHERE s.ok AND p.n_ok >= 30),
cells AS (SELECT round(lat / {GRID}) * {GRID} AS lat_c, round(lon / {GRID}) * {GRID} AS lon_c, count(*) AS n, count(*) FILTER (WHERE anom) AS n_anom,
                 avg(lat) AS clat, avg(lon) AS clon, coalesce(max(v) FILTER (WHERE anom), 0) AS mx FROM a GROUP BY 1, 2 HAVING count(*) >= {MIN_CELL})
SELECT lat_c, lon_c, n, n_anom, clat, clon, mx FROM cells"""


def nearest_km(points, pattern, precise_only):
    """Distance (km) from each point to the nearest catalogued occurrence of the commodity (precise positions only, or any except UNRELIABLE)."""
    acc = "o.position_accuracy IS NULL" if precise_only else "o.position_accuracy IS DISTINCT FROM 'UNRELIABLE'"
    if len(points) > 4000:  # a very long VALUES list can crash the database session, so large surveys are measured in batches
        kms, n_occ = [], 0
        for a in range(0, len(points), 4000):
            k, n_occ = nearest_km(points[a:a + 4000], pattern, precise_only)
            kms.append(k)
        return np.concatenate(kms), n_occ
    vals = ",".join(f"({i},{float(la):.6f},{float(lo):.6f})" for i, (la, lo) in enumerate(points))
    cur.execute(f"""
WITH pts(i, lat, lon) AS (VALUES {vals}),
co AS MATERIALIZED (SELECT o.geog FROM core.occurrences o WHERE o.is_active AND {acc} AND EXISTS (SELECT 1 FROM unnest(o.commodities) k WHERE k ~* %s))
SELECT t.i, d.km, (SELECT count(*) FROM co) FROM pts t
LEFT JOIN LATERAL (SELECT ST_Distance(co.geog, ST_SetSRID(ST_MakePoint(t.lon, t.lat), 4326)::geography) / 1000 AS km FROM co
                   ORDER BY co.geog <-> ST_SetSRID(ST_MakePoint(t.lon, t.lat), 4326)::geography LIMIT 1) d ON true ORDER BY t.i""", (pattern,))
    rows = cur.fetchall()
    km = np.array([np.nan if r[1] is None else float(r[1]) for r in rows])
    return km, (int(rows[0][2]) if rows else 0)


def lift_stats(n, flagged, hit, strata_edges):
    """Observed hit rate of flagged cells, the rate expected for them from unflagged cells of similar sampling density, and their ratio."""
    k = np.digitize(n, strata_edges)
    obs = hit[flagged].mean() if flagged.any() else np.nan
    num = 0.0; den = 0
    for s in np.unique(k[flagged]):
        f = flagged & (k == s); u = (~flagged) & (k == s)
        if u.sum() < 5: continue
        num += f.sum() * hit[u].mean(); den += f.sum()
    exp = num / den if den else np.nan
    crude = hit[~flagged].mean() if (~flagged).any() else np.nan
    return obs, exp, crude


def run_case(survey, name, spec):
    elements, required, pattern = spec
    sql = cell_sql(elements, required, survey)
    if sql is None: return dict(survey=survey, indicator=name, status="no element columns in the table")
    cur.execute(sql)
    rows = cur.fetchall()
    if not rows: return dict(survey=survey, indicator=name, status="no cells with enough qualifying samples")
    arr = np.array(rows, dtype=float)
    n, n_anom, clat, clon, mx = arr[:, 2], arr[:, 3], arr[:, 4], arr[:, 5], arr[:, 6]
    km, n_occ = nearest_km(list(zip(clat, clon)), pattern, True)
    km_all, n_occ_all = nearest_km(list(zip(clat, clon)), pattern, False)
    flagged = n_anom >= MIN_ANOM
    res = dict(survey=survey, indicator=name, cells=int(len(n)), flagged_cells=int(flagged.sum()), precise_occurrences_of_commodity=n_occ, occurrences_any_accuracy=n_occ_all)
    hit = (km <= NEAR_KM) & ~np.isnan(km)
    res["cells_with_hit"] = int(hit.sum())
    if flagged.sum() < 8: return {**res, "status": "not tested: fewer than 8 flagged cells"}
    if hit.sum() < 5: return {**res, "status": "not tested: fewer than 5 sampled cells near a catalogued occurrence of the commodity"}
    if (~flagged).sum() < 20: return {**res, "status": "not tested: fewer than 20 unflagged cells"}
    edges = np.unique(np.quantile(n, [0.25, 0.5, 0.75]))
    obs, exp, crude = lift_stats(n, flagged, hit, edges)
    if not exp or np.isnan(exp) or exp == 0: return {**res, "status": "not tested: no unflagged cells of similar density near an occurrence (expected rate is zero)"}
    lift = obs / exp
    # block bootstrap over 1 x 1 degree blocks
    blk = (np.floor(clat).astype(int) * 1000 + np.floor(clon).astype(int))
    ub = np.unique(blk); idx = {b: np.where(blk == b)[0] for b in ub}
    rng = np.random.default_rng(SEED); lifts = []
    for _ in range(BOOT):
        pick = np.concatenate([idx[b] for b in rng.choice(ub, size=len(ub), replace=True)])
        o, e, _c = lift_stats(n[pick], flagged[pick], hit[pick], edges)
        if e and not np.isnan(e) and e > 0 and not np.isnan(o): lifts.append(o / e)
    lo, hi = (np.percentile(lifts, 2.5), np.percentile(lifts, 97.5)) if len(lifts) > 200 else (np.nan, np.nan)
    p_le_1 = float(np.mean(np.array(lifts) <= 1)) if lifts else np.nan
    # top-N cells by anomaly count (ties by highest value), against the rate expected for cells of their density
    order = np.lexsort((-mx, -n_anom)); order = [i for i in order if flagged[i]]
    kk = np.digitize(n, edges); rate = {s: hit[(~flagged) & (kk == s)].mean() for s in np.unique(kk) if ((~flagged) & (kk == s)).sum() >= 5}
    top = {}
    for N in (10, 20):
        sel = order[:N]
        if len(sel) < N: continue
        e = np.mean([rate.get(kk[i], np.nan) for i in sel])
        top[f"top{N}"] = dict(hit_rate=float(hit[sel].mean()), expected=float(e) if not np.isnan(e) else None, lift=float(hit[sel].mean() / e) if e and not np.isnan(e) else None)
    # sensitivity: any non-UNRELIABLE position and 25 km
    hit_all = (km_all <= NEAR_KM) & ~np.isnan(km_all); o2, e2, _ = lift_stats(n, flagged, hit_all, edges)
    hit25 = (km <= 25) & ~np.isnan(km); o3, e3, _ = lift_stats(n, flagged, hit25, edges)
    return {**res, "status": "tested", "hit_rate_flagged": float(obs), "hit_rate_unflagged": float(crude), "hit_rate_expected_for_flagged": float(exp), "lift": float(lift),
            "lift_ci95": [None if np.isnan(lo) else float(lo), None if np.isnan(hi) else float(hi)], "p_lift_le_1": p_le_1, "strata_edges": [float(x) for x in edges], "top_n": top,
            "sensitivity": {"any_accuracy_lift": float(o2 / e2) if e2 else None, "radius_25km_lift": float(o3 / e3) if e3 else None},
            "flagged_hits": int(hit[flagged].sum())}


results = []
t0 = time.time()
PARTIAL = os.path.join(HERE, "backtest", "partial_quick.json" if QUICK else "partial.json")
os.makedirs(os.path.dirname(PARTIAL), exist_ok=True)
if os.path.exists(PARTIAL):  # resume after an interruption: finished combinations are kept
    results = [r for r in json.load(open(PARTIAL, encoding="utf8")) if not str(r.get("status", "")).startswith("error")]  # errored combinations are tried again
    log("resuming with", len(results), "finished combinations")
done = {(r["survey"], r["indicator"]) for r in results}
for sv in SURVEYS:
    for name, spec in INDICATORS.items():
        if (sv, name) in done: continue
        try:
            r = run_case(sv, name, spec)
        except Exception as e:
            r = dict(survey=sv, indicator=name, status="error: " + str(e)[:120])
            try: connect()  # the session may have been dropped
            except Exception: time.sleep(30); connect()
        results.append(r)
        json.dump(results, open(PARTIAL, "w", encoding="utf8"))
        extra = f"lift {r['lift']:.2f} [{r['lift_ci95'][0]:.2f}, {r['lift_ci95'][1]:.2f}] flagged {r['flagged_cells']} hit rate {r['hit_rate_flagged']:.2f} vs expected {r['hit_rate_expected_for_flagged']:.2f}" if r.get("status") == "tested" and r["lift_ci95"][0] is not None else ""
        log(f"{sv:32} {name:4} {r['status'][:70]} {extra}")

tested = [r for r in results if r.get("status") == "tested" and r["lift_ci95"][0] is not None]
summary = dict(
    run_date=datetime.date.today().isoformat(), grid_deg=GRID, percentile=PCT, min_anomalous=MIN_ANOM, near_km=NEAR_KM, bootstrap=BOOT,
    combinations=len(results), tested=len(tested),
    better_than_chance=sum(1 for r in tested if r["lift_ci95"][0] > 1), no_clear_difference=sum(1 for r in tested if r["lift_ci95"][0] <= 1 <= r["lift_ci95"][1]), worse_than_chance=sum(1 for r in tested if r["lift_ci95"][1] < 1),
    median_lift=float(np.median([r["lift"] for r in tested])) if tested else None, seconds=round(time.time() - t0))
out = os.path.join(HERE, "backtest"); os.makedirs(out, exist_ok=True)
fn = os.path.join(out, f"screen_backtest_{summary['run_date']}{'_quick' if QUICK else ''}.json")
json.dump(dict(summary=summary, results=results), open(fn, "w", encoding="utf8"), indent=2)
print(json.dumps(summary, indent=2)); print("saved", fn)
