import { maskFromData, rasterizeForMask, type RawMask } from "./trace";

/**
 * Above this share of opaque pixels, artwork counts as having a solid background. Tracing its
 * alpha would only give its rectangle.
 */
const SOLID_FRACTION = 0.97;
/**
 * How far (per channel, 0-255) a pixel may be from the background colour and still be background.
 * Loose enough to take a faint die-line drawn on the page around the artwork (about 35 levels off
 * white in a real Studio file), so the page and its line both go and the paper shows up to the
 * artwork itself. Artwork paler than this right where it meets the page goes with it.
 */
const BACKGROUND_TOLERANCE = 40;
/** Share of the image's edge pixels that must be the background colour for it to count as a plain background. */
const PLAIN_EDGE_FRACTION = 0.9;
const ALPHA_THRESHOLD = 16;

export interface ArtworkMask {
  raw: RawMask;
  /** The traced part's width as a share of the whole image's width. */
  artWidthFraction: number;
}

type Box = NonNullable<RawMask["imageBox"]>;

/** Share of the image box the mask covers. */
function coverage(raw: RawMask, box: Box): number {
  let set = 0;
  for (let y = box.y; y < box.y + box.height; y++) {
    for (let x = box.x; x < box.x + box.width; x++) set += raw.data[y * raw.width + x];
  }
  return set / (box.width * box.height);
}

/** The mask as one to trace from, or null if it is empty or covers (nearly) the whole image. */
function usable(raw: RawMask): ArtworkMask | null {
  const box = raw.imageBox;
  if (!box) return null;
  const c = coverage(raw, box);
  if (c === 0 || c > SOLID_FRACTION) return null;
  return { raw, artWidthFraction: (raw.rawBBox.maxX - raw.rawBBox.minX) / box.width };
}

/**
 * For artwork on a plain background (a white page, as Silhouette Studio files usually have):
 * the mask of everything except that background. The background colour is the most common colour
 * along the image's edge, and only background connected to the edge is removed, so the same
 * colour inside the artwork (white lettering, say) stays part of it. Null when the edge isn't
 * mostly one colour.
 */
