# Report-summary pilot set (after-prompt): assistant vs general models (2026-10-29)

14 questions, frozen 2026-10-29T18:02:22 (SHA-256 72edeb97bcbb…); the truth was written before any system was asked. OURS = the deployed app answering live. Baselines: `claude-sonnet-5-5` with no tools (PLAIN) and with web search (WEB). Judge: `claude-opus-5-5`, blind, random order.

## By category

| Category | System | Facts correct | Incorrect | Absent | Invented specifics | Behaviour pass | Mean quality | Best |
|---|---|---|---|---|---|---|---|---|
| B. Document questions (random passages) (14) | OURS | 36/48 | 4 | 8 | 2 | – | 4.14 | 8 |
| B. Document questions (random passages) (14) | PLAIN | 1/48 | 11 | 36 | 2 | – | 1.86 | 0 |
| B. Document questions (random passages) (14) | WEB | 31/48 | 11 | 6 | 6 | – | 3.5 | 6 |

## Fact accuracy overall (categories A, B, C and E)

| System | Correct | Incorrect | Absent | Invented specifics |
|---|---|---|---|---|
| OURS | 36/48 (75%) | 4 | 8 | 2 |
| PLAIN | 1/48 (2%) | 11 | 36 | 2 |
| WEB | 31/48 (65%) | 11 | 6 | 6 |

OURS minus PLAIN, share of facts correct: 95% interval over questions +54 to +89 points.

OURS minus WEB, share of facts correct: 95% interval over questions -9 to +33 points.

## Where OURS was wrong or missed something

- **B-vittangi-resource** INCORRECT: Total 70.8 Mt at 18.8% Cg containing about 13.3 Mt of graphite Gives 35.0 Mt as the Vittangi total and tells the reader not to use 70.8 Mt for Vittangi.
- **B-vittangi-resource** INCORRECT: Indicated 30.1 Mt at 22.4% Cg Says 26.7 Mt at 24.3% Cg.
- **B-vittangi-resource** INCORRECT: Inferred 40.7 Mt (at about 16.2% Cg) Says 8.3 Mt at 22.1% Cg.
- **B-vittangi-resource** INCORRECT: From the October 2023 resource update Says the estimate was effective 20 July 2023.
- **B-barroso-reserve** missed: The reserve used a conservative spodumene (SC6) price assumption of US$1,200/t 
- **B-songwe-reserve** missed: Proven and Probable Mineral Reserve of about 18.1 Mt grading 1.16% TREO Gives the split but explicitly declines to combine it; no total or 1.16% stated
- **B-songwe-reserve** missed: Reserve supported by the 2026 updated DFS (announced 19 March 2026) Gives only an effective date of 30 Apr 2025; no DFS mentioned
- **B-hemerdon-reserve** missed: About 10.3 million mtu of contained WO3 Says no contained-metal figure is stored
- **B-keliber-reserve** missed: Attributable 79.82%: 10.35 Mt, ~248 kt LCE States the 79.82% share but not the attributable tonnage or LCE
- **B-dumont-econ** missed: Plant starts at 52.5 ktpd with a later expansion to double capacity 
- **B-dumont-resource** missed: Inferred a further 499.8 Mt at 0.26% Ni 
- **B-amitsoq-resource** missed: Still current as of Oct 2026; update pending Phase III assays Says no newer estimate was found and it cannot confirm. It does not mention that an update is pending Phase III assays.

## Per question (best answer and reason)

| Question | Best | OURS facts | PLAIN facts | WEB facts |
|---|---|---|---|---|
| B-cinovec-npv | OURS | 3/3 | 0/3 | 2/3 |
| B-cinovec-capex-reserve | OURS | 3/3 | 0/3 | 3/3 |
| B-barroso-reserve | WEB | 2/3 | 0/3 | 3/3 |
| B-barroso-econ | OURS | 4/4 | 0/4 | 4/4 |
| B-songwe-econ | OURS | 4/4 | 0/4 | 3/4 |
| B-songwe-reserve | WEB | 1/3 | 0/3 | 2/3 |
| B-hemerdon-reserve | WEB | 2/3 | 0/3 | 3/3 |
| B-hemerdon-econ | OURS | 4/4 | 0/4 | 3/4 |
| B-keliber-econ | OURS | 4/4 | 0/4 | 0/4 |
| B-keliber-reserve | OURS | 2/3 | 0/3 | 0/3 |
| B-dumont-econ | WEB | 3/4 | 1/4 | 3/4 |
| B-dumont-resource | OURS | 2/3 | 0/3 | 2/3 |
| B-vittangi-resource | WEB | 0/4 | 0/4 | 1/4 |
| B-amitsoq-resource | WEB | 2/3 | 0/3 | 2/3 |

## Limits

- One run per question, 32 questions: differences of a few facts are within noise; the intervals above are the guide.
- The judge and every system are Claude models; a judge from another vendor would reduce shared bias.
- The questions were chosen at random from the database and library, or written in advance, but the builder of the assistant also built the question generator and chose its categories.
- Category A and B questions are about our own data and library, so a general model is at a structural disadvantage there; E is the fairness check where it should do well.
- Ours ran with the guard bypass header on the live app; the answers are live, not saved.