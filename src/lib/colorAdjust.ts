/**
 * Colour adjustment for sticker artwork. Inkjet dye ink is translucent and there is no white ink,
 * so on foil/film stocks (holographic, clear) pale tints all but vanish; these controls put more
 * ink down. The on-screen preview uses an SVG filter (fast, live), while print and export bake the
 * same curve into pixels (`bakeColorAdjust`), because browsers may rasterize filtered images at a
 * reduced resolution when printing and many SVG tools ignore filters entirely. Both paths share one
 * lookup table so preview and output match.
 */
export interface ColorAdjust {
  brightness: number; // -100..100: scales every channel by (1 + b/100)
  contrast: number; // -100..100: stretches channels around mid grey
  saturation: number; // -100..100: SVG saturate of (1 + s/100)
  /** 0..100: darkens light colours much more than dark ones (x - t·x², t up to 0.5), so pale tints print without crushing shadows. */
  paleTints: number;
}

export const NO_COLOR_ADJUST: ColorAdjust = { brightness: 0, contrast: 0, saturation: 0, paleTints: 0 };

export const COLOR_ADJUST_KEYS = ["brightness", "contrast", "saturation", "paleTints"] as const;

export function isNoColorAdjust(a: ColorAdjust | undefined): boolean {
  return !a || COLOR_ADJUST_KEYS.every((k) => a[k] === 0);
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** The per-channel tone curve: pale-tint compression, then contrast around mid grey, then brightness. */
export function toneCurve(a: ColorAdjust, x: number): number {
  const t = a.paleTints / 200;
  const c = 1 + a.contrast / 100;
  const b = 1 + a.brightness / 100;
  return clamp01(b * (c * (x - t * x * x) + 0.5 * (1 - c)));
}

const TABLE_SIZE = 65;

/** The tone curve sampled at TABLE_SIZE even steps, as used by feFunc type="table". */
export function toneTable(a: ColorAdjust): number[] {
  return Array.from({ length: TABLE_SIZE }, (_, i) => +toneCurve(a, i / (TABLE_SIZE - 1)).toFixed(4));
}

/** Linear interpolation into the table, exactly as an SVG table transfer function does. */
function lookup(table: number[], x: number): number {
  const n = table.length - 1;
  const pos = clamp01(x) * n;
  const k = Math.min(n - 1, Math.floor(pos));
  return table[k] + (pos - k) * (table[k + 1] - table[k]);
}

/** SVG feColorMatrix type="saturate" as a 3x3 row-major matrix. */
export function saturateMatrix(s: number): number[] {
  return [
    0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s,
    0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s,
    0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s,
  ];
}

export function colorAdjustId(a: ColorAdjust): string {
  // "m" for minus keeps the id a plain XML name, e.g. color-adjust-m10_0_40_60.
  return "color-adjust-" + COLOR_ADJUST_KEYS.map((k) => String(a[k]).replace("-", "m")).join("_");
}

export function colorAdjustFilter(a: ColorAdjust): string {
  const table = toneTable(a).join(" ");
  const fn = (ch: string) => `<feFunc${ch} type="table" tableValues="${table}"/>`;
  return (
    `<filter id="${colorAdjustId(a)}" color-interpolation-filters="sRGB">` +
    `<feColorMatrix type="saturate" values="${+(1 + a.saturation / 100).toFixed(4)}"/>` +
    `<feComponentTransfer>${fn("R")}${fn("G")}${fn("B")}</feComponentTransfer>` +
    `</filter>`
  );
}

/** Applies the adjustment in place to unpremultiplied RGBA bytes (ImageData layout). Alpha is untouched. */
export function applyColorAdjust(data: Uint8ClampedArray, a: ColorAdjust): void {
  const m = saturateMatrix(1 + a.saturation / 100);
  const table = toneTable(a);
  // 8-bit input, so precompute the curve for every possible channel value.
  const lut = new Uint8ClampedArray(1024); // finer than 8-bit, since the saturate step yields non-integer values
  for (let i = 0; i < lut.length; i++) lut[i] = Math.round(lookup(table, i / (lut.length - 1)) * 255);
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
    const sr = clamp01(m[0] * r + m[1] * g + m[2] * b);
    const sg = clamp01(m[3] * r + m[4] * g + m[5] * b);
    const sb = clamp01(m[6] * r + m[7] * g + m[8] * b);
    data[i] = lut[Math.round(sr * (lut.length - 1))];
    data[i + 1] = lut[Math.round(sg * (lut.length - 1))];
    data[i + 2] = lut[Math.round(sb * (lut.length - 1))];
  }
}

/** Print resolution for baked artwork, and a cap so huge stickers don't allocate giant canvases. */
export const BAKE_DPI = 600;
const BAKE_MAX_PX = 6000;

const bakeCache = new Map<string, Promise<string>>();

/**
 * Renders the artwork at BAKE_DPI for its printed size with the adjustment applied, returning a PNG
 * data URL. Raster sources are never upscaled past their own resolution. Cached per input.
 */
export function bakeColorAdjust(imageDataUrl: string, a: ColorAdjust, widthMm: number, heightMm: number): Promise<string> {
  if (isNoColorAdjust(a)) return Promise.resolve(imageDataUrl);
  const key = `${colorAdjustId(a)}|${widthMm.toFixed(2)}x${heightMm.toFixed(2)}|${imageDataUrl}`;
  let result = bakeCache.get(key);
  if (!result) {
    result = bake(imageDataUrl, a, widthMm, heightMm);
    bakeCache.set(key, result);
    if (bakeCache.size > 32) bakeCache.delete(bakeCache.keys().next().value!);
    result.catch(() => bakeCache.delete(key));
  }
  return result;
}

async function bake(imageDataUrl: string, a: ColorAdjust, widthMm: number, heightMm: number): Promise<string> {
  const img = new Image();
  img.src = imageDataUrl;
  await img.decode();
  let w = Math.round((widthMm / 25.4) * BAKE_DPI);
  let h = Math.round((heightMm / 25.4) * BAKE_DPI);
  const isVector = imageDataUrl.startsWith("data:image/svg");
  // Don't upscale a bitmap: past its own pixels it only gets bigger, not sharper.
  const limit = Math.min(isVector ? 1 : img.naturalWidth / w, isVector ? 1 : img.naturalHeight / h, BAKE_MAX_PX / Math.max(w, h), 1);
  w = Math.max(1, Math.round(w * limit));
  h = Math.max(1, Math.round(h * limit));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, w, h);
  const pixels = ctx.getImageData(0, 0, w, h);
  applyColorAdjust(pixels.data, a);
  ctx.putImageData(pixels, 0, 0);
  return canvas.toDataURL("image/png");
}
