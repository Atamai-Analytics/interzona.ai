# Report-summary pilot set (after): assistant vs general models (2026-10-29)

14 questions, frozen 2026-10-29T18:02:22 (SHA-256 72edeb97bcbb…); the truth was written before any system was asked. OURS = the deployed app answering live. Baselines: `claude-sonnet-5-5` with no tools (PLAIN) and with web search (WEB). Judge: `claude-opus-5-5`, blind, random order.

## By category

| Category | System | Facts correct | Incorrect | Absent | Invented specifics | Behaviour pass | Mean quality | Best |
|---|---|---|---|---|---|---|---|---|
| B. Document questions (random passages) (14) | OURS | 40/48 | 4 | 4 | 1 | – | 4.36 | 12 |
| B. Document questions (random passages) (14) | PLAIN | 1/48 | 9 | 38 | 2 | – | 1.86 | 0 |
| B. Document questions (random passages) (14) | WEB | 33/48 | 10 | 5 | 7 | – | 3.43 | 2 |

## Fact accuracy overall (categories A, B, C and E)

| System | Correct | Incorrect | Absent | Invented specifics |
|---|---|---|---|---|
| OURS | 40/48 (83%) | 4 | 4 | 1 |
| PLAIN | 1/48 (2%) | 9 | 38 | 2 |
| WEB | 33/48 (69%) | 10 | 5 | 7 |

OURS minus PLAIN, share of facts correct: 95% interval over questions +63 to +98 points.

OURS minus WEB, share of facts correct: 95% interval over questions -12 to +40 points.

## Where OURS was wrong or missed something

- **B-keliber-reserve** INCORRECT: Syvajarvi plus Rapasaari Proven and Probable Mineral Reserves of 12.96 Mt at 0.97% Li2O on a 100% basis, about 311 kt LCE Gives life-of-mine tonnages of 3.15 + 11.28 = 14.43 Mt in place of the reserve, while admitting it did not retrieve the reserve table. The sum does not match 12.96 Mt.
- **B-vittangi-resource** INCORRECT: Indicated 30.1 Mt at 22.4% Cg States 26.7 Mt at 24.3%
- **B-vittangi-resource** INCORRECT: Inferred 40.7 Mt (at about 16.2% Cg) States 8.3 Mt at 22.1%
- **B-vittangi-resource** INCORRECT: From the October 2023 resource update Says effective 20 July 2023
- **B-hemerdon-reserve** missed: About 10.3 million mtu of contained WO3 Contained mtu not stated.
- **B-keliber-reserve** missed: On Sibanye-Stillwater's 79.82% attributable basis: 10.35 Mt, about 248 kt LCE The 79.82% ownership is correct, but no attributable tonnage is given.
- **B-dumont-econ** missed: Plant starts at 52.5 ktpd with a later expansion to double capacity Mentions a deferred expansion but gives no throughput
- **B-vittangi-resource** missed: Total 70.8 Mt at 18.8% Cg containing about 13.3 Mt of graphite No total given; implied resource is only ~35 Mt

## Per question (best answer and reason)

| Question | Best | OURS facts | PLAIN facts | WEB facts |
|---|---|---|---|---|
| B-cinovec-npv | OURS | 3/3 | 0/3 | 1/3 |
| B-cinovec-capex-reserve | OURS | 3/3 | 0/3 | 3/3 |
| B-barroso-reserve | OURS | 3/3 | 0/3 | 3/3 |
| B-barroso-econ | OURS | 4/4 | 0/4 | 4/4 |
| B-songwe-econ | OURS | 4/4 | 0/4 | 3/4 |
| B-songwe-reserve | OURS | 3/3 | 0/3 | 2/3 |
| B-hemerdon-reserve | WEB | 2/3 | 0/3 | 3/3 |
| B-hemerdon-econ | OURS | 4/4 | 0/4 | 3/4 |
| B-keliber-econ | OURS | 4/4 | 0/4 | 0/4 |
| B-keliber-reserve | OURS | 1/3 | 0/3 | 0/3 |
| B-dumont-econ | OURS | 3/4 | 1/4 | 3/4 |
| B-dumont-resource | OURS | 3/3 | 0/3 | 2/3 |
| B-vittangi-resource | WEB | 0/4 | 0/4 | 4/4 |
| B-amitsoq-resource | OURS | 3/3 | 0/3 | 2/3 |

## Limits

- One run per question, 32 questions: differences of a few facts are within noise; the intervals above are the guide.
- The judge and every system are Claude models; a judge from another vendor would reduce shared bias.
- The questions were chosen at random from the database and library, or written in advance, but the builder of the assistant also built the question generator and chose its categories.
- Category A and B questions are about our own data and library, so a general model is at a structural disadvantage there; E is the fairness check where it should do well.
- Ours ran with the guard bypass header on the live app; the answers are live, not saved.