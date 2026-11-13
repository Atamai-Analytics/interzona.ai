// Limits and helpers shared by the Geostatistics page (browser) and its API routes (server). No server imports here.

export const MAX_POINTS = 5000;
export const MAX_SPAN_KM = 800;

/** East-west and north-south size of a west/south/east/north box, in km. */
export function spanKm(b: [number, number, number, number]): { ew: number; ns: number } {
  const lat0 = (b[1] + b[3]) / 2;
  return { ew: Math.abs(b[2] - b[0]) * 111.32 * Math.cos((lat0 * Math.PI) / 180), ns: Math.abs(b[3] - b[1]) * 110.574 };
}
