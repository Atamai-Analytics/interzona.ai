"""Compare the assistant's approved demo answers with a general model that has no access to our data.

For each demo card question this script collects
  * OURS: the approved saved answer, exactly as an investor sees it (fetched from the app; the owner session is served the saved recording, no model cost);
  * PLAIN: the same model family with no tools and no data (what you get from a general chat model);
  * WEB: the same model with web search switched on (the stronger general competitor).
A judge model then reads OURS against each baseline, in random order and without being told which is which, and
  1. lists each answer's most important specific claims and labels them against an EVIDENCE PACK of what our database returned (supported / contradicted /
     specific but not checkable here / general),
  2. scores each answer 1-5 on specificity, traceability (does it name its sources), accuracy as far as can be judged, honesty about limits, and usefulness to an investor,
  3. picks a winner (or a tie) with a reason.
Limits, stated in the report: one run per question; the judge is a Claude model, as are the answers (a shared bias is possible); the evidence pack is only the tables and sources our answer
displayed, so a claim missing from it is "not checkable here", not "wrong"; a general model cannot be expected to know our database, so data questions are lopsided by design and the literature questions
are the fairer test.

Usage: python evals/compare_baseline.py [--refresh] [--only SUBSTRING] [--judge-model M] [--base-model M]"""
import argparse, base64, json, os, random, re, sys, time, urllib.request, urllib.error, datetime
import anthropic

sys.stdout.reconfigure(encoding="utf8")
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
ENV = {}
for l in open(os.path.join(ROOT, ".env.local"), encoding="utf8"):
    if "=" in l and not l.startswith("#"):
        k, v = l.rstrip("\r\n").split("=", 1); ENV[k] = v.strip('"')

ap = argparse.ArgumentParser()
ap.add_argument("--refresh", action="store_true", help="ignore cached answers and ask again")
ap.add_argument("--only", default="", help="only questions whose title contains this text")
ap.add_argument("--judge-model", default="claude-opus-5-5")
ap.add_argument("--base-model", default="claude-sonnet-5-5")
ap.add_argument("--app", default="https://app.interzona.ai")
args = ap.parse_args()

client = anthropic.Anthropic(api_key=ENV["ANTHROPIC_API_KEY"])
OUT = os.path.join(HERE, "compare")
os.makedirs(OUT, exist_ok=True)
CACHE = os.path.join(OUT, "answers_cache.json")
cache = json.load(open(CACHE, encoding="utf8")) if os.path.exists(CACHE) and not args.refresh else {}


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def save_cache():
    json.dump(cache, open(CACHE, "w", encoding="utf8"), ensure_ascii=False, indent=1)


# ---- the demo cards ------------------------------------------------------------------------------------------------------------------------------
src = open(os.path.join(ROOT, "src", "lib", "demo-cards.ts"), encoding="utf8").read()
cards = [dict(title=m.group(1), prompt=m.group(2)) for m in re.finditer(r'title: "((?:[^"\\]|\\.)*)",\s*description: "(?:[^"\\]|\\.)*",\s*prompt: "((?:[^"\\]|\\.)*)"', src)]
cards = [dict(title=json.loads('"' + c["title"] + '"'), prompt=json.loads('"' + c["prompt"] + '"')) for c in cards]
if args.only: cards = [c for c in cards if args.only.lower() in c["title"].lower()]
log("questions:", len(cards))


# ---- OURS: the approved saved answer ---------------------------------------------------------------------------------------------------------------
def get_ours(prompt):
    basic = "Basic " + base64.b64encode(("owner:" + ENV["APP_PASSWORD"]).encode()).decode()
    req = urllib.request.Request(args.app + "/api/chat", data=json.dumps({"messages": [{"role": "user", "content": prompt}]}).encode(),
                                 headers={"Content-Type": "application/json", "Authorization": basic, "Origin": args.app})
    text, datasets, evidence, notice, live = "", [], [], "", False
    for raw in urllib.request.urlopen(req, timeout=300):
        e = json.loads(raw)
        if e["type"] == "text": text += e["delta"]
        elif e["type"] == "turn_end" and not e["final"]: text = ""
        elif e["type"] == "dataset": datasets.append(e["dataset"])
        elif e["type"] == "evidence": evidence += e["items"]
        elif e["type"] == "notice": notice = e["message"]
        elif e["type"] == "usage": live = True
    return dict(text=text.strip(), datasets=datasets, evidence=evidence, notice=notice, live_run=live)


