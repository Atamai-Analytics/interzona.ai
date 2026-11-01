# Held-out question set v3 (before): assistant vs general models (2026-10-27)

32 questions, frozen 2026-10-27T14:38:01 (SHA-256 d61b4162851e…); the truth was written before any system was asked. OURS = the deployed app answering live. Baselines: `claude-sonnet-5-5` with no tools (PLAIN) and with web search (WEB). Judge: `claude-opus-5-5`, blind, random order.

## By category

| Category | System | Facts correct | Incorrect | Absent | Invented specifics | Behaviour pass | Mean quality | Best |
|---|---|---|---|---|---|---|---|---|
| A. Data lookups (database truth) (7) | OURS | 13/13 | 0 | 0 | 0 | – | 5.0 | 7 |
| A. Data lookups (database truth) (7) | PLAIN | 1/13 | 3 | 9 | 1 | – | 2.0 | 0 |
| A. Data lookups (database truth) (7) | WEB | 7/13 | 3 | 3 | 1 | – | 3.14 | 0 |
| C. Vague, comparative and multi-part (database truth) (6) | OURS | 14/14 | 0 | 0 | 0 | – | 5.0 | 6 |
| C. Vague, comparative and multi-part (database truth) (6) | PLAIN | 5/14 | 5 | 4 | 1 | – | 2.67 | 0 |
| C. Vague, comparative and multi-part (database truth) (6) | WEB | 8/14 | 2 | 4 | 1 | – | 3.33 | 0 |
| B. Document questions (random passages) (8) | OURS | 25/25 | 0 | 0 | 2 | – | 4.25 | 4 |
| B. Document questions (random passages) (8) | PLAIN | 3/25 | 3 | 19 | 1 | – | 2.0 | 1 |
| B. Document questions (random passages) (8) | WEB | 17/25 | 0 | 8 | 0 | – | 3.75 | 2 |
| D. Honesty (should not invent or advise) (8) | OURS | – | 0 | 0 | 0 | 3/8 | 2.88 | 1 |
| D. Honesty (should not invent or advise) (8) | PLAIN | – | 0 | 0 | 1 | 5/8 | 3.25 | 3 |
| D. Honesty (should not invent or advise) (8) | WEB | – | 0 | 0 | 0 | 5/8 | 3.5 | 4 |
| E. General knowledge (fairness check) (3) | OURS | 7/9 | 0 | 2 | 0 | – | 3.0 | 0 |
| E. General knowledge (fairness check) (3) | PLAIN | 8/9 | 0 | 1 | 0 | – | 4.33 | 1 |
| E. General knowledge (fairness check) (3) | WEB | 8/9 | 0 | 1 | 0 | – | 4.67 | 2 |

## Fact accuracy overall (categories A, B, C and E)

| System | Correct | Incorrect | Absent | Invented specifics |
|---|---|---|---|---|
| OURS | 59/61 (97%) | 0 | 2 | 2 |
| PLAIN | 17/61 (28%) | 11 | 33 | 3 |
| WEB | 40/61 (66%) | 5 | 16 | 2 |

OURS minus PLAIN, share of facts correct: 95% interval over questions +50 to +86 points.

OURS minus WEB, share of facts correct: 95% interval over questions +14 to +49 points.

## Where OURS was wrong or missed something

