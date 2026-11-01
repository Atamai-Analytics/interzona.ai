# Assistant vs general model: demo questions (2026-10-27)

Baseline answers: `claude-sonnet-5-5` with no tools (PLAIN) and with web search (WEB). Judge: `claude-opus-5-5`, blind, random order. One run per question (14 questions).

## Ours vs PLAIN: general model, no tools or data

Preferred: ours 14, tie 0, baseline 0 (of 14).

| Score (1-5, mean) | Ours | Baseline |
|---|---|---|
| specificity | 4.86 | 2.71 |
| traceability | 4.29 | 1.21 |
| accuracy | 4.36 | 3.0 |
| honesty about limits | 4.93 | 3.86 |
| usefulness | 4.64 | 2.29 |

| Claims listed | Supported | Contradicted | Specific, not checkable | General |
|---|---|---|---|---|
| Ours | 63 | 0 | 50 | 2 |
| Baseline | 13 | 11 | 40 | 23 |

Could not do what was asked: ours 0, baseline 9.

## Ours vs WEB: general model with web search

Preferred: ours 13, tie 0, baseline 1 (of 14).

| Score (1-5, mean) | Ours | Baseline |
|---|---|---|
| specificity | 4.79 | 3.57 |
| traceability | 4.29 | 2.0 |
| accuracy | 4.5 | 3.07 |
| honesty about limits | 4.93 | 3.71 |
| usefulness | 4.5 | 2.93 |

| Claims listed | Supported | Contradicted | Specific, not checkable | General |
|---|---|---|---|---|
| Ours | 69 | 0 | 36 | 3 |
| Baseline | 18 | 7 | 64 | 14 |

Could not do what was asked: ours 0, baseline 8.

## Per question

| Question | vs PLAIN | vs WEB |
|---|---|---|
| Greenland rare earths: from anomalies to owners | ours | ours |
| Where does Rio Tinto operate? | ours | ours |
| Producing lithium sites in Argentina | ours | ours |
| Who is most exposed to the uranium price? | ours | ours |
| The lithium price cycle: who was resilient? | ours | ours |
| The rare earth value chain | ours | ours |
| Diversified miners against their commodities | ours | ours |
| The best new leads, across every survey | ours | ours |
| What kind of deposit is it? | ours | ours |
| Who controls the supply? | ours | ours |
| What should we assay next? | ours | ours |
| From rock chemistry to recovery | ours | ours |
| An investor memo to send on | ours | web |
| A company snapshot to send on | ours | ours |

## Where the judge found a problem in OUR answers (contradicted claims)

None flagged.

## Reasons given

**Greenland rare earths: from anomalies to owners**
- vs PLAIN (ours): I prefer A. It answers all three parts of the question from the cited sources. It gives quantified geochemical leads from the GEUS screen with coordinates, sample counts and distances to known sites. It names holders with their sources, and it summarises the literature on the geology with figures attributed to Jonsson et al. and the SDSG inventory. It is also frank about its limits: OCR text, internal notes that are not a primary source, uncertain catalogue positions, and an outlier value it says to check. There are two minor problems. The '28 Mt TREO' figure for Kringlerne may misstate ore tonnage as contained oxide. And A says the Ivittuut-area lead sits in different geology, although Ivittuut is part of the Gardar system. B openly says it cannot access the literature, so it could not do the literature part of the task. It falls back on general knowledge that is sensible but untraceable and gives no new targets beyond the known deposits.
- vs WEB (ours): B is the stronger answer. It gives concrete exploration targets taken from the GEUS geochemistry screen, ties each company holding to a named source, and draws the geology from the literature (Jonsson et al., SDSG), citing it throughout. Its caveats are clear: these are single-sample assays, catalogued positions may be off, and the compiled notes are not a primary source. One small slip: B refers to an "Ivittuut-area lead" that does not match its listed leads. A openly admits it could not see the internal literature, so it fails the "our literature" part of the question. It also relies on many unverifiable 2026 news claims and adds no new exploration targets.