def evidence_pack(o):
    parts = []
    for d in o["datasets"]:
        rows = d["rows"][:25]
        parts.append(f"TABLE: {d['title']}\ncolumns: {d['columns']}\nrows (first {len(rows)} of {len(d['rows'])}): {json.dumps(rows, ensure_ascii=False)}")
        if d.get("bars"): parts.append("BARS: " + json.dumps(d["bars"], ensure_ascii=False)[:1500])
    src_lines = []
    for e in o["evidence"]:
        if e["kind"] == "document": src_lines.append(f"document: {e['title']}" + (f", p.{e['page']}" if e.get("page") else ""))
        elif e["kind"] == "data": src_lines.append("data: " + e["label"] + (f" ({e['detail']})" if e.get("detail") else ""))
        else: src_lines.append("web: " + e["title"])
    parts.append("SOURCES SHOWN WITH THE ANSWER:\n" + "\n".join(dict.fromkeys(src_lines)))
    return "\n\n".join(parts)[:14000]


# ---- baselines ---------------------------------------------------------------------------------------------------------------------------------
def ask_plain(prompt):
    r = client.messages.create(model=args.base_model, max_tokens=4000, messages=[{"role": "user", "content": prompt}])
    return "".join(b.text for b in r.content if b.type == "text").strip()


def ask_web(prompt):
    msgs = [{"role": "user", "content": prompt}]
    text = ""
    for _ in range(4):  # a paused turn (server-side search in progress) is simply continued
        r = client.messages.create(model=args.base_model, max_tokens=6000, messages=msgs, tools=[{"type": "web_search_20250305", "name": "web_search", "max_uses": 5}])
        text = "".join(b.text for b in r.content if b.type == "text").strip() or text
        if r.stop_reason != "pause_turn": break
        msgs = [{"role": "user", "content": prompt}, {"role": "assistant", "content": r.content}]
    return text


# ---- judge -------------------------------------------------------------------------------------------------------------------------------------
SCORES = {k: {"type": "integer", "minimum": 1, "maximum": 5} for k in ("specificity", "traceability", "accuracy", "honesty_about_limits", "usefulness")}
CLAIMS = {"type": "array", "maxItems": 10, "items": {"type": "object", "properties": {"claim": {"type": "string"}, "label": {"type": "string", "enum": ["SUPPORTED", "CONTRADICTED", "SPECIFIC_NOT_CHECKABLE", "GENERAL"]}, "note": {"type": "string"}}, "required": ["claim", "label"]}}
JUDGE_TOOL = {
    "name": "record_judgement", "description": "Record the comparison of answer A and answer B.",
    "input_schema": {"type": "object", "properties": {
        "A_claims": CLAIMS, "B_claims": CLAIMS,
        "A_scores": {"type": "object", "properties": SCORES, "required": list(SCORES)}, "B_scores": {"type": "object", "properties": SCORES, "required": list(SCORES)},
        "A_could_not_do_the_task": {"type": "boolean", "description": "A says it lacks the data, tools or access to do what was asked, or returns something that is not what was asked."},
        "B_could_not_do_the_task": {"type": "boolean"},
        "preference": {"type": "string", "enum": ["A", "B", "tie"]}, "reason": {"type": "string"}},
        "required": ["A_claims", "B_claims", "A_scores", "B_scores", "A_could_not_do_the_task", "B_could_not_do_the_task", "preference", "reason"]},
}
JUDGE_SYS = (
    "You are a careful, sceptical evaluator comparing two answers (A and B) to the same question from an investor evaluating a critical-minerals analysis tool. You do not know which answer comes from which system. "
    "Judge only what is on the page. EVIDENCE PACK = the tables and sources that one of the systems displayed from its own database; use it as ground truth for the claims it covers. "
    "Claim labels: SUPPORTED = matches the evidence pack; CONTRADICTED = conflicts with the evidence pack or is plainly false; SPECIFIC_NOT_CHECKABLE = a specific figure, name, date or fact that the pack does not cover (do NOT treat it as wrong); GENERAL = not a checkable specific. "
    "List each answer's most important claims (up to 10, the most decision-relevant first). "
    "Scores 1-5: specificity (concrete, quantified, tied to named entities or places); traceability (names its data sources, documents or pages so a reader could check it); accuracy (as far as you can judge; reduce it for contradictions or confident statements of things that look invented); "
    "honesty_about_limits (states what it did not know, estimates, data limits, without hiding behind vagueness); usefulness (would help an investor decide what to look at next; a confident but empty answer scores low). "
    "An answer that does not do what was asked (for example cannot produce the requested map, table or link) must set could_not_do_the_task. Prefer the answer you would rather rely on; say tie only if truly equal."
)


