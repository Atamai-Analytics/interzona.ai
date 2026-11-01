#!/usr/bin/env python3
"""Evaluation suite for the Critical Minerals AI Assistant.

Runs the golden questions in questions.json against a running copy of the app (local dev server or production),
checks each answer deterministically (tools used, numbers against live database truth, forbidden wording, limits)
and, where a rubric is given, with an LLM grader. Writes a JSON and Markdown report and can compare with a previous run.

Usage (from the repo root):
  python evals/run_evals.py --base http://localhost:3000
  python evals/run_evals.py --filter fin- --repeat 3
  python evals/run_evals.py --compare evals/results/<earlier>.json --label after-change

Environment (read from .env.local, never printed): APP_PASSWORD (or EVAL_PASSWORD) for the app, PG* read-only database
settings for ground truth, ANTHROPIC_API_KEY for the grader. Only the read-only database role is used.
"""
import argparse, base64, concurrent.futures as cf, datetime, io, json, os, re, statistics, sys, threading, time, urllib.request

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

ENV = dict(os.environ)
envfile = os.path.join(ROOT, ".env.local")
if os.path.exists(envfile):
    for line in open(envfile, encoding="utf-8"):
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            ENV.setdefault(k.strip(), v.strip().strip('"'))

# ---- Global checks ------------------------------------------------------------------------------------------------------
LEAK_RE = re.compile(
    r"\b(run_sql|search_documents|find_geochemical_anomalies|run_geochem_analysis|run_financial_model|company_financials|peer_comparison|price_history|get_reference_notes|web_search|web_fetch"
    r"|is_active|is_deposit|NEW_LEAD|NEAR_OTHER_OCCURRENCE|NEAR_KNOWN_COMMODITY|source_document_id|line_items|period_type|operating_income|occurrence_id|sample_id|document_id|company_id"
    r"|(?:core|geochem|financials|markets|docs)\.[a-z_]+|sample_chemistry_wide|hybrid_search|rate_per_usd|PRODUCER|PAST_PRODUCER|GREENLAND_GEUS|SEGEMAR_ARGENTINA|USA_USGS_NGDB)\b"
)

NUM_RE = re.compile(r"(?<![\d.,])([-−–]?)\$?\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*(%|trillion|tn|billion|bn|million|mn|thousand|m\b|b\b|k\b)?", re.I)
UNIT = {"trillion": 1e12, "tn": 1e12, "billion": 1e9, "bn": 1e9, "b": 1e9, "million": 1e6, "mn": 1e6, "m": 1e6, "thousand": 1e3, "k": 1e3}


WORDS = {w: i for i, w in enumerate("zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty".split())}


def numbers_in(text):
    """Candidate magnitudes found in the reply: each match yields exact value plus, for bare numbers, thousand/million/billion scalings."""
    out = [(float(WORDS[w.lower()]), False) for w in re.findall(r"\b(" + "|".join(sorted(WORDS, key=len, reverse=True)) + r")\b", text, re.I)]
    for sign, whole, frac, unit in NUM_RE.findall(text):
        v = float(whole.replace(",", "") + ("." + frac if frac else ""))
        if sign:
            v = -v
        u = (unit or "").lower()
        if u == "%":
            out.append((v, False))
        elif u in UNIT:
            out.append((v * UNIT[u], False))
        else:
            out.append((v, True))
    return out


def number_matches(text, truth, tol=0.01, tol_abs=None, use_abs=False, bare=False, percent=False):
    cands = []
    for v, scalable in numbers_in(text):
        cands.append(v)
        if scalable and not bare and not percent:
            cands += [v * 1e3, v * 1e6, v * 1e9]
    for c in cands:
        a, b = (abs(c), abs(truth)) if use_abs else (c, truth)
        if tol_abs is not None:
            if abs(a - b) <= tol_abs:
                return True
        elif abs(a - b) <= tol * max(abs(b), 1e-12):
            return True
    return False


# ---- Database truth -----------------------------------------------------------------------------------------------------
_conn = None
_conn_lock = threading.Lock()


