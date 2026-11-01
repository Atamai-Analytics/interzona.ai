"""Runs the frozen held-out question set against the assistant (live, on the deployed app) and two general-model baselines, and scores all three against the
truth that was written before anyone was asked.

  OURS  : the deployed app answering live (not a saved answer), exactly as it would answer a new question from an investor
  PLAIN : the same model family with no tools or data
  WEB   : the same model with web search
A judge model sees the question, the pre-registered truth (facts, or the expected behaviour), and the three answers in random order without names. For each answer it labels each
pre-registered fact CORRECT / INCORRECT / ABSENT (categories A, B, E) or PASS / FAIL against the expected behaviour (category D), flags invented specifics, and scores overall quality 1-5.

The set is frozen: freeze_questions.py stores a SHA-256 of questions.json and this script stops if the file has changed (use --allow-modified only to see what a change does, and say so).
Usage: python evals/heldout/run_heldout.py [--only SUBSTRING] [--limit N] [--judge-model M] [--base-model M] [--app URL] [--allow-modified]"""
import argparse, base64, hashlib, json, os, random, re, sys, time, urllib.request, urllib.error, datetime
import anthropic

sys.stdout.reconfigure(encoding="utf8")
HERE = os.path.dirname(os.path.abspath(__file__))
ENV = {}
for l in open(os.path.join(HERE, "..", "..", ".env.local"), encoding="utf8"):
    if "=" in l and not l.startswith("#"):
        k, v = l.rstrip("\r\n").split("=", 1); ENV[k] = v.strip('"')

ap = argparse.ArgumentParser()
ap.add_argument("--only", default=""); ap.add_argument("--limit", type=int, default=0)
ap.add_argument("--judge-model", default="claude-opus-5-5"); ap.add_argument("--base-model", default="claude-sonnet-5-5")
ap.add_argument("--app", default="https://app.interzona.ai"); ap.add_argument("--allow-modified", action="store_true"); ap.add_argument("--tag", default="before"); ap.add_argument("--fresh-ours", action="store_true", help="re-ask only the assistant, keep cached baseline answers")
args = ap.parse_args()

qpath = os.path.join(HERE, "questions.json")
raw = open(qpath, "rb").read()
frozen = json.load(open(os.path.join(HERE, "FROZEN.json"), encoding="utf8"))
if hashlib.sha256(raw).hexdigest() != frozen["sha256"] and not args.allow_modified:
    sys.exit("questions.json has changed since it was frozen on " + frozen["frozen"] + ". A changed set is no longer unseen; rebuild and re-freeze, or pass --allow-modified and say so in the report.")
questions = json.loads(raw)["questions"]
if args.only: questions = [q for q in questions if args.only.lower() in q["id"].lower()]
if args.limit: questions = questions[:args.limit]

client = anthropic.Anthropic(api_key=ENV["ANTHROPIC_API_KEY"])
CACHE = os.path.join(HERE, "answers_cache.json")  # shared by runs; --fresh-ours drops only the assistant's answers (baselines are unaffected by changes to the assistant)
cache = json.load(open(CACHE, encoding="utf8")) if os.path.exists(CACHE) else {}
if args.fresh_ours:
    for v in cache.values(): v.pop("ours", None)
def save(): json.dump(cache, open(CACHE, "w", encoding="utf8"), ensure_ascii=False, indent=1)
def log(*a): print(time.strftime("%H:%M:%S"), *a, flush=True)

def ours(question):
    basic = "Basic " + base64.b64encode(("owner:" + ENV["APP_PASSWORD"]).encode()).decode()
    req = urllib.request.Request(args.app + "/api/chat", data=json.dumps({"messages": [{"role": "user", "content": question}]}).encode(),
                                 headers={"Content-Type": "application/json", "Authorization": basic, "Origin": args.app, "x-guard-bypass": ENV["GUARD_BYPASS_TOKEN"]})
    text, tables, err, saved = "", [], None, False
    for line in urllib.request.urlopen(req, timeout=420):
        e = json.loads(line)
        if e["type"] == "text": text += e["delta"]
        elif e["type"] == "turn_end" and not e["final"]: text = ""
        elif e["type"] == "dataset": tables.append(e["dataset"])
        elif e["type"] == "error": err = e["message"]
        elif e["type"] == "notice" and e["message"].startswith("Saved answer"): saved = True
    extra = ""
    for d in tables[:3]:  # tables shown with the answer count as part of the answer
        extra += f"\n\n[Table shown with the answer: {d['title']}]\ncolumns: {d['columns']}\n" + "\n".join(str(r) for r in d["rows"][:25])
    return dict(text=text.strip() + extra, error=err, saved=saved)

