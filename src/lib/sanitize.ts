// Safety net for the plain-language rule. The instructions tell the model never to show table, column or tool names or
// internal codes; this catches the occasional slip (for example "(is_deposit = true)") before it reaches the user.
// It works on the streamed text, holding back a short tail so that a token split across two chunks is still caught.

const INTERNAL =
  "is_deposit|is_active|NEW_LEAD|NEAR_OTHER_OCCURRENCE|NEAR_KNOWN_COMMODITY|source_document_id|line_items|period_type|operating_income|occurrence_id|sample_id|document_id|company_id|" +
  "run_sql|search_documents|read_document|find_geochemical_anomalies|run_geochem_analysis|run_financial_model|company_financials|peer_comparison|price_history|price_sensitivity|deposit_fingerprint|assay_next|supply_concentration|trade_comparison|price_outlook|rank_leads|investor_memo|operating_data|company_assets|drill_intercepts|get_reference_notes|" +
  "sample_chemistry_wide|hybrid_search|rate_per_usd|DRILLHOLE_INTERVAL|(?:core|geochem|financials|markets|docs|drilling)\\.[a-z_]+";

// An aside in brackets that mentions an internal name, e.g. "(is_deposit = true)" or "(table core.occurrences)": remove it whole.
const ASIDE = new RegExp(`\\s*\\((?:[^()]*?\\b(?:${INTERNAL})\\b[^()]*?)\\)`, "g");

const WORDS: [RegExp, string][] = [
  [/\bis_deposit\b/g, "classed as a deposit"],
  [/\bis_active\b/g, "active"],
  [/\bNEW_LEAD\b/g, "new lead"],
  [/\bNEAR_OTHER_OCCURRENCE\b/g, "near an occurrence of a different commodity"],
  [/\bNEAR_KNOWN_COMMODITY\b/g, "near a known occurrence of this commodity"],
  [/\bPAST_PRODUCER\b/g, "past producing"],
  [/\bPRODUCER\b/g, "producing"],
  [/\bcore\.occurrences\b/g, "the occurrence catalogue"],
  [/\bcore\.companies\b/g, "the company list"],
  [/\bfinancials\.[a-z_]+\b/g, "the company financial statements"],
  [/\bmarkets\.fx_rates\b/g, "the exchange-rate data"],
  [/\bmarkets\.[a-z_]+\b/g, "the commodity price data"],
  [/\bgeochem\.[a-z_]+\b/g, "the sample geochemistry data"],
  [/\bdocs\.[a-z_]+\b/g, "the document library"],
  [/\bdrilling\.[a-z_]+\b/g, "the drill-hole records"],
  [/\bDRILLHOLE_INTERVAL\b/g, "drill-hole interval"],
  [/\b(?:run_sql|search_documents|read_document|find_geochemical_anomalies|run_geochem_analysis|run_financial_model|company_financials|peer_comparison|price_history|price_sensitivity|deposit_fingerprint|assay_next|supply_concentration|trade_comparison|price_outlook|rank_leads|investor_memo|operating_data|company_assets|drill_intercepts|get_reference_notes)\b/g, "our analysis tools"],
  [/\b(?:source_document_id|line_items|period_type|operating_income|occurrence_id|sample_id|document_id|company_id|sample_chemistry_wide|hybrid_search|rate_per_usd)\b/g, "the underlying records"],
];

export function cleanText(text: string): string {
  let t = text.replace(ASIDE, "");
  for (const [re, to] of WORDS) t = t.replace(re, to);
  return t;
}

/** Whether the user asked for technical detail (SQL, how a figure was computed), in which case nothing is rewritten. */
export function wantsTechnicalDetail(userText: string): boolean {
  return /\b(sql|query|queries|select statement|schema|table names?|column names?)\b/i.test(userText);
}

const HOLD = 90;

export function makeSanitizer(enabled: boolean) {
  let buf = "";
  const take = (final: boolean): string => {
    if (!enabled) {
      const out = buf;
      buf = "";
      return out;
    }
    if (final) {
      const out = cleanText(buf);
      buf = "";
      return out;
    }
    if (buf.length <= HOLD) return "";
    // Cut at the last space before the hold-back window, and never inside an open bracket.
    let cut = buf.lastIndexOf(" ", buf.length - HOLD);
    const open = buf.lastIndexOf("(", buf.length - 1);
    const close = buf.lastIndexOf(")", buf.length - 1);
    if (open > close && open < cut) cut = Math.max(0, open - 1);
    if (cut <= 0) return "";
    const out = cleanText(buf.slice(0, cut));
    buf = buf.slice(cut);
    return out;
  };
  return {
    push(delta: string): string {
      buf += delta;
      return take(false);
    },
    flush(): string {
      return take(true);
    },
  };
}
