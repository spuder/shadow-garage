import { maskFromData, rasterizeForMask, type RawMask } from "./trace";

/**
 * Above this share of opaque pixels, artwork counts as having a solid background. Tracing its
 * alpha would only give its rectangle.
 */
const SOLID_FRACTION = 0.97;
/** How far (per channel, 0-255) a pixel may be from the background colour and still be background. */
const BACKGROUND_TOLERANCE = 24;
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

/** Loads artwork and returns its mask for tracing, or null if it has nothing to trace or can't be read. */
export function artworkMask(imageDataUrl: string): Promise<ArtworkMask | null> {
  return new Promise((resolve) => {
    const img = new Image();
    // onload rather than decode(): decode() can wait indefinitely in a page that isn't being drawn.
    img.onload = () => {
      const { pixels, width, height, imageBox } = rasterizeForMask(img);
      resolve(maskForTracing(pixels, width, height, imageBox));
    };
    img.onerror = () => resolve(null);
    img.src = imageDataUrl;
  });
}
