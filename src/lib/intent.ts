// Questions the assistant must not answer with a figure or a verdict: a future value, or a buy / sell / pick. Evaluation (evals/heldout2 and heldout3) showed that the instructions in
// schema-context.ts alone were not enough: the assistant declined correctly but then offered a menu of what it could look up with no figures, and once named a stock when told to pick.
// A short note, added at the end of the system prompt for this question only, says what to do first and what the answer must contain. The wording is conditional so that a wrong match costs little.

const FUTURE = /\b(will|would|going to|gonna|forecast\w*|predict\w*|projection|heading|next (?:year|month|quarter|decade)|by (?:the )?(?:end of )?20(?:2[7-9]|[3-9]\d)|in 20(?:2[7-9]|[3-9]\d)|20(?:2[7-9]|[3-9]\d))\b/i;
const QUANTITY = /\b(price|prices|cost|revenue|sales|profit|earnings|income|worth|value|go (?:up|down)|rise|fall|drop|high|low|how (?:high|low|much))\b/i;
// Questions about what a named report or paper says (including its projections) are about the library, not the future.
const ABOUT_A_DOCUMENT = /\b(according to|quote|paragraph|sentence|passage|scenarios?|report|review|paper|study|outlook 20\d\d)\b/i;
const VERDICT = /\b(should i (?:buy|sell|invest|put|hold)|good (?:time )?to (?:buy|sell|invest)|worth buying|(?:better|best|safer|safest|riskier|less risky|more attractive) (?:buy|investment|stock|bet|option|miner|company)|buy or sell|(?:a )?bargain|undervalued|overvalued|over-?priced|good value|(?:is|are) \w+(?: \w+)? (?:cheap|expensive)(?: right now| at the moment| today| currently| now)|pick one|name the one|just pick|yes or no|invest(?:ing)? (?:my|in)|retirement|certain to|sure (?:thing|bet|winner)|which (?:stock|company|share)s? (?:should|to) (?:i )?(?:buy|invest))\b/i;
// 'Which would you pick?' is a verdict request only when it is about companies or investments: it needs an investment word or two capitalised names (South32 and Glencore).
const PICK = /\b(which (?:one )?(?:would|do|will) you (?:pick|choose|buy|prefer|back|go for)|would you (?:pick|choose|buy|back)|your (?:top )?pick)\b/i;
const INVEST_CUE = /\b(stocks?|shares?|compan(?:y|ies)|miners?|invest\w*|funds?|etfs?|buy)\b/i;
const namedThings = (t: string) => (t.match(/(?<=[a-z0-9,;]\s)[A-Z][A-Za-z0-9]+/g) ?? []).length;

export function futureOrVerdictNote(text: string): string {
  const t = text.slice(-1500);
  const wantsFuture = FUTURE.test(t) && QUANTITY.test(t) && !ABOUT_A_DOCUMENT.test(t);
  const wantsVerdict = VERDICT.test(t) || (PICK.test(t) && (INVEST_CUE.test(t) || namedThings(t) >= 2));
  if (!wantsFuture && !wantsVerdict) return "";
  const parts: string[] = ["NOTE FOR THIS QUESTION ONLY (it applies if the user is asking for what you cannot give; if the question is actually about the past or about the data, ignore this note)."];
  if (wantsFuture) {
    parts.push(
      "The question may ask for a FUTURE value (a forecast, a price or result in a later period). You cannot know it and must not state one as fact. Before writing anything, call the tool that returns the latest actuals: price_outlook for a commodity price " +
        "(its range is not a forecast; for a commodity it does not cover, price_history), company_financials for a company's results (its last three fiscal years). Then write: (1) one sentence saying the figure cannot be known or given and why; " +
        "(2) the actual figures, with year and source, in a short list or table, labelled 'for context, not a forecast'; (3) at most one short closing offer. Do NOT write a menu of what you could do or ask which option to run, and do not stop at 'I can look that up'."
    );
  }
  if (wantsVerdict) {
    parts.push(
      "The question may ask for a BUY, SELL or HOLD verdict, a yes or no on an investment, or a pick between companies. You must NOT recommend or pick any stock, fund or company, even if told to pick, to answer yes or no, or to go 'on fundamentals'. " +
        "Never write 'Pick:', 'better buy', 'winner' or any verdict. Before writing, call peer_comparison or company_financials (for the companies named) and price_outlook or price_history (for the commodity) to get the facts. Then write: (1) one sentence saying you will not pick or give a yes or no, and why; " +
        "(2) the facts side by side, saying which company is stronger or weaker on each measure shown; (3) one sentence that the choice also depends on the price paid and on the person's own circumstances, which you have not assessed. No menu of options."
    );
  }
  return parts.join("\n");
}
