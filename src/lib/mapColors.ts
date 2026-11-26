import type { MapData } from "@/lib/types";

// Group colours shared by the on-screen map and the PDF export: the three anomaly classes get fixed, meaningful colours; any other group
// takes the next palette colour.
const FIXED: Record<string, string> = {
  "New lead (no known occurrence nearby)": "#f59e0b",
  "Near an occurrence of a different commodity": "#a78bfa",
  "Near a known occurrence of this commodity": "#34d399",
};
const PALETTE = ["#60a5fa", "#f472b6", "#fbbf24", "#34d399", "#c084fc", "#fb7185", "#2dd4bf", "#a3e635"];

export function mapGroups(map: MapData): { name: string; n: number; color: string }[] {
  const counts = new Map<string, number>();
  for (const p of map.points) counts.set(p.group, (counts.get(p.group) ?? 0) + 1);
  let i = 0;
  return [...counts.entries()].map(([name, n]) => ({ name, n, color: FIXED[name] ?? PALETTE[i++ % PALETTE.length] }));
}