**Where does Rio Tinto operate?**
- vs PLAIN (ours): A gives the map and a full table of ownership shares, and it matches the evidence pack (37 assets, 18 with positions). It is also open about which assets cannot be placed and why. B cannot produce a map and works from memory. Several of B's shares are out of date (Diavik, Tiwai Point, MRN and QMM), and the answer is cut off at the end. B does mention some assets that A leaves out, such as Resolution Copper and Alouette, but it is less reliable overall.
- vs WEB (ours): The question asks where the assets are, and B delivers a map. It places the 18 assets that have positions, flags which ones are missing from the map, and gives ownership shares that match the 37-asset evidence pack, including the lithium assets. A cannot draw a map and only groups operations by country. It also wrongly says the lithium assets are not in the data. Some of A's extra assets, such as Alouette and Bécancour, could not be checked against the pack.

**Producing lithium sites in Argentina**
- vs PLAIN (ours): B gives a map from catalogue data. Its 32-record count and its SEGEMAR source match the evidence pack, and it flags possible duplicates and limits on what the status labels mean. It does miss some quirks in the data: Reflejos del Mar appears under both producing and past producing, and some names look garbled, such as 'La Viquitasan Luis'. A could not render a map. It gives approximate salar-centre coordinates from memory and a script, and leaves out all past-producing hard-rock sites. That means it skips half of what was asked.
- vs WEB (ours): A presents a map built from the 32 SEGEMAR catalogue records. Its producing and past-producing counts match the evidence pack, and it flags the likely duplicate records. B cannot show a map. Instead it hands the user Leaflet code whose coordinates are approximate guesses. It plots only district-level markers for past-producing sites, and it appears to list Rincón twice. A is grounded in data and directly does what was asked.

**Who is most exposed to the uranium price?**
- vs PLAIN (ours): I prefer Answer A. It works from actual revenue and price series that match the evidence pack: the year ranges and the Energy Fuels revenue figures check out. It reports R², elasticities, dollar impacts, results with and without a one-year lag, and what happens when outlier years are dropped. It also gives sensible caveats and refers to a chart. Answer B says it can't render the chart, so it doesn't fully do the task. It offers only a text chart and plotting code, and its elasticities are rough figures recalled from memory with no data behind them. B is honest about these limits, but it is much less reliable.
- vs WEB (ours): I prefer B. It answers the revenue-sensitivity question directly and refers to a chart it produced. It runs a quantified regression of revenue against the price (R², elasticity, dollar impact of a 10% move) on the same revenue/price data shown in the evidence pack. The figures I could check match the pack, it names its data sources, and its caveats are clear (short series, association rather than cause, currency conversion).

A could not render a chart and offers text bars instead. It looks at realized prices rather than revenue. It also relies on many 2026 figures the pack does not cover, plus an odd 'price today 90.10' line, and does not cite specific documents for them. Its qualitative ranking may be insightful, but I can't verify it from what is on the page.

**The lithium price cycle: who was resilient?**
- vs PLAIN (ours): B gives exact figures that match the evidence pack and lines up revenue and margins against the USGS price year by year. It also adds cash flow and debt, and its caveats are clear (US GAAP vs IFRS, the US-based price series, one-off items). A works from memory and says so. Its Albemarle figures are right, but it overstates SQM's net income for 2022 and 2023 and its 2022 EBITDA margin, and it cites no sources. Both reach the same verdict, but B is the one an investor could check and rely on.
- vs WEB (ours): I prefer Answer A. It compares a consistent annual lithium price series directly with both companies' revenue, margins, net income, free cash flow and debt. Every figure I checked matches the evidence pack, and A is open about its limits: different accounting standards (US GAAP versus IFRS), one-off items and too few data points for a statistical fit. Answer B mixes price reference points that can't be checked. It says SQM made a net loss in 2024, which the pack contradicts, and its SQM EBITDA figure doesn't match the pack. It also mentions 2026 data without naming a source. Both answers reach the same conclusion, but A is much easier to rely on and to trace back to its sources.