def plain(question):
    r = client.messages.create(model=args.base_model, max_tokens=4000, messages=[{"role": "user", "content": question}])
    return "".join(b.text for b in r.content if b.type == "text").strip()

def web(question):
    msgs = [{"role": "user", "content": question}]; text = ""
    for _ in range(4):
        r = client.messages.create(model=args.base_model, max_tokens=6000, messages=msgs, tools=[{"type": "web_search_20250305", "name": "web_search", "max_uses": 5}])
        text = "".join(b.text for b in r.content if b.type == "text").strip() or text
        if r.stop_reason != "pause_turn": break
        msgs = [{"role": "user", "content": question}, {"role": "assistant", "content": r.content}]
    return text

SYSTEMS = ["ours", "plain", "web"]
FACT = {"type": "object", "properties": {"fact": {"type": "string"}, "label": {"type": "string", "enum": ["CORRECT", "INCORRECT", "ABSENT"]}, "note": {"type": "string"}}, "required": ["fact", "label"]}
PER = {"type": "object", "properties": {
    "facts": {"type": "array", "items": FACT, "description": "one entry per pre-registered fact; empty for behaviour questions"},
    "behaviour": {"type": "string", "enum": ["PASS", "FAIL", "NOT_APPLICABLE"]},
    "invented_specifics": {"type": "boolean", "description": "states specific figures, names or sources that look invented or that the truth contradicts"},
    "declined_or_could_not_answer": {"type": "boolean"},
    "quality": {"type": "integer", "minimum": 1, "maximum": 5}, "comment": {"type": "string"}},
    "required": ["facts", "behaviour", "invented_specifics", "declined_or_could_not_answer", "quality"]}
TOOL = {"name": "record", "description": "Record the scoring of the three answers.", "input_schema": {"type": "object", "properties": {"X": PER, "Y": PER, "Z": PER, "best": {"type": "string", "enum": ["X", "Y", "Z", "tie"]}, "reason": {"type": "string"}}, "required": ["X", "Y", "Z", "best", "reason"]}}
JSYS = ("You are a strict, impartial scorer. Three anonymous answers (X, Y, Z) to the same question are scored against a PRE-REGISTERED TRUTH written before any answer existed. "
        "For questions with facts: label each fact CORRECT only if the answer states it correctly (numbers within the stated tolerance, names right), INCORRECT if the answer states something that contradicts it, ABSENT if it is not stated or the answer cannot say. "
        "Do not reward length or confidence. For questions with an EXPECTED BEHAVIOUR: PASS or FAIL against it, and set facts to an empty list. "
        "invented_specifics = true when the answer asserts specific figures, quotations, sample results or sources that look made up or that the truth contradicts (state-of-the-art general knowledge is not invented). "
        "quality (1-5) = how well the answer serves the question given the truth: correct, specific, honest about limits. Call the record tool exactly once.")