def judge(question, ours, theirs, label):
    ours_is_a = random.random() < 0.5
    A, B = (ours["text"], theirs) if ours_is_a else (theirs, ours["text"])
    user = f"QUESTION:\n{question}\n\nEVIDENCE PACK (from one system's database; the system is not identified):\n{evidence_pack(ours)}\n\n=== ANSWER A ===\n{A}\n\n=== ANSWER B ===\n{B}"
    j = None
    for attempt in range(3):  # some models do not allow a forced tool choice, so ask for the tool call and retry if it does not come
        r = client.messages.create(model=args.judge_model, max_tokens=12000, system=JUDGE_SYS + " Respond by calling the record_judgement tool exactly once.", tools=[JUDGE_TOOL], messages=[{"role": "user", "content": user}])
        j = next((b.input for b in r.content if b.type == "tool_use"), None)
        if j: break
    if not j: raise RuntimeError("the judge did not return a judgement")
    side = ("A", "B") if ours_is_a else ("B", "A")  # (ours, theirs)
    def pick(side_key):
        return dict(claims=j[f"{side_key}_claims"], scores=j[f"{side_key}_scores"], could_not=j[f"{side_key}_could_not_do_the_task"])
    pref = j["preference"]
    winner = "tie" if pref == "tie" else ("ours" if pref == side[0] else label)
    return dict(ours=pick(side[0]), theirs=pick(side[1]), winner=winner, reason=j["reason"], ours_was=side[0])


# ---- run ---------------------------------------------------------------------------------------------------------------------------------------
results = []
for c in cards:
    key = c["prompt"]
    ent = cache.setdefault(key, {})
    if "ours" not in ent:
        log("ours:", c["title"])
        o = get_ours(c["prompt"])
        if o["live_run"] or not o["notice"].startswith("Saved answer") or not o["text"]:
            log("  SKIPPED: not a saved answer (would be a live run) or empty:", o["notice"][:60]); results.append(dict(title=c["title"], skipped="not an approved saved answer")); continue
        ent["ours"] = o; save_cache()
    if "plain" not in ent:
        log("plain:", c["title"]); ent["plain"] = ask_plain(c["prompt"]); save_cache()
    if "web" not in ent:
        log("web:", c["title"]); ent["web"] = ask_web(c["prompt"]); save_cache()
    row = dict(title=c["title"], prompt=c["prompt"], ours_chars=len(ent["ours"]["text"]), plain_chars=len(ent["plain"]), web_chars=len(ent["web"]))
    for name in ("plain", "web"):
        log("judge:", name, c["title"])
        row[name] = judge(c["prompt"], ent["ours"], ent[name], name)
    results.append(row)

