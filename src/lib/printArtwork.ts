import { applyColorAdjust, BAKE_DPI, isNoColorAdjust, type ColorAdjust } from "./colorAdjust";

/** Largest side of a flattened image, so a huge sticker doesn't allocate a giant canvas. */
const MAX_PX = 6000;
const JPEG_QUALITY = 0.92;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The overlap of two rectangles, or null if they don't overlap. */
export function intersectRect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

const cache = new Map<string, Promise<{ imageDataUrl: string; rect: Rect }>>();

/**
 * The artwork as printed: colour adjustment applied, cropped to the sticker's own box (`box`, the
 * same mm space as `rect`), and flattened onto white as a JPEG, with the rect it now covers.
 *
 * Printing sends no transparency at all. Some printer pipelines (macOS → Epson's inkjet driver)
 * print a page whose preview is correct but leave out every image with transparent pixels, while
 * the plain black registration marks come out. White is no ink on an inkjet, so on paper this
 * looks the same. The crop keeps each opaque rectangle inside its sticker's box, which the packer
 * keeps clear of every other sticker, so it can't cover a neighbour's artwork.
 */
export function flattenForPrint(imageDataUrl: string, adjust: ColorAdjust | undefined, rect: Rect, box: Rect): Promise<{ imageDataUrl: string; rect: Rect }> {
  const crop = intersectRect(rect, box);
  if (!crop) return Promise.resolve({ imageDataUrl, rect });
  const key = [JSON.stringify(adjust ?? null), rect.x, rect.y, rect.width, rect.height, crop.x, crop.y, crop.width, crop.height].map(String).join("|") + imageDataUrl;
  let result = cache.get(key);
  if (!result) {
    result = flatten(imageDataUrl, adjust, rect, crop);
    cache.set(key, result);
    if (cache.size > 64) cache.delete(cache.keys().next().value!);
    result.catch(() => cache.delete(key));
  }
  return result;
}

/**
 * Loads an image. Waits for its load event rather than img.decode(), which never settles in a
 * page that isn't being shown (a background tab, a headless print).
 */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("couldn't load the artwork"));
    img.src = src;
  });
}

async function flatten(imageDataUrl: string, adjust: ColorAdjust | undefined, rect: Rect, crop: Rect): Promise<{ imageDataUrl: string; rect: Rect }> {
  const img = await loadImage(imageDataUrl);
  const isVector = imageDataUrl.startsWith("data:image/svg");
  // Pixels per mm: the print resolution, but no finer than the bitmap's own (upscaling only adds
  // size, not sharpness), and capped so the canvas stays a sane size.
  let pxPerMm = BAKE_DPI / 25.4;
  if (!isVector && img.naturalWidth > 0) pxPerMm = Math.min(pxPerMm, img.naturalWidth / rect.width, img.naturalHeight / rect.height);
  pxPerMm = Math.min(pxPerMm, MAX_PX / Math.max(crop.width, crop.height));
  const w = Math.max(1, Math.round(crop.width * pxPerMm));
  const h = Math.max(1, Math.round(crop.height * pxPerMm));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  const sx = w / crop.width;
  const sy = h / crop.height;
  ctx.drawImage(img, (rect.x - crop.x) * sx, (rect.y - crop.y) * sy, rect.width * sx, rect.height * sy);
  // Adjust the artwork's own colours before the white goes under it, or the white would be tinted too.
  if (adjust && !isNoColorAdjust(adjust)) {
    const pixels = ctx.getImageData(0, 0, w, h);
    applyColorAdjust(pixels.data, adjust);
    ctx.putImageData(pixels, 0, 0);
  }
  ctx.globalCompositeOperation = "destination-over";
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  return { imageDataUrl: canvas.toDataURL("image/jpeg", JPEG_QUALITY), rect: crop };
}

/** Resolves once every image the SVG markup references has loaded, so a print can't start without them. */
export async function decodeImages(svgMarkup: string): Promise<void> {
  const hrefs = new Set([...svgMarkup.matchAll(/<image[^>]*\shref="([^"]+)"/g)].map((m) => m[1]));
  await Promise.all([...hrefs].map((href) => loadImage(href).catch(() => {})));
}
