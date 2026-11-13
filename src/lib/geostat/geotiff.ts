// Minimal GeoTIFF writer for the geostatistics grids: uncompressed, little-endian, float32, one or more bands (planar, one strip per band),
// geographic WGS 84 (EPSG:4326), pixel-is-area, NaN as nodata (GDAL_NODATA tag). Readable by GDAL, QGIS and ArcGIS.

type Tag = { code: number; type: 2 | 3 | 4 | 12; values: number[] | string };
const TYPE_SIZE: Record<number, number> = { 2: 1, 3: 2, 4: 4, 12: 8 };

export function writeGeoTiff(opts: {
  width: number; height: number; bands: Float32Array[]; // each band row-major, row 0 = north
  west: number; north: number; dlon: number; dlat: number;
  description?: string;
}): Uint8Array {
  const { width, height, bands } = opts;
  const nb = bands.length;
  const bandBytes = width * height * 4;
  const tags: Tag[] = [
    { code: 256, type: 4, values: [width] }, // ImageWidth
    { code: 257, type: 4, values: [height] }, // ImageLength
    { code: 258, type: 3, values: Array(nb).fill(32) }, // BitsPerSample
    { code: 259, type: 3, values: [1] }, // Compression: none
    { code: 262, type: 3, values: [1] }, // Photometric: min-is-black
    ...(opts.description ? [{ code: 270, type: 2 as const, values: opts.description }] : []), // ImageDescription
    { code: 273, type: 4, values: [] }, // StripOffsets (filled below)
    { code: 277, type: 3, values: [nb] }, // SamplesPerPixel
    { code: 278, type: 4, values: [height] }, // RowsPerStrip
    { code: 279, type: 4, values: Array(nb).fill(bandBytes) }, // StripByteCounts
    { code: 284, type: 3, values: [2] }, // PlanarConfiguration: separate planes
    ...(nb > 1 ? [{ code: 338, type: 3 as const, values: Array(nb - 1).fill(0) }] : []), // ExtraSamples: unspecified
    { code: 339, type: 3, values: Array(nb).fill(3) }, // SampleFormat: IEEE float
    { code: 33550, type: 12, values: [opts.dlon, opts.dlat, 0] }, // ModelPixelScale
    { code: 33922, type: 12, values: [0, 0, 0, opts.west, opts.north, 0] }, // ModelTiepoint: pixel (0,0) corner -> west/north
    // GeoKeyDirectory: version 1.1.0, 3 keys: GTModelType=Geographic, GTRasterType=PixelIsArea, GeographicType=4326
    { code: 34735, type: 3, values: [1, 1, 0, 3, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326] },
    { code: 42113, type: 2, values: "nan" }, // GDAL_NODATA
  ];
  tags.sort((a, b) => a.code - b.code);

  const count = (t: Tag) => (typeof t.values === "string" ? t.values.length + 1 : t.values.length);
  const ifdSize = 2 + tags.length * 12 + 4;
  let extra = 0; // bytes for values that do not fit in the 4-byte entry
  for (const t of tags) {
    const n = (t.code === 273 ? nb : count(t)) * TYPE_SIZE[t.type];
    if (n > 4) extra += n + (n % 2);
  }
  const headerEnd = 8 + ifdSize + extra;
  const dataStart = headerEnd + ((8 - (headerEnd % 8)) % 8);
  const total = dataStart + nb * bandBytes;
  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  dv.setUint16(0, 0x4949, false); // "II"
  dv.setUint16(2, 42, true);
  dv.setUint32(4, 8, true);
  let p = 8;
  dv.setUint16(p, tags.length, true);
  p += 2;
  let extraPos = 8 + ifdSize;
  for (const t of tags) {
    const vals: number[] | string = t.code === 273 ? Array.from({ length: nb }, (_, i) => dataStart + i * bandBytes) : t.values;
    const n = typeof vals === "string" ? vals.length + 1 : vals.length;
    const size = n * TYPE_SIZE[t.type];
    dv.setUint16(p, t.code, true);
    dv.setUint16(p + 2, t.type, true);
    dv.setUint32(p + 4, n, true);
    const at = size > 4 ? extraPos : p + 8;
    if (size > 4) dv.setUint32(p + 8, extraPos, true);
    if (typeof vals === "string") {
      for (let i = 0; i < vals.length; i++) u8[at + i] = vals.charCodeAt(i) & 0x7f;
      u8[at + vals.length] = 0;
    } else {
      vals.forEach((v, i) => {
        if (t.type === 3) dv.setUint16(at + i * 2, v, true);
        else if (t.type === 4) dv.setUint32(at + i * 4, v, true);
        else dv.setFloat64(at + i * 8, v, true);
      });
    }
    if (size > 4) extraPos += size + (size % 2);
    p += 12;
  }
  dv.setUint32(p, 0, true); // no next IFD
  bands.forEach((band, b) => {
    const off = dataStart + b * bandBytes;
    for (let i = 0; i < band.length; i++) dv.setFloat32(off + i * 4, band[i], true);
  });
  return u8;
}