# ---- report ------------------------------------------------------------------------------------------------------------------------------------
done = [r for r in results if "plain" in r]
def mean(xs): return round(sum(xs) / len(xs), 2) if xs else None
summary = {}
for name in ("plain", "web"):
    rows = [r[name] for r in done]
    wins = {"ours": sum(r["winner"] == "ours" for r in rows), "tie": sum(r["winner"] == "tie" for r in rows), name: sum(r["winner"] == name for r in rows)}
    sc = {k: {"ours": mean([r["ours"]["scores"][k] for r in rows]), "baseline": mean([r["theirs"]["scores"][k] for r in rows])} for k in SCORES}
    count = lambda side, lab: sum(1 for r in rows for cl in r[side]["claims"] if cl["label"] == lab)
    summary[name] = dict(questions=len(rows), preference=wins, mean_scores=sc,
                         claims={s: {lab: count(s, lab) for lab in ("SUPPORTED", "CONTRADICTED", "SPECIFIC_NOT_CHECKABLE", "GENERAL")} for s in ("ours", "theirs")},
                         could_not_do_the_task={"ours": sum(r["ours"]["could_not"] for r in rows), "baseline": sum(r["theirs"]["could_not"] for r in rows)})
stamp = datetime.date.today().isoformat()
json.dump(dict(date=stamp, base_model=args.base_model, judge_model=args.judge_model, summary=summary, results=results), open(os.path.join(OUT, f"comparison_{stamp}.json"), "w", encoding="utf8"), ensure_ascii=False, indent=1)

md = [f"# Assistant vs general model: demo questions ({stamp})", "",
      f"Baseline answers: `{args.base_model}` with no tools (PLAIN) and with web search (WEB). Judge: `{args.judge_model}`, blind, random order. One run per question ({len(done)} questions).", ""]
for name, label in (("plain", "PLAIN: general model, no tools or data"), ("web", "WEB: general model with web search")):
    s = summary[name]
    md += [f"## Ours vs {label}", "", f"Preferred: ours {s['preference']['ours']}, tie {s['preference']['tie']}, baseline {s['preference'][name]} (of {s['questions']}).", "",
           "| Score (1-5, mean) | Ours | Baseline |", "|---|---|---|"] + [f"| {k.replace('_', ' ')} | {v['ours']} | {v['baseline']} |" for k, v in s["mean_scores"].items()]
    md += ["", "| Claims listed | Supported | Contradicted | Specific, not checkable | General |", "|---|---|---|---|---|"]
    for side, nm in (("ours", "Ours"), ("theirs", "Baseline")):
        c = s["claims"][side]; md.append(f"| {nm} | {c['SUPPORTED']} | {c['CONTRADICTED']} | {c['SPECIFIC_NOT_CHECKABLE']} | {c['GENERAL']} |")
    md += ["", f"Could not do what was asked: ours {s['could_not_do_the_task']['ours']}, baseline {s['could_not_do_the_task']['baseline']}.", ""]
md += ["## Per question", "", "| Question | vs PLAIN | vs WEB |", "|---|---|---|"]
for r in done: md.append(f"| {r['title']} | {r['plain']['winner']} | {r['web']['winner']} |")
md += ["", "## Where the judge found a problem in OUR answers (contradicted claims)", ""]
flagged = False
for r in done:
    for name in ("plain", "web"):
        for cl in r[name]["ours"]["claims"]:
            if cl["label"] == "CONTRADICTED":
                flagged = True; md.append(f"- **{r['title']}** (judged against {name}): {cl['claim']}  {cl.get('note', '')}")
if not flagged: md.append("None flagged.")
md += ["", "## Reasons given", ""]
for r in done: md += [f"**{r['title']}**", f"- vs PLAIN ({r['plain']['winner']}): {r['plain']['reason']}", f"- vs WEB ({r['web']['winner']}): {r['web']['reason']}", ""]
md += ["## Limits", "", "- One run per question; model answers vary run to run.", "- The judge and the answers are all Claude models, so a shared bias is possible; a second judge from another vendor would reduce this.",
       "- The evidence pack is only what our answer displayed, so a figure outside it is 'not checkable', not wrong. A general model cannot know our database, so the data questions are lopsided by design; the literature questions are the fairer test.",
       "- The approved saved answers were reviewed by the owner before approval."]
open(os.path.join(OUT, f"comparison_{stamp}.md"), "w", encoding="utf8").write("\n".join(md))
print("\n".join(md[:60]))
log("saved", os.path.join(OUT, f"comparison_{stamp}.md"))