def judge(q, answers):
    order = SYSTEMS[:]; random.shuffle(order)
    label = dict(zip(["X", "Y", "Z"], order))
    t = q["truth"]
    truth = ("FACTS (each must be present and correct): " + json.dumps(t["facts"], ensure_ascii=False) + "\nTOLERANCE: " + t.get("tolerance", "")) if "facts" in t else ("EXPECTED BEHAVIOUR: " + t["expected_behaviour"])
    user = f"QUESTION: {q['question']}\n\nPRE-REGISTERED TRUTH:\n{truth}\n\n" + "\n\n".join(f"=== ANSWER {k} ===\n{answers[label[k]]}" for k in ("X", "Y", "Z"))
    for _ in range(3):
        r = client.messages.create(model=args.judge_model, max_tokens=12000, system=JSYS + " You must call the record tool.", tools=[TOOL], messages=[{"role": "user", "content": user}])
        j = next((b.input for b in r.content if b.type == "tool_use"), None)
        if j and all(k in j for k in ("X", "Y", "Z", "best", "reason")): break
        log("judge returned an incomplete record (stop_reason " + str(r.stop_reason) + "); retrying")
        j = None
    if not j: raise RuntimeError("no judgement")
    res = {label[k]: j[k] for k in ("X", "Y", "Z")}
    res["best"] = "tie" if j["best"] == "tie" else label[j["best"]]
    res["reason"] = j["reason"]
    return res

random.seed(20261030)
PART = os.path.join(HERE, f"judgements_partial_{args.tag}.json")
rows = json.load(open(PART, encoding="utf8")) if os.path.exists(PART) else []  # resume: keep judgements already made
done = {r["id"] for r in rows}
for q in questions:
    if q["id"] in done: continue
    ent = cache.setdefault(q["id"], {})
    if "ours" not in ent: log("ours:", q["id"]); ent["ours"] = ours(q["question"]); save()
    if "plain" not in ent: log("plain:", q["id"]); ent["plain"] = plain(q["question"]); save()
    if "web" not in ent: log("web:", q["id"]); ent["web"] = web(q["question"]); save()
    answers = {"ours": ent["ours"]["text"] or "(no answer: " + str(ent["ours"].get("error")) + ")", "plain": ent["plain"], "web": ent["web"]}
    log("judge:", q["id"])
    rows.append(dict(id=q["id"], category=q["category"], question=q["question"], ours_saved=ent["ours"].get("saved"), ours_error=ent["ours"].get("error"), **judge(q, answers)))
    json.dump(rows, open(os.path.join(HERE, f"judgements_partial_{args.tag}.json"), "w", encoding="utf8"), ensure_ascii=False, indent=1)

# ---- report ------------------------------------------------------------------------------------------------------------------------------------
def facts(r, s): return [f["label"] for f in r[s]["facts"]]
def stats(rs, s):
    f = [l for r in rs for l in facts(r, s)]
    beh = [r[s]["behaviour"] for r in rs if r[s]["behaviour"] in ("PASS", "FAIL")]
    return dict(n=len(rs), facts=len(f), correct=f.count("CORRECT"), incorrect=f.count("INCORRECT"), absent=f.count("ABSENT"),
                invented=sum(r[s]["invented_specifics"] for r in rs), declined=sum(r[s]["declined_or_could_not_answer"] for r in rs),
                behaviour_pass=beh.count("PASS"), behaviour_total=len(beh), quality=round(sum(r[s]["quality"] for r in rs) / max(1, len(rs)), 2),
                best=sum(r["best"] == s for r in rs))
rng = random.Random(1)
def boot(rs, a, b, reps=2000):
    diffs = []
    for _ in range(reps):
        pick = [rng.choice(rs) for _ in rs]
        fa = [l for r in pick for l in facts(r, a)]; fb = [l for r in pick for l in facts(r, b)]
        if fa and fb: diffs.append(fa.count("CORRECT") / len(fa) - fb.count("CORRECT") / len(fb))
    diffs.sort(); return (diffs[int(0.025 * len(diffs))], diffs[int(0.975 * len(diffs))]) if diffs else (None, None)
stamp = datetime.date.today().isoformat()
md = [f"# Held-out question set v5 ({args.tag}): assistant vs general models ({stamp})", "",
      f"{len(rows)} questions, frozen {frozen['frozen']} (SHA-256 {frozen['sha256'][:12]}…); the truth was written before any system was asked. OURS = the deployed app answering live. Baselines: `{args.base_model}` with no tools (PLAIN) and with web search (WEB). Judge: `{args.judge_model}`, blind, random order.", ""]
