# Report-summary pilot set (after-prompt2): assistant vs general models (2026-10-29)

14 questions, frozen 2026-10-29T18:02:22 (SHA-256 72edeb97bcbb…); the truth was written before any system was asked. OURS = the deployed app answering live. Baselines: `claude-sonnet-5-5` with no tools (PLAIN) and with web search (WEB). Judge: `claude-opus-5-5`, blind, random order.

## By category

| Category | System | Facts correct | Incorrect | Absent | Invented specifics | Behaviour pass | Mean quality | Best |
|---|---|---|---|---|---|---|---|---|
| B. Document questions (random passages) (14) | OURS | 42/48 | 3 | 3 | 2 | – | 4.43 | 11 |
| B. Document questions (random passages) (14) | PLAIN | 2/48 | 10 | 36 | 2 | – | 1.86 | 0 |
| B. Document questions (random passages) (14) | WEB | 31/48 | 12 | 5 | 7 | – | 3.36 | 3 |

## Fact accuracy overall (categories A, B, C and E)

| System | Correct | Incorrect | Absent | Invented specifics |
|---|---|---|---|---|
| OURS | 42/48 (88%) | 3 | 3 | 2 |
| PLAIN | 2/48 (4%) | 10 | 36 | 2 |
| WEB | 31/48 (65%) | 12 | 5 | 7 |

OURS minus PLAIN, share of facts correct: 95% interval over questions +69 to +96 points.

OURS minus WEB, share of facts correct: 95% interval over questions +5 to +44 points.

## Where OURS was wrong or missed something

- **B-vittangi-resource** INCORRECT: Total 70.8 Mt at 18.8% Cg containing about 13.3 Mt of graphite Gives the Vittangi total as 35.0 Mt at 23.8% Cg (8.33 Mt). It mentions 70.8 Mt only as a group total that includes other projects.
- **B-vittangi-resource** INCORRECT: Indicated 30.1 Mt at 22.4% Cg States 26.7 Mt at 24.3% Cg.
- **B-vittangi-resource** INCORRECT: Inferred 40.7 Mt (at about 16.2% Cg) States 8.3 Mt at 22.1% Cg.
- **B-hemerdon-reserve** missed: About 10.3 million mtu of contained WO3 Contained metal not stated
- **B-dumont-resource** missed: Inferred a further 499.8 Mt at 0.26% Ni 
- **B-amitsoq-resource** missed: As of October 2026 it is still the current estimate; an update is pending Phase III drilling assays Says no newer estimate is in its records and it cannot confirm one; does not mention the pending update or Phase III.

## Per question (best answer and reason)

| Question | Best | OURS facts | PLAIN facts | WEB facts |
|---|---|---|---|---|
| B-cinovec-npv | OURS | 3/3 | 0/3 | 2/3 |
| B-cinovec-capex-reserve | OURS | 3/3 | 0/3 | 3/3 |
| B-barroso-reserve | OURS | 3/3 | 0/3 | 3/3 |
| B-barroso-econ | OURS | 4/4 | 0/4 | 4/4 |
| B-songwe-econ | OURS | 4/4 | 0/4 | 3/4 |
| B-songwe-reserve | OURS | 3/3 | 0/3 | 2/3 |
| B-hemerdon-reserve | WEB | 2/3 | 0/3 | 3/3 |
| B-hemerdon-econ | OURS | 4/4 | 0/4 | 3/4 |
| B-keliber-econ | OURS | 4/4 | 0/4 | 0/4 |
| B-keliber-reserve | OURS | 3/3 | 0/3 | 0/3 |
| B-dumont-econ | OURS | 4/4 | 1/4 | 3/4 |
| B-dumont-resource | OURS | 2/3 | 1/3 | 2/3 |
| B-vittangi-resource | WEB | 1/4 | 0/4 | 1/4 |
| B-amitsoq-resource | WEB | 2/3 | 0/3 | 2/3 |

## Limits

- One run per question, 32 questions: differences of a few facts are within noise; the intervals above are the guide.
- The judge and every system are Claude models; a judge from another vendor would reduce shared bias.
- The questions were chosen at random from the database and library, or written in advance, but the builder of the assistant also built the question generator and chose its categories.
- Category A and B questions are about our own data and library, so a general model is at a structural disadvantage there; E is the fairness check where it should do well.
- Ours ran with the guard bypass header on the live app; the answers are live, not saved.