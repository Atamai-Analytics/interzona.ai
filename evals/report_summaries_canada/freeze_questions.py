"""Freezes the held-out question set: records the SHA-256 of questions.json and the date. After this, run_heldout.py refuses to run if the file changes."""
import hashlib, json, os, datetime
HERE = os.path.dirname(os.path.abspath(__file__))
raw = open(os.path.join(HERE, "questions.json"), "rb").read()
n = len(json.loads(raw)["questions"])
json.dump(dict(frozen=datetime.datetime.now().isoformat(timespec="seconds"), sha256=hashlib.sha256(raw).hexdigest(), questions=n,
               rule="Do not edit questions.json, and do not tune the assistant against these questions. If either happens, say so in the report and treat the set as seen."),
          open(os.path.join(HERE, "FROZEN.json"), "w", encoding="utf8"), indent=1)
print("frozen", n, "questions")
