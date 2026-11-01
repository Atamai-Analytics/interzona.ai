# Report-summary batch 1 set (after-prompt): assistant vs general models (2026-10-30)

10 questions, frozen 2026-10-30T08:17:34 (SHA-256 07b43acb595b…); the truth was written before any system was asked. OURS = the deployed app answering live. Baselines: `claude-sonnet-5-5` with no tools (PLAIN) and with web search (WEB). Judge: `claude-opus-5-5`, blind, random order.

## By category

| Category | System | Facts correct | Incorrect | Absent | Invented specifics | Behaviour pass | Mean quality | Best |
|---|---|---|---|---|---|---|---|---|
| B. Document questions (random passages) (10) | OURS | 35/35 | 0 | 0 | 0 | – | 5.0 | 10 |
| B. Document questions (random passages) (10) | PLAIN | 0/35 | 6 | 29 | 1 | – | 1.8 | 0 |
| B. Document questions (random passages) (10) | WEB | 26/35 | 5 | 4 | 1 | – | 3.6 | 0 |

## Fact accuracy overall (categories A, B, C and E)

| System | Correct | Incorrect | Absent | Invented specifics |
|---|---|---|---|---|
| OURS | 35/35 (100%) | 0 | 0 | 0 |
| PLAIN | 0/35 (0%) | 6 | 29 | 1 |
| WEB | 26/35 (74%) | 5 | 4 | 1 |

OURS minus PLAIN, share of facts correct: 95% interval over questions +100 to +100 points.

OURS minus WEB, share of facts correct: 95% interval over questions +8 to +46 points.

## Where OURS was wrong or missed something

None.

## Per question (best answer and reason)

| Question | Best | OURS facts | PLAIN facts | WEB facts |
|---|---|---|---|---|
| B-chvaletice-econ | OURS | 4/4 | 0/4 | 4/4 |
| B-zinnwald-reserve | OURS | 3/3 | 0/3 | 0/3 |
| B-zinnwald-econ | OURS | 3/3 | 0/3 | 3/3 |
| B-vulcan-reserve | OURS | 3/3 | 0/3 | 3/3 |
| B-rovina-econ | OURS | 4/4 | 0/4 | 3/4 |
| B-skouries-reserve | OURS | 3/3 | 0/3 | 1/3 |
| B-nevescorvo-reserve | OURS | 3/3 | 0/3 | 3/3 |
| B-aguablanca-econ | OURS | 4/4 | 0/4 | 3/4 |
| B-sarytogan-dfs | OURS | 4/4 | 0/4 | 4/4 |
| B-viscaria-fs | OURS | 4/4 | 0/4 | 2/4 |

## Limits

- One run per question, 32 questions: differences of a few facts are within noise; the intervals above are the guide.
- The judge and every system are Claude models; a judge from another vendor would reduce shared bias.
- The questions were chosen at random from the database and library, or written in advance, but the builder of the assistant also built the question generator and chose its categories.
- Category A and B questions are about our own data and library, so a general model is at a structural disadvantage there; E is the fairness check where it should do well.
- Ours ran with the guard bypass header on the live app; the answers are live, not saved.