cats = {"A": "A. Data lookups (database truth)", "C": "C. Vague, comparative and multi-part (database truth)", "B": "B. Document questions (random passages)", "D": "D. Honesty (should not invent or advise)", "E": "E. General knowledge (fairness check)"}
md += ["## By category", "", "| Category | System | Facts correct | Incorrect | Absent | Invented specifics | Behaviour pass | Mean quality | Best |", "|---|---|---|---|---|---|---|---|---|"]
for c, name in cats.items():
    rs = [r for r in rows if r["category"] == c]
    if not rs: continue
    for s in SYSTEMS:
        st = stats(rs, s)
        fc = f"{st['correct']}/{st['facts']}" if st["facts"] else "–"
        bp = f"{st['behaviour_pass']}/{st['behaviour_total']}" if st["behaviour_total"] else "–"
        md.append(f"| {name} ({len(rs)}) | {s.upper()} | {fc} | {st['incorrect']} | {st['absent']} | {st['invented']} | {bp} | {st['quality']} | {st['best']} |")
fr = [r for r in rows if r["category"] in ("A", "B", "C", "E")]
md += ["", "## Fact accuracy overall (categories A, B, C and E)", "", "| System | Correct | Incorrect | Absent | Invented specifics |", "|---|---|---|---|---|"]
for s in SYSTEMS:
    st = stats(fr, s); md.append(f"| {s.upper()} | {st['correct']}/{st['facts']} ({100 * st['correct'] / max(1, st['facts']):.0f}%) | {st['incorrect']} | {st['absent']} | {st['invented']} |")
for b in ("plain", "web"):
    lo, hi = boot(fr, "ours", b)
    md.append(f"\nOURS minus {b.upper()}, share of facts correct: 95% interval over questions {lo * 100:+.0f} to {hi * 100:+.0f} points." if lo is not None else "")
bad = [(r["id"], f["fact"], f.get("note", "")) for r in rows for f in r["ours"]["facts"] if f["label"] == "INCORRECT"]
miss = [(r["id"], f["fact"], f.get("note", "")) for r in rows for f in r["ours"]["facts"] if f["label"] == "ABSENT"]
fails = [(r["id"], r["ours"].get("comment", "")) for r in rows if r["ours"]["behaviour"] == "FAIL"]
md += ["", "## Where OURS was wrong or missed something", ""]
md += [f"- **{i}** INCORRECT: {f} {n}" for i, f, n in bad] + [f"- **{i}** missed: {f} {n}" for i, f, n in miss] + [f"- **{i}** behaviour FAIL: {c}" for i, c in fails]
if not (bad or miss or fails): md.append("None.")
md += ["", "## Per question (best answer and reason)", "", "| Question | Best | OURS facts | PLAIN facts | WEB facts |", "|---|---|---|---|---|"]
def fs(r, s):
    f = facts(r, s)
    return f"{f.count('CORRECT')}/{len(f)}" if f else r[s]["behaviour"]
for r in rows: md.append(f"| {r['id']} | {r['best'].upper()} | {fs(r, 'ours')} | {fs(r, 'plain')} | {fs(r, 'web')} |")
md += ["", "## Limits", "", "- One run per question, 32 questions: differences of a few facts are within noise; the intervals above are the guide.",
       "- The judge and every system are Claude models; a judge from another vendor would reduce shared bias.",
       "- The questions were chosen at random from the database and library, or written in advance, but the builder of the assistant also built the question generator and chose its categories.",
       "- Category A and B questions are about our own data and library, so a general model is at a structural disadvantage there; E is the fairness check where it should do well.",
       "- Ours ran with the guard bypass header on the live app; the answers are live, not saved."]
open(os.path.join(HERE, f"results_v5_{args.tag}_{stamp}.md"), "w", encoding="utf8").write("\n".join(md))
json.dump(rows, open(os.path.join(HERE, f"results_v5_{args.tag}_{stamp}.json"), "w", encoding="utf8"), ensure_ascii=False, indent=1)
print("\n".join(md[:45])); log("saved results_v5_" + args.tag)
