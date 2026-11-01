# Report-summary batch 2 set (before): assistant vs general models (2026-10-30)

5 questions, frozen 2026-10-30T08:41:07 (SHA-256 4250fcc214ab…); the truth was written before any system was asked. OURS = the deployed app answering live. Baselines: `claude-sonnet-5-5` with no tools (PLAIN) and with web search (WEB). Judge: `claude-opus-5-5`, blind, random order.

## By category

| Category | System | Facts correct | Incorrect | Absent | Invented specifics | Behaviour pass | Mean quality | Best |
|---|---|---|---|---|---|---|---|---|
| B. Document questions (random passages) (5) | OURS | 4/18 | 0 | 14 | 0 | – | 2.8 | 1 |
| B. Document questions (random passages) (5) | PLAIN | 0/18 | 3 | 15 | 0 | – | 1.6 | 0 |
| B. Document questions (random passages) (5) | WEB | 8/18 | 1 | 9 | 0 | – | 3.8 | 4 |

## Fact accuracy overall (categories A, B, C and E)

| System | Correct | Incorrect | Absent | Invented specifics |
|---|---|---|---|---|
| OURS | 4/18 (22%) | 0 | 14 | 0 |
| PLAIN | 0/18 (0%) | 3 | 15 | 0 |
| WEB | 8/18 (44%) | 1 | 9 | 0 |

OURS minus PLAIN, share of facts correct: 95% interval over questions +0 to +63 points.

OURS minus WEB, share of facts correct: 95% interval over questions -41 to -5 points.

## Where OURS was wrong or missed something

- **B-lascruces-pmr** missed: Initial capital of about US$846 million (including 14% contingency) Gives 'over €800 million' from the company page, which is roughly consistent but is not the US$846M technical-report figure and does not mention the contingency
- **B-lascruces-pmr** missed: Pre-tax NPV8 of about US$519 million and pre-tax IRR of 17.4% Says no return figures were found
- **B-lascruces-pmr** missed: Combined Proven + Probable reserve about 41.6 Mt at 1.14% Cu (36.6 Mt underground plus 5.0 Mt stockpile) 
- **B-lascruces-pmr** missed: First Quantum NI 43-101 report effective 30 September 2023 
- **B-hautalampi-reserve** missed: Ore Reserve 4.56 Mt at 0.30% Ni, 0.24% Cu and 0.08% Co (Proven 1.87 Mt, Probable 2.69 Mt) 
- **B-hautalampi-reserve** missed: Capital cost about EUR 74.8 million including 15% contingency 
- **B-hautalampi-reserve** missed: NPV at 5% about EUR 58.8 million and IRR 20% 
- **B-hautalampi-reserve** missed: From AFRY's March 2023 JORC pre-feasibility study for FinnCobalt 
- **B-hautalampi-resource** missed: Measured + Indicated 9.33 Mt at 0.28% Ni, 0.19% Cu and 0.07% Co Gives a 2.582 Mt figure from an older source but says its classification is unknown
- **B-hautalampi-resource** missed: Measured 2.81 Mt at 0.35% Ni and Indicated 6.52 Mt at 0.25% Ni 
- **B-hautalampi-resource** missed: Reported at a 0.25% NiEq cut-off, AFRY estimate of 29 September 2022 
- **B-emili-resource** missed: 373 Mt at 1.00% Li2O in total 
- **B-emili-resource** missed: Indicated 210 Mt at 1.01% Li2O and Inferred 163 Mt at 0.99% Li2O 
- **B-emili-resource** missed: Effective 15 November 2023 at a 0.6% Li2O cut-off; no Mineral Reserve declared Says it cannot tell whether a reserve exists

## Per question (best answer and reason)

| Question | Best | OURS facts | PLAIN facts | WEB facts |
|---|---|---|---|---|
| B-touro-pfs | WEB | 4/4 | 0/4 | 4/4 |
| B-lascruces-pmr | OURS | 0/4 | 0/4 | 0/4 |
| B-hautalampi-reserve | WEB | 0/4 | 0/4 | 2/4 |
| B-hautalampi-resource | WEB | 0/3 | 0/3 | 1/3 |
| B-emili-resource | WEB | 0/3 | 0/3 | 1/3 |

## Limits

- One run per question, 32 questions: differences of a few facts are within noise; the intervals above are the guide.
- The judge and every system are Claude models; a judge from another vendor would reduce shared bias.
- The questions were chosen at random from the database and library, or written in advance, but the builder of the assistant also built the question generator and chose its categories.
- Category A and B questions are about our own data and library, so a general model is at a structural disadvantage there; E is the fairness check where it should do well.
- Ours ran with the guard bypass header on the live app; the answers are live, not saved.