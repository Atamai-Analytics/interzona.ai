# Report-summary batch 1 set (before): assistant vs general models (2026-10-30)

10 questions, frozen 2026-10-30T08:17:34 (SHA-256 07b43acb595b…); the truth was written before any system was asked. OURS = the deployed app answering live. Baselines: `claude-sonnet-5-5` with no tools (PLAIN) and with web search (WEB). Judge: `claude-opus-5-5`, blind, random order.

## By category

| Category | System | Facts correct | Incorrect | Absent | Invented specifics | Behaviour pass | Mean quality | Best |
|---|---|---|---|---|---|---|---|---|
| B. Document questions (random passages) (10) | OURS | 16/35 | 2 | 17 | 1 | – | 3.1 | 2 |
| B. Document questions (random passages) (10) | PLAIN | 0/35 | 6 | 29 | 3 | – | 1.8 | 0 |
| B. Document questions (random passages) (10) | WEB | 27/35 | 3 | 5 | 0 | – | 4.3 | 8 |

## Fact accuracy overall (categories A, B, C and E)

| System | Correct | Incorrect | Absent | Invented specifics |
|---|---|---|---|---|
| OURS | 16/35 (46%) | 2 | 17 | 1 |
| PLAIN | 0/35 (0%) | 6 | 29 | 3 |
| WEB | 27/35 (77%) | 3 | 5 | 0 |

OURS minus PLAIN, share of facts correct: 95% interval over questions +21 to +70 points.

OURS minus WEB, share of facts correct: 95% interval over questions -58 to -9 points.

## Where OURS was wrong or missed something

- **B-zinnwald-reserve** INCORRECT: Yes: a maiden Mineral Reserve effective 31 March 2025 from the PFS Says there is no reserve for German Zinnwald
- **B-vulcan-reserve** INCORRECT: Proved 318 kt LCE (first 15 years of production) and Probable 252 kt LCE (years 16-30) Proved 318 kt is right, but Probable is given as 215 kt rather than 252 kt, which does not add up to its own 569 kt total
- **B-zinnwald-reserve** missed: Proven 27.2 Mt and Probable 100.9 Mt, total 128.1 Mt at about 2,056 ppm Li (4,428 ppm Li2O) Gives Cínovec figures instead
- **B-zinnwald-reserve** missed: About 1.4 Mt LCE contained (263 kt Li) 
- **B-vulcan-reserve** missed: From the Phase One Bridging Engineering Study released November 2023 Cites the website and an older DFS, not the Nov 2023 BES
- **B-rovina-econ** missed: Pre-tax NPV US$630 million, IRR 22.7% Only gives pre-tax figures for the 2025 study
- **B-skouries-reserve** missed: Proven and Probable 147.1 Mt at 0.77 g/t Au and 0.50% Cu 
- **B-skouries-reserve** missed: About 3.63 Moz gold and 740 kt copper contained 
- **B-skouries-reserve** missed: Reserves as of 30 September 2021 (2022 feasibility technical report) 
- **B-nevescorvo-reserve** missed: Copper zones: Proven + Probable 21.2 Mt at 2.1% Cu (about 438 kt Cu) 
- **B-nevescorvo-reserve** missed: Zinc zones: Proven + Probable 22.3 Mt at 7.5% Zn (about 1.67 Mt Zn) 
- **B-nevescorvo-reserve** missed: Effective 31 December 2022 (Lundin Mining NI 43-101 report) 
- **B-aguablanca-econ** missed: After-tax NPV (5%) of US$83.1 million with an after-tax IRR of 213% 
- **B-aguablanca-econ** missed: LOM capital costs about US$36.2 million and payback about 1.2 years 
- **B-aguablanca-econ** missed: About a six-year mine life processing about 4.8 Mt underground Gives a six-year underground life but not the 4.8 Mt tonnage
- **B-aguablanca-econ** missed: From Denarius Metals' 2024 pre-feasibility study (NI 43-101) Mentions Denarius but not the PFS
- **B-sarytogan-dfs** missed: Mineral Resource 225 Mt at 29.2% TGC 
- **B-viscaria-fs** missed: Initial capital about SEK 4.5 billion (4,494 MSEK) 
- **B-viscaria-fs** missed: Feasibility study issued 8 May 2025, reported under PERC Says May 2025 only; PERC is not mentioned.

## Per question (best answer and reason)

| Question | Best | OURS facts | PLAIN facts | WEB facts |
|---|---|---|---|---|
| B-chvaletice-econ | WEB | 4/4 | 0/4 | 4/4 |
| B-zinnwald-reserve | WEB | 0/3 | 0/3 | 0/3 |
| B-zinnwald-econ | OURS | 3/3 | 0/3 | 3/3 |
| B-vulcan-reserve | WEB | 1/3 | 0/3 | 3/3 |
| B-rovina-econ | OURS | 3/4 | 0/4 | 3/4 |
| B-skouries-reserve | WEB | 0/3 | 0/3 | 1/3 |
| B-nevescorvo-reserve | WEB | 0/3 | 0/3 | 3/3 |
| B-aguablanca-econ | WEB | 0/4 | 0/4 | 4/4 |
| B-sarytogan-dfs | WEB | 3/4 | 0/4 | 4/4 |
| B-viscaria-fs | WEB | 2/4 | 0/4 | 2/4 |

## Limits

- One run per question, 32 questions: differences of a few facts are within noise; the intervals above are the guide.
- The judge and every system are Claude models; a judge from another vendor would reduce shared bias.
- The questions were chosen at random from the database and library, or written in advance, but the builder of the assistant also built the question generator and chose its categories.
- Category A and B questions are about our own data and library, so a general model is at a structural disadvantage there; E is the fairness check where it should do well.
- Ours ran with the guard bypass header on the live app; the answers are live, not saved.