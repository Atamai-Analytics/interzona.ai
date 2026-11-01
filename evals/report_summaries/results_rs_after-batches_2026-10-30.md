# Report-summary pilot set (after-batches): assistant vs general models (2026-10-30)

14 questions, frozen 2026-10-29T18:02:22 (SHA-256 72edeb97bcbb…); the truth was written before any system was asked. OURS = the deployed app answering live. Baselines: `claude-sonnet-5-5` with no tools (PLAIN) and with web search (WEB). Judge: `claude-opus-5-5`, blind, random order.

## By category

| Category | System | Facts correct | Incorrect | Absent | Invented specifics | Behaviour pass | Mean quality | Best |
|---|---|---|---|---|---|---|---|---|
| B. Document questions (random passages) (14) | OURS | 42/48 | 3 | 3 | 1 | – | 4.64 | 10 |
| B. Document questions (random passages) (14) | PLAIN | 1/48 | 11 | 36 | 3 | – | 1.86 | 0 |
| B. Document questions (random passages) (14) | WEB | 29/48 | 13 | 6 | 6 | – | 3.36 | 3 |

## Fact accuracy overall (categories A, B, C and E)

| System | Correct | Incorrect | Absent | Invented specifics |
|---|---|---|---|---|
| OURS | 42/48 (88%) | 3 | 3 | 1 |
| PLAIN | 1/48 (2%) | 11 | 36 | 3 |
| WEB | 29/48 (60%) | 13 | 6 | 6 |

OURS minus PLAIN, share of facts correct: 95% interval over questions +72 to +96 points.

OURS minus WEB, share of facts correct: 95% interval over questions +9 to +47 points.

## Where OURS was wrong or missed something

- **B-vittangi-resource** INCORRECT: Total 70.8 Mt at 18.8% Cg containing about 13.3 Mt of graphite Gives the Vittangi total as 35.0 Mt at 23.8% Cg. It mentions 70.8 Mt at 18.8% only as a wider Swedish total and gives no contained-graphite figure for it.
- **B-vittangi-resource** INCORRECT: Indicated 30.1 Mt at 22.4% Cg States 26.7 Mt at 24.3% Cg.
- **B-vittangi-resource** INCORRECT: Inferred 40.7 Mt (at about 16.2% Cg) States 8.3 Mt at 22.1% Cg.
- **B-hemerdon-reserve** missed: About 10.3 million mtu of contained WO3 Says the reserve figures give no contained tungsten. That is wrong, because the truth gives about 10.3 million mtu, but no wrong number is stated.
- **B-keliber-reserve** missed: 79.82% attributable: 10.35 Mt, ~248 kt LCE States the 79.82% interest but does not compute the attributable figures.
- **B-dumont-resource** missed: Inferred a further 499.8 Mt at 0.26% Ni 

## Per question (best answer and reason)

| Question | Best | OURS facts | PLAIN facts | WEB facts |
|---|---|---|---|---|
| B-cinovec-npv | OURS | 3/3 | 0/3 | 1/3 |
| B-cinovec-capex-reserve | OURS | 3/3 | 0/3 | 3/3 |
| B-barroso-reserve | TIE | 3/3 | 0/3 | 3/3 |
| B-barroso-econ | OURS | 4/4 | 0/4 | 4/4 |
| B-songwe-econ | OURS | 4/4 | 0/4 | 3/4 |
| B-songwe-reserve | OURS | 3/3 | 0/3 | 1/3 |
| B-hemerdon-reserve | WEB | 2/3 | 0/3 | 3/3 |
| B-hemerdon-econ | OURS | 4/4 | 0/4 | 3/4 |
| B-keliber-econ | OURS | 4/4 | 0/4 | 0/4 |
| B-keliber-reserve | OURS | 2/3 | 0/3 | 0/3 |
| B-dumont-econ | OURS | 4/4 | 1/4 | 3/4 |
| B-dumont-resource | WEB | 2/3 | 0/3 | 2/3 |
| B-vittangi-resource | WEB | 1/4 | 0/4 | 1/4 |
| B-amitsoq-resource | OURS | 3/3 | 0/3 | 2/3 |

## Limits

- One run per question, 32 questions: differences of a few facts are within noise; the intervals above are the guide.
- The judge and every system are Claude models; a judge from another vendor would reduce shared bias.
- The questions were chosen at random from the database and library, or written in advance, but the builder of the assistant also built the question generator and chose its categories.
- Category A and B questions are about our own data and library, so a general model is at a structural disadvantage there; E is the fairness check where it should do well.
- Ours ran with the guard bypass header on the live app; the answers are live, not saved.