def truth_values(sql):
    global _conn
    import psycopg2
    with _conn_lock:
        for attempt in range(3):
            try:
                if _conn is None or _conn.closed:
                    _conn = psycopg2.connect(host=ENV["PGHOST"], port=ENV.get("PGPORT", 5432), dbname=ENV["PGDATABASE"], user=ENV["PGUSER"], password=ENV["PGPASSWORD"], connect_timeout=30, sslmode="require")
                    _conn.autocommit = True
                cur = _conn.cursor()
                cur.execute(sql)
                rows = [r[0] for r in cur.fetchall()]
                return [float(r) if isinstance(r, (int, float)) or hasattr(r, "as_tuple") else r for r in rows if r is not None]
            except Exception as e:
                try:
                    _conn.close()
                except Exception:
                    pass
                _conn = None
                if attempt == 2:
                    raise
                time.sleep(2)


# ---- Talking to the app -------------------------------------------------------------------------------------------------
def ask(base, password, messages, timeout=420):
    auth = base64.b64encode(("u:" + password).encode()).decode()
    req = urllib.request.Request(base + "/api/chat", data=json.dumps({"messages": messages}).encode(), headers={"Content-Type": "application/json", "Authorization": "Basic " + auth, **({"x-guard-bypass": ENV["GUARD_BYPASS_TOKEN"]} if ENV.get("GUARD_BYPASS_TOKEN") else {})})
    t0 = time.time()
    turn, reply = "", ""
    r = {"steps": [], "evidence": [], "datasets": [], "maps": [], "images": 0, "usage": {}, "errors": [], "notice": None}
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        for raw in resp:
            line = raw.decode("utf-8").strip()
            if not line:
                continue
            ev = json.loads(line)
            t = ev["type"]
            if t == "text":
                turn += ev["delta"]
            elif t == "turn_end":
                if ev["final"]:
                    reply = turn
                turn = ""
            elif t == "step_start":
                r["steps"].append(ev["label"])
            elif t == "evidence":
                r["evidence"] += ev["items"]
            elif t == "dataset":
                r["datasets"].append({"title": ev["dataset"]["title"], "rows": len(ev["dataset"]["rows"]), "chart": bool(ev["dataset"].get("chart"))})
            elif t == "map":
                r["maps"].append({"title": ev["map"]["title"], "points": len(ev["map"]["points"])})
            elif t == "image":
                r["images"] += 1
            elif t == "usage":
                r["usage"] = ev
            elif t == "notice":
                r["notice"] = ev["message"]
            elif t == "error":
                r["errors"].append(ev["message"])
    r["reply"] = reply
    r["seconds"] = round(time.time() - t0, 1)
    return r


def run_conversation(base, password, q):
    turns = q.get("turns") or [q["q"]]
    history, agg = [], None
    for u in turns:
        history.append({"role": "user", "content": u})
        r = ask(base, password, history)
        history.append({"role": "assistant", "content": r["reply"] or "(no answer)"})
        if agg is None:
            agg = r
            agg["tools"] = set(r["usage"].get("tools", []))
        else:
            agg["reply"] = r["reply"]  # judge the last answer; earlier turns still count for tools/usage
            agg["steps"] += r["steps"]
            agg["evidence"] += r["evidence"]
            agg["datasets"] += r["datasets"]
            agg["maps"] += r["maps"]
            agg["images"] += r["images"]
            agg["errors"] += r["errors"]
            agg["seconds"] = round(agg["seconds"] + r["seconds"], 1)
            for k in ("turns", "input", "cache_read", "cache_write", "output", "ms"):
                agg["usage"][k] = agg["usage"].get(k, 0) + r["usage"].get(k, 0)
            agg["tools"] |= set(r["usage"].get("tools", []))
    agg["tools"] = sorted(agg["tools"])
    u = agg["usage"]
    agg["cost_eq"] = round(u.get("input", 0) + 0.1 * u.get("cache_read", 0) + 1.25 * u.get("cache_write", 0) + 5 * u.get("output", 0))
    return agg


