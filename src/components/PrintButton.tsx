"use client";

export function PrintButton() {
  return (
    <button className="rounded border border-gray-400 bg-white px-3 py-1 text-xs text-gray-800 hover:border-blue-600" onClick={() => window.print()}>
      Print / save as PDF
    </button>
  );
}
