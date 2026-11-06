# Report-summary Canada set (after): assistant vs general models (2026-11-05)

12 questions, frozen 2026-11-05T20:01:51 (SHA-256 c1321b5db618…); the truth was written before any system was asked. OURS = the deployed app answering live. Baselines: `claude-sonnet-5-5` with no tools (PLAIN) and with web search (WEB). Judge: `claude-opus-5-5`, blind, random order.

## By category

| Category | System | Facts correct | Incorrect | Absent | Invented specifics | Behaviour pass | Mean quality | Best |
|---|---|---|---|---|---|---|---|---|
| B. Document questions (random passages) (12) | OURS | 43/47 | 1 | 3 | 1 | – | 4.58 | 9 |
| B. Document questions (random passages) (12) | PLAIN | 5/48 | 20 | 23 | 6 | – | 1.75 | 0 |
| B. Document questions (random passages) (12) | WEB | 35/48 | 5 | 8 | 4 | – | 3.83 | 3 |

## Fact accuracy overall (categories A, B, C and E)

| System | Correct | Incorrect | Absent | Invented specifics |
|---|---|---|---|---|
| OURS | 43/47 (91%) | 1 | 3 | 1 |
| PLAIN | 5/48 (10%) | 20 | 23 | 6 |
| WEB | 35/48 (73%) | 5 | 8 | 4 |

OURS minus PLAIN, share of facts correct: 95% interval over questions +68 to +92 points.

OURS minus WEB, share of facts correct: 95% interval over questions +5 to +31 points.

## Where OURS was wrong or missed something

- **C-arrow-fs** INCORRECT: Post-tax NPV8 of C$3,465 million and post-tax IRR of 52.4% at US$50/lb U3O8 IRR is right, but the table labels the NPV as US$3,465M. The truth is C$. The answer also says the study's figures are in C$, which contradicts its own table.
- **C-crawford-fs** missed: Initial capital cost of about C$2,556 million (60 kt/d start, expanding to 120 kt/d) Says outright that it did not retrieve the capex figure. It does give the 60 to 120 kt/d ramp.
- **C-wheeler-phoenix** missed: Phoenix Proven and Probable reserves of about 219 kt at 11.7% U3O8 (about 56.7 Mlb recoverable U3O8) Gives the M&I resource (70.5 Mlb at 11.4%) and LOM sales of 56.1 Mlb, but not the reserve tonnage, grade or 56.7 Mlb
- **C-sisson-fs** missed: Initial capital of about C$1,528 million Says the release does not give capex

## Per question (best answer and reason)

| Question | Best | OURS facts | PLAIN facts | WEB facts |
|---|---|---|---|---|
| C-shaakichiuwaanaan-fs | WEB | 4/4 | 0/4 | 4/4 |
| C-rose-fs | OURS | 4/4 | 0/4 | 2/4 |
| C-crawford-fs | OURS | 3/4 | 0/4 | 3/4 |
| C-arrow-fs | WEB | 3/4 | 2/4 | 3/4 |
| C-wheeler-phoenix | OURS | 3/4 | 0/4 | 2/4 |
| C-matawinie-fs | OURS | 4/4 | 1/4 | 2/4 |
| C-casino-fs | OURS | 4/4 | 1/4 | 3/4 |
| C-sisson-fs | WEB | 2/3 | 0/4 | 4/4 |
| C-moblan-dfs | OURS | 4/4 | 0/4 | 3/4 |
| C-wicheeda-pfs | OURS | 4/4 | 0/4 | 3/4 |
| C-marathon-fs | OURS | 4/4 | 1/4 | 4/4 |
| C-nal-expansion | OURS | 4/4 | 0/4 | 2/4 |

## Limits

- One run per question, 32 questions: differences of a few facts are within noise; the intervals above are the guide.
- The judge and every system are Claude models; a judge from another vendor would reduce shared bias.
- The questions were chosen at random from the database and library, or written in advance, but the builder of the assistant also built the question generator and chose its categories.
- Category A and B questions are about our own data and library, so a general model is at a structural disadvantage there; E is the fairness check where it should do well.
- Ours ran with the guard bypass header on the live app; the answers are live, not saved.