# ---- Grader -------------------------------------------------------------------------------------------------------------
def judge(model, q, r, truths):
    key = ENV.get("ANTHROPIC_API_KEY")
    if not key:
        return None, "no ANTHROPIC_API_KEY"
    turns = q.get("turns") or [q["q"]]
    prompt = (
        "You are a strict grader for a mining-industry research assistant. Grade the ANSWER against the RUBRIC. "
        "Use the GROUND TRUTH values (from the database) when given. Be literal: a pass requires every element of the rubric. "
        "Reply with ONLY a JSON object: {\"pass\": true|false, \"reason\": \"one short sentence\"}.\n\n"
        f"QUESTION(S): {json.dumps(turns)}\n\nRUBRIC: {q['judge']}\n\nGROUND TRUTH: {json.dumps(truths, default=str)[:1500]}\n\n"
        f"TOOLS USED: {r['tools']}\n\nANSWER:\n{r['reply'][:9000]}"
    )
    body = json.dumps({"model": model, "max_tokens": 300, "messages": [{"role": "user", "content": prompt}]}).encode()
    req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=body, headers={"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                d = json.loads(resp.read())
            text = "".join(b.get("text", "") for b in d.get("content", []) if b.get("type") == "text")
            m = re.search(r"\{.*\}", text, re.S)
            j = json.loads(m.group(0))
            return bool(j.get("pass")), str(j.get("reason", ""))
        except Exception as e:
            err = str(e)[:120]
            time.sleep(3 * (attempt + 1))
    return None, "grader error: " + err


# ---- Scoring one run ----------------------------------------------------------------------------------------------------
def score(q, r, truths, args):
    checks = []  # (name, ok, detail, soft)

    def add(name, ok, detail="", soft=False):
        checks.append({"name": name, "ok": bool(ok), "detail": detail, "soft": soft})

    reply = r["reply"]
    add("answered", bool(reply.strip()) and not r["errors"], "; ".join(r["errors"]) or ("" if reply.strip() else "empty reply"))
    if not q.get("allow_internal"):
        leaks = sorted({m.group(0) for m in LEAK_RE.finditer(reply)})
        add("plain language", not leaks, ", ".join(leaks))
    e = q.get("expect", {})
    tools = set(r["tools"])
    if e.get("tools_any"):
        add("uses expected tool", bool(tools & set(e["tools_any"])), f"used {sorted(tools)}; wanted one of {e['tools_any']}")
    for t in e.get("tools_all", []):
        add(f"uses {t}", t in tools, f"used {sorted(tools)}")
    for t in e.get("tools_none", []):
        add(f"does not use {t}", t not in tools, f"used {sorted(tools)}")
    for pat in e.get("contains_all", []):
        add(f"mentions {pat}", re.search(pat, reply, re.I) is not None)
    if e.get("contains_any"):
        add("mentions one of " + "/".join(e["contains_any"]), any(re.search(p, reply, re.I) for p in e["contains_any"]))
    for pat in e.get("not_contains", []):
        add(f"does not contain {pat}", re.search(pat, reply, re.I) is None)
    for n in e.get("numbers", []):
        vals = truths.get(n["truth"], [])
        ok = any(number_matches(reply, v, n.get("tol", 0.01), n.get("tol_abs"), n.get("abs", False), n.get("bare", False), n.get("percent", False)) for v in vals if isinstance(v, float))
        add(f"number matches {n['truth']}", ok, f"expected ~{', '.join(f'{v:,.4g}' if isinstance(v, float) else str(v) for v in vals)}")
    if e.get("datasets_min") is not None:
        add("data download offered", len(r["datasets"]) >= e["datasets_min"], f"{len(r['datasets'])} datasets")
    if e.get("maps_min") is not None:
        add("map shown", len(r.get("maps", [])) >= e["maps_min"], f"{len(r.get('maps', []))} maps")
    if e.get("maps_max") is not None:
        add("no map for a non-geographic question", len(r.get("maps", [])) <= e["maps_max"], f"{len(r.get('maps', []))} maps")
    if e.get("images_min") is not None:
        add("chart image produced", r["images"] >= e["images_min"], f"{r['images']} images")
    if e.get("evidence_docs_min") is not None:
        n = len([x for x in r["evidence"] if x.get("kind") == "document"])
        add("cites documents", n >= e["evidence_docs_min"], f"{n} documents")
    if e.get("evidence_web_min") is not None:
        n = len([x for x in r["evidence"] if x.get("kind") == "web"])
        add("cites web pages", n >= e["evidence_web_min"], f"{n} pages")
    if e.get("max_turns"):
        add(f"within {e['max_turns']} model steps", r["usage"].get("turns", 99) <= e["max_turns"], f"{r['usage'].get('turns')} steps", soft=True)
    add("within 90 s", r["seconds"] <= 90, f"{r['seconds']} s", soft=True)
    if q.get("judge") and not args.no_judge:
        ok, reason = judge(args.judge_model, q, r, truths)
        add("grader", ok if ok is not None else True, reason if ok is not None else reason + " (not counted)", soft=ok is None)
    passed = all(c["ok"] for c in checks if not c["soft"])
    return checks, passed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:3000")
    ap.add_argument("--filter", default="", help="substring of id or category (comma separated)")
    ap.add_argument("--concurrency", type=int, default=3)
    ap.add_argument("--repeat", type=int, default=1)
    ap.add_argument("--judge-model", default="claude-sonnet-5-5")
    ap.add_argument("--no-judge", action="store_true")
    ap.add_argument("--label", default="run")
    ap.add_argument("--compare", default="")
    ap.add_argument("--check-truths", action="store_true", help="only evaluate the ground-truth queries and print them")
    ap.add_argument("--min-pass", type=float, default=0.0, help="exit 1 if the pass rate is below this fraction")
    args = ap.parse_args()

    password = ENV.get("EVAL_PASSWORD") or ENV.get("APP_PASSWORD")
    if not password:
        sys.exit("No APP_PASSWORD / EVAL_PASSWORD available.")
    qs = json.load(open(os.path.join(HERE, "questions.json"), encoding="utf-8"))["questions"]
    if args.filter:
        fs = [f.strip() for f in args.filter.split(",") if f.strip()]
        qs = [q for q in qs if any(f in q["id"] or f == q["cat"] for f in fs)]
    if args.check_truths:
        for q in qs:
            for k, sql in q.get("truth", {}).items():
                try:
                    print(f"{q['id']:26s} {k:8s} {truth_values(sql)}")
                except Exception as ex:
                    print(f"{q['id']:26s} {k:8s} ERROR {str(ex)[:150]}")
        return
    print(f"{len(qs)} questions x {args.repeat} against {args.base}", flush=True)

    def work(job):
        q, rep = job
        try:
            truths = {k: truth_values(sql) for k, sql in q.get("truth", {}).items()}
            r = run_conversation(args.base, password, q)
            checks, passed = score(q, r, truths, args)
            res = {"id": q["id"], "cat": q["cat"], "rep": rep, "passed": passed, "checks": checks, "seconds": r["seconds"], "turns": r["usage"].get("turns"), "cost_eq": r["cost_eq"], "tools": r["tools"], "models": r["usage"].get("models", []), "reply": r["reply"], "truth": truths}
        except Exception as ex:
            res = {"id": q["id"], "cat": q["cat"], "rep": rep, "models": [], "passed": False, "checks": [{"name": "run", "ok": False, "detail": str(ex)[:200], "soft": False}], "seconds": 0, "turns": None, "cost_eq": 0, "tools": [], "reply": "", "truth": {}}
        mark = "PASS" if res["passed"] else "FAIL"
        print(f"[{mark}] {q['id']} ({res['seconds']}s, {res['turns']} steps, {','.join(m.replace('claude-','') for m in res['models'])})", flush=True)
        for c in res["checks"]:
            if not c["ok"] and not c["soft"]:
                print(f"        x {c['name']}: {c['detail']}", flush=True)
        return res

    jobs = [(q, i) for q in qs for i in range(args.repeat)]
    with cf.ThreadPoolExecutor(max_workers=args.concurrency) as ex:
        results = list(ex.map(work, jobs))

    # ---- Summary ------------------------------------------------------------------------------------------------------
    by_q = {}
    for r in results:
        by_q.setdefault(r["id"], []).append(r)
    cats = {}
    for qid, rs in by_q.items():
        c = cats.setdefault(rs[0]["cat"], [0, 0])
        c[1] += 1
        c[0] += all(x["passed"] for x in rs)
    total = sum(v[0] for v in cats.values())
    n = sum(v[1] for v in cats.values())
    secs = [r["seconds"] for r in results if r["seconds"]]
    costs = [r["cost_eq"] for r in results if r["cost_eq"]]
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    outdir = os.path.join(HERE, "results")
    os.makedirs(outdir, exist_ok=True)
    jpath = os.path.join(outdir, f"{stamp}-{args.label}.json")
    json.dump({"label": args.label, "base": args.base, "time": stamp, "pass": total, "total": n, "results": results}, open(jpath, "w", encoding="utf-8"), indent=1, default=str)

    lines = [f"# Eval report: {args.label} ({stamp})", "", f"Passed **{total}/{n}** ({100 * total / max(n, 1):.0f}%) against {args.base}.", ""]
    lines.append("| Category | Passed |\n|---|---|")
    for c, (a, b) in sorted(cats.items()):
        lines.append(f"| {c} | {a}/{b} |")
    if secs:
        lines += ["", f"Latency: median {statistics.median(secs):.0f} s, mean {statistics.mean(secs):.0f} s, max {max(secs):.0f} s. Cost proxy (input-equivalent tokens): mean {statistics.mean(costs):,.0f}, total {sum(costs):,.0f}."]
    small = [r for r in results if any("haiku" in m for m in r.get("models", []))]
    if small:
        big = [r for r in results if r not in small]
        lines += ["", f"Routing: {len(small)} of {len(results)} runs used the small model (mean {statistics.mean(r['cost_eq'] for r in small):,.0f} tokens, {statistics.mean(r['seconds'] for r in small):.1f} s); the other {len(big)} used the main model (mean {statistics.mean(r['cost_eq'] for r in big):,.0f} tokens, {statistics.mean(r['seconds'] for r in big):.1f} s). Small-model questions: " + ", ".join(sorted({r['id'] for r in small}))]
    lines += ["", "## Failures", ""]
    for qid, rs in by_q.items():
        bad = [x for x in rs if not x["passed"]]
        if not bad:
            continue
        lines.append(f"### {qid} ({len(bad)}/{len(rs)} runs failed)")
        for c in bad[0]["checks"]:
            if not c["ok"] and not c["soft"]:
                lines.append(f"- {c['name']}: {c['detail']}")
        lines.append(f"- answer excerpt: {bad[0]['reply'][:500].replace(chr(10), ' ')}")
        lines.append("")
    warns = [(r["id"], c["name"], c["detail"]) for r in results for c in r["checks"] if not c["ok"] and c["soft"]]
    if warns:
        lines += ["## Warnings (soft limits)", ""] + [f"- {a}: {b} ({c})" for a, b, c in warns]

    if args.compare and os.path.exists(args.compare):
        prev = json.load(open(args.compare, encoding="utf-8"))
        pm = {}
        for r in prev["results"]:
            pm.setdefault(r["id"], []).append(r["passed"])
        reg = [qid for qid, rs in by_q.items() if qid in pm and all(pm[qid]) and not all(x["passed"] for x in rs)]
        fix = [qid for qid, rs in by_q.items() if qid in pm and not all(pm[qid]) and all(x["passed"] for x in rs)]
        lines += ["", f"## Compared with {os.path.basename(args.compare)} ({prev['pass']}/{prev['total']})", "", f"- Regressions: {', '.join(reg) or 'none'}", f"- Fixed: {', '.join(fix) or 'none'}"]
    mpath = jpath.replace(".json", ".md")
    open(mpath, "w", encoding="utf-8").write("\n".join(lines))
    print("\n" + "\n".join(lines[:14]))
    print(f"\nReport: {mpath}\nData:   {jpath}")
    if total / max(n, 1) < args.min_pass:
        sys.exit(1)


if __name__ == "__main__":
    main()
