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