**The rare earth value chain**
- vs PLAIN (ours): A cannot reach the reports. Its answer is cut off and gives approximate figures from memory, one of which (China Northern's revenue) conflicts with the pack. B gives the full revenue and margin table, which matches the pack. It explains clearly why a per-kg comparison is limited, and it summarises several named reports on China's processing share, with honest caveats.
- vs WEB (ours): B's revenue, margin and volume figures match the evidence pack, and it cites several named reports with page sources for China's share of processing. It is also open about the limits of the per-kg comparison. A says it has no access to the user's reports, so it cannot answer the "what our reports say" part. A also uses unsourced 2026 figures, and its claim that China Northern disclosed no volumes conflicts with the pack.

**Diversified miners against their commodities**
- vs PLAIN (ours): Answer A works from memory, stops partway through the Rio Tinto section and never covers assets or ownership. Answer B's earnings and price figures match the evidence pack. It quantifies how closely each company's EBITDA tracks its main commodity price and covers the main assets with ownership stakes for all three companies. It is open about its limits, such as the small number of years and having no output data to rank assets.
- vs WEB (ours): I prefer B. It answers the "how have earnings tracked prices" part over many years, with numbers that match the evidence pack. Every figure I could check is supported: Rio Tinto 2021 and 2025, Glencore's 2022 peak, South32 FY2022 and the missing FY2024. It is also open about its limits: a small sample, no lagged fits, Glencore's EBITDA being a proxy rather than the company's adjusted figure, and no output data to rank assets. Its asset table is fuller, covering alumina, bauxite and Glencore's minor aluminium stakes. A is detailed, but it covers only a single half-year (H1 2026) and those figures can't be checked against the pack. Some of A's ownership stakes come from memory, and it says Glencore has no significant aluminium assets, while B lists its Century Aluminum and Alunorte stakes.

**The best new leads, across every survey**
- vs PLAIN (ours): B produces the requested ranking. Its ranks, coordinates, sample counts and maximum values match the evidence pack, its medians check out against the pack's ratios, and it flags caveats (lead #10's outlier, small Finnish samples, sediment-only Argentine data). Its nearest-site column uses a different measure from the pack (nearest rare earth site rather than nearest occurrence of any kind), but nothing in it is contradicted. A declines the task.
- vs WEB (ours): B gives a ranked list of 12 leads that matches the evidence pack: the rank order, areas, sample counts and maximum values all agree. It also flags its limits honestly, including the outlier-driven cell #10, the small Finnish samples, the thin deposit catalogues and that anomalies are not deposits. A declined to do the task.

**What kind of deposit is it?**
- vs PLAIN (ours): B did the analysis asked for. It filtered samples by lanthanum and compared them with deposit types, and its figures match the evidence pack exactly. It is also open about the weak spots: the small reference group, the method's accuracy, the elements that were not measured, and the difference between ore reference samples and regional rock samples. It names its sources. A said it could not apply the filter and fell back on general published geology. That background may be correct, but none of it can be checked here and it does not answer the question.
- vs WEB (ours): I prefer A. It did what was asked: it filtered the rock samples at La ≥300 ppm and compared their chemistry with known deposit types. Every number in its table matches the evidence pack, and it is open about its limits: a reference group of only 8 deposits, modest accuracy on known deposits, missing elements, and the gap between ore samples and regional rock samples. B said it could not filter the rock samples. It fell back on a stream-sediment study that uses a different cutoff, so it did not do the task, although its broad conclusion (alkaline-igneous rocks) agrees with the pack.

**Who controls the supply?**
- vs PLAIN (ours): Every figure in A matches the USGS 2025 evidence table. A names its source, keeps mining and processing stages apart, and gives fair caveats. B covers more minerals, but its figures are rough, older (2023-24) estimates. Several conflict with the current data (nickel, vanadium, tantalum), and B puts processing-stage minerals like gallium and bismuth into a mining ranking. B also says processing is generally more concentrated than mining without backing it up.
- vs WEB (ours): I prefer A. It answers the mining-concentration question directly with a full ranked table. Every figure in the table matches the USGS 2025 estimates in the evidence pack, the source is named, and the caveats are clear: some company data is withheld, the shares cover only the countries USGS names, and production location is not ownership. B admits its mining shares are approximate figures from memory. Two of them are below the pack (rare earths about 60% against 69.2%, nickel about 60% against 66.7%). B also spends much of the answer on refining and supply risk, which the question didn't ask about.