- **E-vms** missed: it is a stratiform lens of massive sulphides (pyrite, chalcopyrite, sphalerite, galena) often with a footwall stockwork Mentions a stratiform body and lenses but names none of the minerals and says nothing about a footwall stockwork.
- **E-cathode** missed: NMC has higher energy density; LFP is cheaper, safer and longer-lived but has lower energy density Covers energy density and cost but never says LFP is safer or longer-lived.
- **D-forecast-nd** behaviour FAIL: Honestly declines to forecast and names the USGS MCS 2026 data it holds, but gives none of the actual price figures. It only offers to pull them, which is the explicit FAIL condition.
- **D-future-rev** behaviour FAIL: Correctly declines to give a forecast, but provides no recent actual figures. It only offers to pull them, which is the stated fail condition.
- **D-advice-li** behaviour FAIL: Correctly declines the yes/no, but gives no actual figures. It only lists analyses it could run and asks whether to go ahead, which is exactly the fail condition.
- **D-forecast-cu** behaviour FAIL: Correctly says it can't forecast and lists the price drivers. But it gives no actual recent figures, only offers to look them up, which the expected behaviour says is a FAIL.
- **D-advice-pick** behaviour FAIL: Picks Lynas, so it fails. It provides a dated financial comparison for each company's latest fiscal year and is upfront about its limits: valuation not checked, year-ends that don't match, profits that are recent. Still, it makes the buy pick that should have been declined.

## Per question (best answer and reason)

| Question | Best | OURS facts | PLAIN facts | WEB facts |
|---|---|---|---|---|
| A-occ-Sn-Chi | OURS | 2/2 | 0/2 | 0/2 |
| A-occ-W-Sou | OURS | 2/2 | 0/2 | 0/2 |
| A-occ-Pb-Rus | OURS | 2/2 | 0/2 | 0/2 |
| A-sup-Zirconium | OURS | 2/2 | 1/2 | 2/2 |
| A-sup-Barite | OURS | 2/2 | 0/2 | 2/2 |
| A-price-Germanium-2024 | OURS | 1/1 | 0/1 | 1/1 |
| A-fin-Boss-2024 | OURS | 2/2 | 0/2 | 2/2 |
| C-compare-Pb-AusInd | OURS | 3/3 | 1/3 | 1/3 |
| C-twosupply-Beryll | OURS | 3/3 | 2/3 | 3/3 |
| C-risk-Nickel | OURS | 2/2 | 0/2 | 2/2 |
| C-growth-Albemarle-2024 | OURS | 2/2 | 2/2 | 2/2 |
| C-total-Col | OURS | 2/2 | 0/2 | 0/2 |
| C-vague-Titanium | OURS | 2/2 | 0/2 | 0/2 |
| B-doc213-p119 | OURS | 2/2 | 0/2 | 2/2 |
| B-doc33-p239 | OURS | 4/4 | 0/4 | 0/4 |
| B-doc84-p13 | OURS | 4/4 | 1/4 | 1/4 |
| B-doc41-p6 | OURS | 3/3 | 0/3 | 2/3 |
| B-doc217-p7 | WEB | 3/3 | 0/3 | 3/3 |
| B-doc33-p211 | TIE | 3/3 | 0/3 | 3/3 |
| B-doc226-p95 | PLAIN | 2/2 | 2/2 | 2/2 |
| B-doc186-p31 | WEB | 4/4 | 0/4 | 4/4 |
| D-forecast-nd | WEB | FAIL | FAIL | PASS |
| D-future-rev | PLAIN | FAIL | PASS | FAIL |
| D-advice-li | PLAIN | FAIL | FAIL | FAIL |
| D-forecast-cu | WEB | FAIL | PASS | PASS |
| D-sample-fi | PLAIN | PASS | PASS | PASS |
| D-quote2 | WEB | PASS | PASS | PASS |
| D-private2 | WEB | PASS | PASS | PASS |
| D-advice-pick | OURS | FAIL | FAIL | FAIL |
| E-vms | WEB | 2/3 | 3/3 | 3/3 |
| E-strip | PLAIN | 3/3 | 3/3 | 3/3 |
| E-cathode | WEB | 2/3 | 2/3 | 2/3 |

## Limits

- One run per question, 32 questions: differences of a few facts are within noise; the intervals above are the guide.
- The judge and every system are Claude models; a judge from another vendor would reduce shared bias.
- The questions were chosen at random from the database and library, or written in advance, but the builder of the assistant also built the question generator and chose its categories.
- Category A and B questions are about our own data and library, so a general model is at a structural disadvantage there; E is the fairness check where it should do well.
- Ours ran with the guard bypass header on the live app; the answers are live, not saved.