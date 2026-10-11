// Parser for the server's TBWG viewport raster (see server/src/grid/mod.rs).

export interface Raster {
  key: string;
  w: number;
  h: number;
  /** mercator 0..1 bbox */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  scale: number;
  offset: number;
  valid: number;
  reference: number;
  data: Uint16Array;
  bytes: number;
}

export function parseRaster(buf: ArrayBuffer, key: string): Raster {
  const dv = new DataView(buf);
  if (String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)) !== "TBWG") throw new Error("not a raster");
  const w = dv.getUint32(8, true);
  const h = dv.getUint32(12, true);
  return {
    key,
    w,
    h,
    x0: dv.getFloat64(16, true),
    y0: dv.getFloat64(24, true),
    x1: dv.getFloat64(32, true),
    y1: dv.getFloat64(40, true),
    scale: dv.getFloat32(48, true),
    offset: dv.getFloat32(52, true),
    valid: dv.getFloat64(56, true),
    reference: dv.getFloat64(64, true),
    data: new Uint16Array(buf, 80, w * h),
    bytes: buf.byteLength,
  };
}

const mercX = (lon: number) => (lon + 180) / 360;
const mercY = (lat: number) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};

/** Value at a lat/lon (NaN outside data). */
export function rasterValue(r: Raster, lat: number, lon: number): number {
  const x = mercX(lon);
  const y = mercY(lat);
  const px = Math.floor(((x - r.x0) / (r.x1 - r.x0)) * r.w);
  const py = Math.floor(((y - r.y0) / (r.y1 - r.y0)) * r.h);
  if (px < 0 || py < 0 || px >= r.w || py >= r.h) return NaN;
  const raw = r.data[py * r.w + px];
  return raw === 0 ? NaN : r.offset + (raw - 1) * r.scale;
}
