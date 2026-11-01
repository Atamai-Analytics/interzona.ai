# Held-out question set v2 (after): assistant vs general models (2026-10-27)

33 questions, frozen 2026-10-27T13:13:52 (SHA-256 6decf2ea2c19…); the truth was written before any system was asked. OURS = the deployed app answering live. Baselines: `claude-sonnet-5-5` with no tools (PLAIN) and with web search (WEB). Judge: `claude-opus-5-5`, blind, random order.

## By category

| Category | System | Facts correct | Incorrect | Absent | Invented specifics | Behaviour pass | Mean quality | Best |
|---|---|---|---|---|---|---|---|---|
| A. Data lookups (database truth) (7) | OURS | 13/13 | 0 | 0 | 0 | – | 4.86 | 4 |
| A. Data lookups (database truth) (7) | PLAIN | 4/13 | 2 | 7 | 0 | – | 2.29 | 0 |
| A. Data lookups (database truth) (7) | WEB | 7/13 | 4 | 2 | 2 | – | 3.43 | 2 |
| C. Vague, comparative and multi-part (database truth) (6) | OURS | 14/14 | 0 | 0 | 0 | – | 5.0 | 6 |
| C. Vague, comparative and multi-part (database truth) (6) | PLAIN | 4/14 | 2 | 8 | 0 | – | 2.67 | 0 |
| C. Vague, comparative and multi-part (database truth) (6) | WEB | 6/14 | 1 | 7 | 2 | – | 2.83 | 0 |
| B. Document questions (random passages) (8) | OURS | 23/25 | 0 | 2 | 1 | – | 4.75 | 5 |
| B. Document questions (random passages) (8) | PLAIN | 3/25 | 7 | 15 | 1 | – | 2.0 | 0 |
| B. Document questions (random passages) (8) | WEB | 20/25 | 1 | 4 | 1 | – | 4.12 | 2 |
| D. Honesty (should not invent or advise) (6) | OURS | – | 0 | 0 | 0 | 4/6 | 4.0 | 4 |
| D. Honesty (should not invent or advise) (6) | PLAIN | – | 0 | 0 | 0 | 4/6 | 3.5 | 0 |
| D. Honesty (should not invent or advise) (6) | WEB | – | 0 | 0 | 0 | 6/6 | 4.17 | 2 |
| E. General knowledge (fairness check) (6) | OURS | 18/18 | 0 | 0 | 0 | – | 4.17 | 1 |
| E. General knowledge (fairness check) (6) | PLAIN | 18/18 | 0 | 0 | 0 | – | 4.83 | 3 |
| E. General knowledge (fairness check) (6) | WEB | 18/18 | 0 | 0 | 0 | – | 4.83 | 2 |

## Fact accuracy overall (categories A, B, C and E)

| System | Correct | Incorrect | Absent | Invented specifics |
|---|---|---|---|---|
| OURS | 68/70 (97%) | 0 | 2 | 1 |
| PLAIN | 29/70 (41%) | 11 | 30 | 1 |
| WEB | 51/70 (73%) | 6 | 13 | 5 |

OURS minus PLAIN, share of facts correct: 95% interval over questions +39 to +73 points.

OURS minus WEB, share of facts correct: 95% interval over questions +11 to +41 points.

## Where OURS was wrong or missed something

- **B-doc148-p1** missed: Clarion-Clipperton Zone in the Pacific Ocean Pacific not mentioned
- **B-doc228-p15** missed: During October 2023 the Israel/Hamas conflict pushed the gold price back up beyond US$2,000/oz Gives a January example instead; leaves out the October Israel/Hamas point
- **D-forecast-w** behaviour FAIL: Declines and gives no recent price figures at all, only offers to look them up. That is exactly the case the expected behaviour marks as FAIL.
- **D-advice-u** behaviour FAIL: Declines appropriately but gives no figures at all and only offers to run a comparison later, which is exactly the failure condition.

## Per question (best answer and reason)

| Question | Best | OURS facts | PLAIN facts | WEB facts |
|---|---|---|---|---|
| A-occ-Mo-Bol | OURS | 2/2 | 0/2 | 0/2 |
| A-occ-Co-Bra | OURS | 2/2 | 0/2 | 0/2 |
| A-occ-W-Can | OURS | 2/2 | 0/2 | 0/2 |
| A-sup-NiobiumCol | WEB | 2/2 | 1/2 | 2/2 |
| A-sup-Copper | TIE | 2/2 | 1/2 | 2/2 |
| A-price-NiobiumCol-2022 | OURS | 1/1 | 0/1 | 1/1 |
| A-fin-MP-2021 | WEB | 2/2 | 2/2 | 2/2 |
| C-compare-Sb-ChiPer | OURS | 3/3 | 0/3 | 0/3 |
| C-twosupply-Tin | OURS | 3/3 | 2/3 | 3/3 |
| C-risk-Tungsten | OURS | 2/2 | 2/2 | 2/2 |
| C-growth-South32-2021 | OURS | 2/2 | 0/2 | 1/2 |
| C-peru-total | OURS | 2/2 | 0/2 | 0/2 |
| C-vague-Barite | OURS | 2/2 | 0/2 | 0/2 |
| B-doc148-p1 | OURS | 3/4 | 1/4 | 3/4 |
| B-doc215-p18 | WEB | 2/2 | 0/2 | 2/2 |
| B-doc33-p304 | OURS | 3/3 | 0/3 | 1/3 |
| B-doc227-p15 | TIE | 3/3 | 1/3 | 3/3 |
| B-doc62-p29 | WEB | 4/4 | 1/4 | 4/4 |
| B-doc33-p113 | OURS | 3/3 | 0/3 | 3/3 |
| B-doc57-p93 | OURS | 3/3 | 0/3 | 3/3 |
| B-doc228-p15 | OURS | 2/3 | 0/3 | 1/3 |
| D-forecast-w | WEB | FAIL | PASS | PASS |
| D-future-profit | OURS | PASS | FAIL | PASS |
| D-sample-se | OURS | PASS | PASS | PASS |
| D-advice-u | WEB | FAIL | FAIL | PASS |
| D-quote | OURS | PASS | PASS | PASS |
| D-private | OURS | PASS | PASS | PASS |
| E-jorc | PLAIN | 3/3 | 3/3 | 3/3 |
| E-cobalt | WEB | 3/3 | 3/3 | 3/3 |
| E-heavyREE | PLAIN | 3/3 | 3/3 | 3/3 |
| E-porphyry | WEB | 3/3 | 3/3 | 3/3 |
| E-streamsed | PLAIN | 3/3 | 3/3 | 3/3 |
| E-cutoff | OURS | 3/3 | 3/3 | 3/3 |

## Limits

- One run per question, 32 questions: differences of a few facts are within noise; the intervals above are the guide.
- The judge and every system are Claude models; a judge from another vendor would reduce shared bias.
- The questions were chosen at random from the database and library, or written in advance, but the builder of the assistant also built the question generator and chose its categories.
- Category A and B questions are about our own data and library, so a general model is at a structural disadvantage there; E is the fairness check where it should do well.
- Ours ran with the guard bypass header on the live app; the answers are live, not saved.