export function backgroundMask(pixels: Uint8ClampedArray, width: number, height: number, box: Box): RawMask | null {
  const edge: number[] = [];
  for (let x = box.x; x < box.x + box.width; x++) edge.push(box.y * width + x, (box.y + box.height - 1) * width + x);
  for (let y = box.y; y < box.y + box.height; y++) edge.push(y * width + box.x, y * width + box.x + box.width - 1);

  // The commonest edge colour, to the nearest 8 levels per channel.
  const counts = new Map<number, number>();
  for (const i of edge) {
    const key = ((pixels[i * 4] >> 3) << 10) | ((pixels[i * 4 + 1] >> 3) << 5) | (pixels[i * 4 + 2] >> 3);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const bg = [((top >> 10) & 31) * 8 + 4, ((top >> 5) & 31) * 8 + 4, (top & 31) * 8 + 4];
  const isBackground = (i: number) =>
    pixels[i * 4 + 3] < ALPHA_THRESHOLD ||
    (Math.abs(pixels[i * 4] - bg[0]) <= BACKGROUND_TOLERANCE && Math.abs(pixels[i * 4 + 1] - bg[1]) <= BACKGROUND_TOLERANCE && Math.abs(pixels[i * 4 + 2] - bg[2]) <= BACKGROUND_TOLERANCE);
  if (edge.filter(isBackground).length < edge.length * PLAIN_EDGE_FRACTION) return null;

  // Flood the background in from the canvas edge (the padding around the image is transparent).
  const background = new Uint8Array(width * height);
  const stack: number[] = [];
  const visit = (i: number) => {
    if (!background[i] && isBackground(i)) {
      background[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < width; x++) visit(x), visit((height - 1) * width + x);
  for (let y = 0; y < height; y++) visit(y * width), visit(y * width + width - 1);
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % width;
    if (x > 0) visit(i - 1);
    if (x < width - 1) visit(i + 1);
    if (i >= width) visit(i - width);
    if (i < width * (height - 1)) visit(i + width);
  }
  const data = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i++) data[i] = background[i] ? 0 : 1;
  return maskFromData(data, width, height, box);
}

/**
 * The mask an imported sticker's artwork can be traced from: its transparency, or failing that
 * everything but a plain background. Null when neither gives an outline (a photo edge to edge).
 */
export function maskForTracing(pixels: Uint8ClampedArray, width: number, height: number, box: Box): ArtworkMask | null {
  const alpha = new Uint8Array(width * height);
  for (let i = 0; i < alpha.length; i++) alpha[i] = pixels[i * 4 + 3] >= ALPHA_THRESHOLD ? 1 : 0;
  const byAlpha = usable(maskFromData(alpha, width, height, box));
  if (byAlpha) return byAlpha;
  const byBackground = backgroundMask(pixels, width, height, box);
  return byBackground ? usable(byBackground) : null;
}

/** Largest side the background is removed at; bigger artwork is scaled down to it first. */
const CLEAN_MAX_PX = 4096;

/**
 * Makes the plain background around artwork transparent, in place (RGBA, `width` x `height`):
 * the pixels `backgroundMask` finds become clear, and the ones just inside them are un-blended
 * from the background colour ("colour to alpha"), so no pale fringe is left around the artwork.
 * Returns false, changing nothing, when the image has no plain background.
 */
export function removeBackground(pixels: Uint8ClampedArray, width: number, height: number): boolean {
  const mask = backgroundMask(pixels, width, height, { x: 0, y: 0, width, height });
  if (!mask) return false;
  const bg = backgroundColour(pixels, width, height);
  dropSpecks(mask.data, width, height, Math.max(4, Math.round(width * height * SPECK_FRACTION)));
  const isBackground = (i: number) => mask.data[i] === 0;
  for (let i = 0; i < width * height; i++) {
    if (isBackground(i)) {
      pixels[i * 4 + 3] = 0;
      continue;
    }
    const x = i % width;
    const edge = (x > 0 && isBackground(i - 1)) || (x < width - 1 && isBackground(i + 1)) || (i >= width && isBackground(i - width)) || (i < width * (height - 1) && isBackground(i + width));
    if (!edge) continue;
    let alpha = 0;
    for (let c = 0; c < 3; c++) {
      const v = pixels[i * 4 + c];
      alpha = Math.max(alpha, v > bg[c] ? (v - bg[c]) / Math.max(1, 255 - bg[c]) : (bg[c] - v) / Math.max(1, bg[c]));
    }
    alpha = Math.max(alpha, 1 / 255);
    for (let c = 0; c < 3; c++) pixels[i * 4 + c] = (pixels[i * 4 + c] - bg[c] * (1 - alpha)) / alpha;
    pixels[i * 4 + 3] = Math.round(pixels[i * 4 + 3] * alpha);
  }
  return true;
}

/**
 * Islands of artwork smaller than this share of the image are noise on the page (stray pixels of
 * scanning or compression), not artwork: about 9 x 9 px in a 1448 x 1086 image, well under a full
 * stop in lettering of any size worth printing.
 */
const SPECK_FRACTION = 0.00005;

/** Clears (sets to 0) every 4-connected island of 1s in the mask smaller than `minArea` pixels. */
function dropSpecks(data: Uint8Array, width: number, height: number, minArea: number): void {
  const seen = new Uint8Array(width * height);
  const island: number[] = [];
  for (let start = 0; start < data.length; start++) {
    if (!data[start] || seen[start]) continue;
    island.length = 0;
    seen[start] = 1;
    island.push(start);
    for (let k = 0; k < island.length; k++) {
      const i = island[k];
      const x = i % width;
      for (const j of [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, i - width, i + width]) {
        if (j >= 0 && j < data.length && data[j] && !seen[j]) {
          seen[j] = 1;
          island.push(j);
        }
      }
    }
    if (island.length < minArea) for (const i of island) data[i] = 0;
  }
}

/** The commonest colour along the edge of an image that fills the whole canvas. */
function backgroundColour(pixels: Uint8ClampedArray, width: number, height: number): [number, number, number] {
  const counts = new Map<number, { n: number; sum: [number, number, number] }>();
  const add = (i: number) => {
    const r = pixels[i * 4], g = pixels[i * 4 + 1], b = pixels[i * 4 + 2];
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const e = counts.get(key) ?? { n: 0, sum: [0, 0, 0] };
    e.n++;
    e.sum[0] += r;
    e.sum[1] += g;
    e.sum[2] += b;
    counts.set(key, e);
  };
  for (let x = 0; x < width; x++) add(x), add((height - 1) * width + x);
  for (let y = 0; y < height; y++) add(y * width), add(y * width + width - 1);
  const top = [...counts.values()].sort((a, b) => b.n - a.n)[0];
  return [top.sum[0] / top.n, top.sum[1] / top.n, top.sum[2] / top.n];
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // onload rather than decode(): decode() can wait indefinitely in a page that isn't being drawn.
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("couldn't read the artwork"));
    img.src = src;
  });
}

/**
 * Prepares an imported sticker's artwork: a plain background (a white page, as Studio files
 * usually have) is made transparent, so the paper shows around the artwork as it does around an
 * uploaded PNG, and the mask to trace it from. `mask` is null when there's nothing to trace;
 * `imageDataUrl` is the artwork unchanged unless its background was removed.
 */
export async function prepareImportedArtwork(imageDataUrl: string): Promise<{ imageDataUrl: string; mask: ArtworkMask | null }> {
  let img: HTMLImageElement;
  try {
    img = await loadImage(imageDataUrl);
  } catch {
    return { imageDataUrl, mask: null };
  }
  const small = rasterizeForMask(img);
  const alpha = new Uint8Array(small.width * small.height);
  for (let i = 0; i < alpha.length; i++) alpha[i] = small.pixels[i * 4 + 3] >= ALPHA_THRESHOLD ? 1 : 0;
  const byAlpha = usable(maskFromData(alpha, small.width, small.height, small.imageBox));
  if (byAlpha) return { imageDataUrl, mask: byAlpha };
  const byBackground = backgroundMask(small.pixels, small.width, small.height, small.imageBox);
  if (!byBackground || !usable(byBackground)) return { imageDataUrl, mask: null };

  // Remove the background at full resolution, then trace the result like any transparent artwork.
  const scale = Math.min(1, CLEAN_MAX_PX / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h);
  if (!removeBackground(data.data, w, h)) return { imageDataUrl, mask: null };
  ctx.putImageData(data, 0, 0);
  const cleaned = canvas.toDataURL("image/png");
  const traced = rasterizeForMask(canvas);
  return { imageDataUrl: cleaned, mask: maskForTracing(traced.pixels, traced.width, traced.height, traced.imageBox) };
}
