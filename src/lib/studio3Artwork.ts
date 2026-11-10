// Turns stickers on the sheet into stickers for a .studio3 file: artwork as a PNG, and the
// outline and artwork rectangle on the page.

import { applyColorAdjust, isNoColorAdjust, type ColorAdjust } from "./colorAdjust";
import { placedCutContours, type DesignResult } from "./design";
import type { Studio3NewSticker } from "./studio3";

/** Resolution of the artwork stored in the file, and a cap so huge stickers don't make giant PNGs. */
const STUDIO3_DPI = 300;
const STUDIO3_MAX_PX = 4000;

export type Studio3Image = Studio3NewSticker["image"];

/**
 * The artwork as a PNG for its printed size, with the colour adjustment baked in, as printing
 * bakes it. `rotated` turns it a quarter turn clockwise, as the packer turns a sticker. Bitmaps
 * are never scaled up past their own pixels.
 */
export async function renderArtworkPng(imageDataUrl: string, adjust: ColorAdjust, widthMm: number, heightMm: number, rotated: boolean): Promise<Studio3Image> {
  // onload rather than decode(): decode() can wait indefinitely in a page that isn't being drawn,
  // and drawImage below decodes the image anyway.
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("couldn't read the artwork"));
    img.src = imageDataUrl;
  });
  let w = Math.round((widthMm / 25.4) * STUDIO3_DPI);
  let h = Math.round((heightMm / 25.4) * STUDIO3_DPI);
  const isVector = imageDataUrl.startsWith("data:image/svg");
  const limit = Math.min(isVector ? 1 : img.naturalWidth / w, isVector ? 1 : img.naturalHeight / h, STUDIO3_MAX_PX / Math.max(w, h), 1);
  w = Math.max(1, Math.round(w * limit));
  h = Math.max(1, Math.round(h * limit));

  const canvas = document.createElement("canvas");
  canvas.width = rotated ? h : w;
  canvas.height = rotated ? w : h;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  if (rotated) {
    ctx.translate(h, 0);
    ctx.rotate(Math.PI / 2);
  }
  ctx.drawImage(img, 0, 0, w, h);
  if (!isNoColorAdjust(adjust)) {
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
    applyColorAdjust(pixels.data, adjust);
    ctx.putImageData(pixels, 0, 0);
  }
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("couldn't encode the artwork"))), "image/png"));
  return { bytes: new Uint8Array(await blob.arrayBuffer()), widthPx: canvas.width, heightPx: canvas.height };
}

/**
 * A sticker placed on the sheet with its bounding box's top-left at (x, y), as a new sticker for
 * the file. `image` must be the artwork turned the same way (see renderArtworkPng).
 */
export function studio3StickerFor(design: DesignResult, x: number, y: number, rotated: boolean, name: string, image: Studio3Image): Studio3NewSticker {
  const img = design.imagePlacementMM;
  // Turned a quarter turn clockwise within the box, a point (u, v) of the unturned sticker lands
  // at (x + H - v, y + u), as in svgBuilder's stickerGroup.
  const imageRect = rotated
    ? { x: x + design.actualHmm - img.y - img.height, y: y + img.x, width: img.height, height: img.width }
    : { x: x + img.x, y: y + img.y, width: img.width, height: img.height };
  return { name, image, imageRect, contours: placedCutContours(design, x, y, rotated) };
}
