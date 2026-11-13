// Colour scale and canvas rendering for the Geostatistics page grids.
import type { Grid } from "@/lib/geostat/engine";

// Viridis (perceptually uniform, colour-blind safe), 9 stops.
const STOPS: [number, number, number][] = [
  [68, 1, 84], [71, 44, 122], [59, 81, 139], [44, 113, 142], [33, 144, 141], [39, 173, 129], [92, 200, 99], [170, 220, 50], [253, 231, 37],
];

export function rampRgb(t: number): [number, number, number] {
  const u = Math.min(1, Math.max(0, t)) * (STOPS.length - 1);
  const i = Math.min(STOPS.length - 2, Math.floor(u)), f = u - i;
  const a = STOPS[i], b = STOPS[i + 1];
  return [Math.round(a[0] + (b[0] - a[0]) * f), Math.round(a[1] + (b[1] - a[1]) * f), Math.round(a[2] + (b[2] - a[2]) * f)];
}
export const rampCss = (t: number) => { const [r, g, b] = rampRgb(t); return `rgb(${r},${g},${b})`; };
export const RAMP_GRADIENT = `linear-gradient(to right, ${STOPS.map((s, i) => `rgb(${s.join(",")}) ${Math.round((100 * i) / (STOPS.length - 1))}%`).join(", ")})`;

const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));

/** Grid band as a PNG data URL, resampled so that it lines up on a Web Mercator map when stretched over the grid's lon/lat bounds. */
export function gridToDataUrl(grid: Grid, band: Float32Array, lo: number, hi: number, mercator: boolean, maxWidth = 900, alpha = 215): string {
  const scale = Math.max(1, Math.floor(maxWidth / grid.nx));
  const W = grid.nx * scale;
  const yN = mercY(grid.north), yS = mercY(grid.south);
  const H = mercator
    ? Math.max(1, Math.round((W * (yN - yS)) / (((grid.east - grid.west) * Math.PI) / 180)))
    : Math.max(1, Math.round((W * grid.ny) / grid.nx));
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(W, H);
  const span = hi - lo || 1;
  for (let py = 0; py < H; py++) {
    let row: number;
    if (mercator) {
      const m = yN - ((py + 0.5) / H) * (yN - yS);
      const lat = ((2 * Math.atan(Math.exp(m)) - Math.PI / 2) * 180) / Math.PI;
      row = Math.floor((grid.north - lat) / grid.dlat);
    } else row = Math.floor(((py + 0.5) / H) * grid.ny);
    if (row < 0 || row >= grid.ny) continue;
    for (let px = 0; px < W; px++) {
      const v = band[row * grid.nx + Math.floor(px / scale)];
      if (!Number.isFinite(v)) continue;
      const [r, g, b] = rampRgb((v - lo) / span);
      const o = (py * W + px) * 4;
      img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = alpha;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL("image/png");
}

/** Plain (lat-regular) picture of the estimate with the sample locations as small dots, for the AI interpretation. Returns base64 PNG. */
export function gridSnapshotBase64(grid: Grid, lo: number, hi: number, samples: { lon: number; lat: number }[]): string {
  const W = Math.min(640, Math.max(grid.nx, 320));
  const H = Math.max(1, Math.round((W * grid.ny) / grid.nx));
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  const span = hi - lo || 1;
  const sx = W / grid.nx, sy = H / grid.ny;
  for (let r = 0; r < grid.ny; r++) {
    for (let c = 0; c < grid.nx; c++) {
      const v = grid.z[r * grid.nx + c];
      if (!Number.isFinite(v)) continue;
      ctx.fillStyle = rampCss((v - lo) / span);
      ctx.fillRect(Math.floor(c * sx), Math.floor(r * sy), Math.ceil(sx), Math.ceil(sy));
    }
  }
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  for (const s of samples) {
    const x = ((s.lon - grid.west) / (grid.east - grid.west)) * W, y = ((grid.north - s.lat) / (grid.north - grid.south)) * H;
    ctx.fillRect(x - 1, y - 1, 2, 2);
  }
  return canvas.toDataURL("image/png").split(",")[1];
}
