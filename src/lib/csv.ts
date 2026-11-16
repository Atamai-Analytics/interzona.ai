// CSV text for the app's downloads. Every download ends with a credits block: open-licence data (CC BY and similar) must name its publisher wherever it is reused.

export function csvEscape(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  const t = String(v);
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

/** Every table download stops here: no file carries more than this many data rows. */
export const MAX_EXPORT_ROWS = 100;

/** The first MAX_EXPORT_ROWS rows, plus a note line when rows were left out (empty when nothing was cut). */
export function capRows<T>(rows: T[]): { rows: T[]; note: string } {
  if (rows.length <= MAX_EXPORT_ROWS) return { rows, note: "" };
  return {
    rows: rows.slice(0, MAX_EXPORT_ROWS),
    note: `Download limited to the first ${MAX_EXPORT_ROWS} of ${rows.length.toLocaleString("en-US")} rows. Full extracts are not available from the platform.`,
  };
}

export function csvWithCredits(columns: string[], rows: (string | number | null | undefined)[][], credits: string[] = []): string {
  const capped = capRows(rows);
  const lines = [columns, ...capped.rows].map((r) => r.map(csvEscape).join(","));
  const footer = [
    "",
    ...(capped.note ? [csvEscape(capped.note)] : []),
    csvEscape("Compiled by the Interzona Critical Minerals AI Platform from geological survey, company and market data. Check important figures against the original sources."),
    ...(credits.length > 0 ? [csvEscape("Data credits: " + credits.join("; "))] : []),
    csvEscape("Geological survey data are used under their published licences, which require the publisher to be credited if you reuse them."),
  ];
  return "﻿" + [...lines, ...footer].join("\r\n");
}
