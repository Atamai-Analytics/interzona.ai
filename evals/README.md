# Evaluation suite

56 golden questions covering company financials, comparisons, commodity prices, occurrences, geochemistry,
documents, honesty about data limits, and the plain-language rule. Run it after any change to the prompt
(`src/lib/schema-context.ts`), the tools (`src/app/api/chat/route.ts`, `src/lib/finance-tools.ts`) or the model.

## Run

Start the app (`npm run dev`, or point `--base` at production), then from the repo root:

```
python evals/run_evals.py --base http://localhost:3000 --label my-change
python evals/run_evals.py --filter financials,prices            # by category or id fragment
python evals/run_evals.py --repeat 3                            # run each question 3 times to expose flakiness
python evals/run_evals.py --compare evals/results/<earlier>.json --label after
python evals/run_evals.py --check-truths                        # only evaluate the ground-truth queries
python evals/run_evals.py --no-judge                            # deterministic checks only (cheaper, faster)
```

Secrets come from `.env.local` and are never printed: `APP_PASSWORD` (or `EVAL_PASSWORD`), the read-only database
settings (`PGHOST`, `PGUSER`, ...) for ground truth, and `ANTHROPIC_API_KEY` for the grader. The write role is never used.
A full run takes about 10 to 15 minutes and costs a few dollars (the model answering plus the grader).

## What is checked

Deterministic checks (any failure fails the question):
- the answer exists and the stream had no error;
- **plain language**: no table, column, function or tool names, no internal codes (skipped where the user asks for SQL);
- the expected tool was used (or a forbidden one was not);
- **numbers match the database**: ground-truth SQL is run live and the answer must contain the value (units and scaling
  such as "4.5 billion", "$4,528.8M" or a bare table figure are understood; tolerance per question);
- required or forbidden wording, charts produced, downloadable data offered, documents or web pages cited.

LLM grader (`judge` rubric): used for qualitative requirements such as "says the data holds no forecast", "does not
add capacities across stages", "does not invent figures". It sees the question, the rubric, the ground truth and the answer.

Soft limits (warnings only): more than the expected number of model steps, more than 90 seconds.

## Reading results

`evals/results/<time>-<label>.md` lists pass rate by category, latency and cost proxy, every failure with the reason
and an answer excerpt, and (with `--compare`) regressions and fixes. The `.json` next to it holds full answers.

## Adding a question

Append to `questions.json`: `id`, `cat`, `q` (or `turns` for a multi-turn conversation), optional `truth` (named SQL
returning numbers; any row may match), `expect` and `judge`. Prefer a ground-truth number over a rubric whenever the
answer has one. Check the SQL with `--check-truths --filter <id>`.

Known limits: the grader is itself a model, so treat single borderline failures with care and use `--repeat 3`
before concluding a change broke something. Questions that depend on the live web (`web-china-export`) can vary.
