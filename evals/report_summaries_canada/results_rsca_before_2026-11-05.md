# Report-summary Canada set (before): assistant vs general models (2026-11-05)

12 questions, frozen 2026-11-05T20:01:51 (SHA-256 c1321b5db618…); the truth was written before any system was asked. OURS = the deployed app answering live. Baselines: `claude-sonnet-5-5` with no tools (PLAIN) and with web search (WEB). Judge: `claude-opus-5-5`, blind, random order.

## By category

| Category | System | Facts correct | Incorrect | Absent | Invented specifics | Behaviour pass | Mean quality | Best |
|---|---|---|---|---|---|---|---|---|
| B. Document questions (random passages) (12) | OURS | 27/48 | 0 | 21 | 0 | – | 3.5 | 5 |
| B. Document questions (random passages) (12) | PLAIN | 7/48 | 18 | 23 | 6 | – | 1.83 | 0 |
| B. Document questions (random passages) (12) | WEB | 40/48 | 2 | 6 | 1 | – | 4.0 | 7 |

## Fact accuracy overall (categories A, B, C and E)

| System | Correct | Incorrect | Absent | Invented specifics |
|---|---|---|---|---|
| OURS | 27/48 (56%) | 0 | 21 | 0 |
| PLAIN | 7/48 (15%) | 18 | 23 | 6 |
| WEB | 40/48 (83%) | 2 | 6 | 1 |

OURS minus PLAIN, share of facts correct: 95% interval over questions +15 to +67 points.

OURS minus WEB, share of facts correct: 95% interval over questions -52 to -2 points.

## Where OURS was wrong or missed something

- **C-shaakichiuwaanaan-fs** missed: Total development capital ~C$1,978M (~C$1,510M net) Gives only the net figure of ~C$1.5B. The total development capital is missing.
- **C-shaakichiuwaanaan-fs** missed: ~20-year mine life, ~800,000 tpa concentrate Gives 800 ktpa, but says the study's mine life was not available.
- **C-rose-fs** missed: Life of mine of about 19 years at 1.61 Mtpa ore processing Gives only the 2022 figure of 17 years, with a caveat that the 2023 study may differ
- **C-arrow-fs** missed: Probable Mineral Reserve of about 4.58 Mt at 2.37% U3O8 (239.6 Mlb U3O8) 
- **C-arrow-fs** missed: Post-tax NPV8 of C$3,465 million and post-tax IRR of 52.4% at US$50/lb U3O8 
- **C-arrow-fs** missed: Pre-production capital of about C$1.3 billion (C$1,299.9M including pre-commitment costs) Gives C$2,209M from the Major Projects Inventory, which matches the 2024 update, not the feasibility study figure.
- **C-arrow-fs** missed: 11-year mine life producing 233.6 Mlb of recovered U3O8 
- **C-matawinie-fs** missed: Proven and Probable reserves of about 61.7 Mt at 4.23% graphitic carbon Gives 17.3 Mt proven plus 44.3 Mt probable (about 61.6 Mt) but no combined total or 4.23% grade
- **C-matawinie-fs** missed: After-tax NPV8 of about C$238 million and after-tax IRR of 15.8% 
- **C-matawinie-fs** missed: Initial capital cost of about C$421 million for the mine and concentrator 
- **C-matawinie-fs** missed: 25-year life of mine 
- **C-casino-fs** missed: Mill P&P ~1,217 Mt at ~0.19% Cu, 0.22 g/t Au, 0.021% Mo (+~210 Mt heap leach) Gives only the 1.43 Bt combined total and a ~140 Mt proven fragment; no mill P&P tonnage or grades
- **C-moblan-dfs** missed: Probable Mineral Reserve of 34.5 Mt at 1.36% Li2O Gives 34.5 Mt but no grade.
- **C-moblan-dfs** missed: About 300,000 tpa of 6% spodumene concentrate over a 21-year life of mine Production rate is right, but it says the mine life is not given.
- **C-moblan-dfs** missed: Total capex about C$962.5 million Says capex is not given.
- **C-wicheeda-pfs** missed: 15-year open-pit mine life feeding a 5,000 tpd flotation plant Mine life and plant throughput are not mentioned
- **C-marathon-fs** missed: Proven and Probable reserves of about 128.3 Mt at 0.64 g/t Pd and 0.21% Cu 
- **C-marathon-fs** missed: After-tax NPV6 of about C$1.07 billion and IRR of 28% at 3-year trailing prices 
- **C-marathon-fs** missed: Initial capital of about C$992 million gives C$809M from the Major Projects Inventory, clearly attributed to that source
- **C-marathon-fs** missed: Mine life of about 12.5 to 13 years (2025 feasibility study update) 
- **C-nal-expansion** missed: Life of mine of about 20 years 

## Per question (best answer and reason)

| Question | Best | OURS facts | PLAIN facts | WEB facts |
|---|---|---|---|---|
| C-shaakichiuwaanaan-fs | WEB | 2/4 | 0/4 | 4/4 |
| C-rose-fs | WEB | 3/4 | 0/4 | 3/4 |
| C-crawford-fs | OURS | 4/4 | 1/4 | 4/4 |
| C-arrow-fs | WEB | 0/4 | 2/4 | 4/4 |
| C-wheeler-phoenix | OURS | 4/4 | 1/4 | 3/4 |
| C-matawinie-fs | WEB | 0/4 | 1/4 | 3/4 |
| C-casino-fs | WEB | 3/4 | 1/4 | 3/4 |
| C-sisson-fs | OURS | 4/4 | 0/4 | 4/4 |
| C-moblan-dfs | WEB | 1/4 | 0/4 | 3/4 |
| C-wicheeda-pfs | OURS | 3/4 | 0/4 | 3/4 |
| C-marathon-fs | WEB | 0/4 | 1/4 | 4/4 |
| C-nal-expansion | OURS | 3/4 | 0/4 | 2/4 |

## Limits

- One run per question, 32 questions: differences of a few facts are within noise; the intervals above are the guide.
- The judge and every system are Claude models; a judge from another vendor would reduce shared bias.
- The questions were chosen at random from the database and library, or written in advance, but the builder of the assistant also built the question generator and chose its categories.
- Category A and B questions are about our own data and library, so a general model is at a structural disadvantage there; E is the fairness check where it should do well.
- Ours ran with the guard bypass header on the live app; the answers are live, not saved.