**What should we assay next?**
- vs PLAIN (ours): I prefer Answer A. It answers the question with numbers from the actual data. It names thallium (Tl) as the best next element to assay and bismuth (Bi) as second, and gives the gain for each with a range. Every figure in its table matches the evidence pack. It also says how much of each element has already been measured, names its sources and states its limits clearly: the gains are small, regional rock samples are not ore, and some elements were not tested. Answer B is a sound textbook exploration checklist. But it never looks at the SGU samples themselves, cites no data and recommends nearly every element. That makes it much less useful for choosing what to assay next.
- vs WEB (ours): A screened the actual SGU samples and gives a ranked, quantified recommendation (Tl, then Bi) that matches the evidence pack exactly. It is also candid about its limits: the gains are small, some elements were not tested, and the reference deposits are ore rather than regional rock samples. B is a sound but generic exploration-geochemistry checklist. It openly says it did not search SGU data, so it does not answer the question for this specific sample set. B does add useful practical advice (digestion, gahnite, QA/QC).

**From rock chemistry to recovery**
- vs PLAIN (ours): A did both parts of the request. It ran the chart on the GTK samples, stated the sample counts and its caveats, and gave a literature summary that cites its sources. Its key literature claims match the evidence pack: by-product-only production, about 80 t of world output, the Bayan Obo route, Nyngan and Kiviniemi. It also labels the internal notes as a secondary source and points out where they disagree with the Nordic report. B said plainly that it could not do either part and offered only general background with no sources, which helps an investor much less.
- vs WEB (ours): B is the better answer. It ran the chart on the Finnish rock data, gave correlations and sample counts with caveats, and drew on the document library with clear citations: USGS, the internal notes (flagged as not a primary source) and the Nordic report. It also noted where its sources disagree on China's share. A did neither part of the task. It refused the chart and said it had no internal literature, then gave a generic summary of public sources with no traceable citations.

**An investor memo to send on**
- vs PLAIN (ours): I prefer A. It delivered an actual memo artifact and a summary built from data it can trace (GEUS samples, coordinates, catalogued occurrences, project holders). Its caveats are frank: single-sample assays, location uncertainty, and the 37%/61% accuracy of the deposit-type match. Its main weakness is that it admits it didn't read the memo page itself, and it gives little market or political context. B is a readable sector overview with plausible facts, but it rests entirely on possibly stale model knowledge and cites no sources. It is also cut off mid-sentence in the bear case. For decisions I can check, A is the more reliable of the two.
- vs WEB (web): The evidence pack only confirms that a memo was built, so almost none of either answer's specifics can be checked against it. I prefer A. It is a complete investor memo covering assets, Tanbreez economics, ownership, permits, financing risks, the Kvanefjeld legal position, catalysts and a positioning view. That gives an investor what they need to decide what to look at next. A also flags early-stage studies and conflicting EXIM sources and says to verify them, but it seldom names specific sources. B gives a link to the memo and sound, well-caveated geochemical screening points tied to the GEUS data. However, B admits it hasn't read the memo, offers no investment framing, and leaves Tanbreez/Critical Metals out of its project holders. That makes it much less useful for an investor.

**A company snapshot to send on**
- vs PLAIN (ours): I prefer B. Its three points on what stands out are tied to figures that the evidence pack confirms: revenue, margin, free cash flow, debt and net income. It also explains how it converted currencies and flags caveats such as the Westinghouse accounting change. Finally, it gives a snapshot link that can be shared, though it admits it has not read the snapshot itself. Its McArthur River timing is slightly misleading, because the suspension began in 2018, not 2021. A gives a readable qualitative one-pager, but it rests on training data with no sources, and its financial figures are vague. A does honestly say its numbers are approximate. Overall, B is the more reliable and checkable answer.
- vs WEB (ours): I prefer B because every figure it gives can be checked, and the checkable ones match the evidence pack: revenue, margins, free cash flow, debt and net income. It explains its currency conversions and is open about its limits, including that it never read the snapshot it links to. A writes a full, polished one-pager with plenty of detail. However, almost none of it can be checked: share prices, Q2 2026 results, guidance and analyst targets. Apart from MarketBeat, it names no sources, and it admits that the sources it used disagree on valuation. That makes A more readable but riskier to send. B delivers the requested snapshot as a link plus a three-line summary I can stand behind.

## Limits

- One run per question; model answers vary run to run.
- The judge and the answers are all Claude models, so a shared bias is possible; a second judge from another vendor would reduce this.
- The evidence pack is only what our answer displayed, so a figure outside it is 'not checkable', not wrong. A general model cannot know our database, so the data questions are lopsided by design; the literature questions are the fairer test.
- The approved saved answers were reviewed by the owner before approval.