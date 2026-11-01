// CSV text for the app's downloads. Every download ends with a credits block: open-licence data (CC BY and similar) must name its publisher wherever it is reused.

export function csvEscape(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  const t = String(v);
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

export function csvWithCredits(columns: string[], rows: (string | number | null | undefined)[][], credits: string[] = []): string {
  const lines = [columns, ...rows].map((r) => r.map(csvEscape).join(","));
  const footer = [
    "",
    csvEscape("Compiled by the Interzona Critical Minerals AI Assistant from geological survey, company and market data. Check important figures against the original sources."),
    ...(credits.length > 0 ? [csvEscape("Data credits: " + credits.join("; "))] : []),
    csvEscape("Geological survey data are used under their published licences, which require the publisher to be credited if you reuse them."),
  ];
  return "﻿" + [...lines, ...footer].join("\r\n");
}
