// Licence switches that both server and browser code read (no server imports here).

/**
 * World Bank Worldwide Governance Indicators (political stability) in the risk tools. OFF since 25 Nov 2026: the WGI team was asked
 * (20 Nov, resent 22 Nov) to confirm commercial display and has not replied, so the scores are held back until they do. The table now sits
 * in licence_hold.country_governance (a schema the app role cannot read). To switch back on: run the WGI rollback in
 * lithosurfer-work/gold_schema/licence_holds_20261125.sql and set this to true.
 */
export const WGI_ENABLED = false;

/**
 * Saudi Geological Survey stream sediments (SAUDI_SGS_NGD). OFF since 25 Nov 2026: SGS's permission covers "the commercial application
 * you use internally"; whether outside users may see the data was asked on 15 Nov 2026, no reply yet. The data are withheld in the
 * database (results, classifications and wide-table rows moved to schema licence_hold, samples is_active = false; rollback
 * SQL in lithosurfer-work/gold_schema/licence_holds_20261125.sql). To restore: run the rollback, then set this to true.
 */
export const SGS_SAUDI_ENABLED = false;

/**
 * IMF Primary Commodity Prices (IMF_PCPS, 15 monthly series incl. the only monthly uranium, cobalt and palladium prices). OFF since 25 Nov 2026:
 * the IMF terms require permission for commercial reuse (copyright@imf.org; request drafted for the user). Series, prices and outlook rows sit in
 * schema licence_hold; rollback in lithosurfer-work/gold_schema/imf_prices_hold_20261125.sql, then set this to true. The outlook ranges were
 * re-run on the World Bank series (evals/forecast, IMF-based results kept as *_imf_20261027.json).
 */
export const IMF_PRICES_ENABLED = false;

/** Credit for commodity prices shown or downloaded from markets.* (World Bank Pink Sheet is CC BY 4.0; the World Bank names the underlying vendors). */
export const PRICE_CREDIT = IMF_PRICES_ENABLED
  ? "Commodity prices: World Bank Commodity Price Data (The Pink Sheet), CC BY 4.0; IMF Primary Commodity Prices; USGS (public domain)"
  : "Commodity prices: World Bank Commodity Price Data (The Pink Sheet), CC BY 4.0 (underlying quotes from LME, LBMA, Bloomberg, Platts and other providers as credited by the World Bank); USGS Mineral Commodity Summaries and Data Series 140 (public domain)";
