import type { Contour } from "./geometry";
import { boundingBox, scaleContours, translateContours } from "./geometry";
import { computeCutPath, type RawMask } from "./trace";

export interface DesignResult {
  cutContoursMM: Contour[]; // final cut-line polygons, origin at (0,0)
  imagePlacementMM: { x: number; y: number; width: number; height: number }; // where to draw the raster artwork
  actualWmm: number; // the size actually achieved — matches the target exactly unless preserveAspect clamped it
  actualHmm: number;
}

// Below this, disconnected parts of the artwork (e.g. separate letters in a wordmark) may not
// reliably fuse into one cuttable outline, and instead each traces its own tiny outline —
// producing an overlapping mess of cut lines and throwing off the size-fit math below. This
// matches real-world die-cutting: a minimum bleed/bridge distance is required to cut a single
// piece around multi-part artwork at all. Kept low (rather than back at the 1mm default) so a
// single connected shape (a photo, a solid logo) can still get a near-zero-margin kiss cut;
// multi-part artwork that needs more bridging just needs a larger margin than this floor.
const MIN_MARGIN_MM = 0.2;

/**
 * Given the raw alpha mask of the uploaded artwork and a target overall sticker size (including the
 * bleed margin), computes the final cut-line contours and the placement rect for the original image,
 * both in millimeters with the origin at the sticker's own top-left corner.
 */
export function computeDesign(
  raw: RawMask,
  targetWmm: number,
  targetHmm: number,
  marginMm: number,
  preserveAspect = true,
  driveBy: "width" | "height" = "width",
  preserveSharpCorners = true
): DesignResult {
  const rawW = raw.rawBBox.maxX - raw.rawBBox.minX;
  const rawH = raw.rawBBox.maxY - raw.rawBBox.minY;

  // Clamp margin so it never consumes the whole sticker, and never drops below the merge floor.
  // (targetWmm/targetHmm are only used here as a rough safety bound, not as a hard constraint —
  // see the driving-axis comment below for why the other axis isn't forced to match them.)
  const safeMarginMm = Math.max(MIN_MARGIN_MM, Math.min(marginMm, Math.min(targetWmm, targetHmm) * 0.4));

  // Margin is a fixed mm amount, so it changes the *aspect ratio* of the overall (artwork+margin)
  // bounding box relative to the artwork alone — more so for smaller stickers, where the margin is
  // a bigger fraction of the total. When preserving aspect, we therefore pick ONE axis to hit
  // exactly (whichever the caller says they're actually editing) and let the other emerge from
  // the real geometry, rather than independently guessing a target for the other axis and forcing
  // a uniform fit to both — that previously caused a systematic undershoot (typing "1.75in" wide
  // could land at "1.53in") whenever the guessed other-axis target didn't match the true result.
  const driveWidth = !preserveAspect || driveBy === "width";
  const scale = driveWidth ? Math.max(0.1, targetWmm - 2 * safeMarginMm) / rawW : Math.max(0.1, targetHmm - 2 * safeMarginMm) / rawH;
  const marginPx = safeMarginMm / scale;

  const { contours, bbox } = computeCutPath(raw, marginPx, undefined, preserveSharpCorners);

  // Move dilated-contour space so its bbox starts at (0,0), then scale to mm.
  let cutMM = translateContours(contours, -bbox.minX, -bbox.minY);
  cutMM = scaleContours(cutMM, scale, scale);

  const dilatedBBoxMM = boundingBox(cutMM);
  const actualWmmRaw = dilatedBBoxMM.maxX - dilatedBBoxMM.minX;
  const actualHmmRaw = dilatedBBoxMM.maxY - dilatedBBoxMM.minY;

  // Exact-fit correction, cleaning up rounding/simplification noise:
  // - preserving aspect: a single uniform factor, computed only from the driving axis, so that
  //   axis lands exactly on target and the other simply follows the true aspect ratio.
  // - not preserving aspect (unlocked): independent per-axis factors, which lets a deliberately
  //   mismatched W/H actually stretch the sticker to fit both exactly.
  let scaleX: number, scaleY: number;
  if (preserveAspect) {
    const driveTarget = driveWidth ? targetWmm : targetHmm;
    const driveActual = driveWidth ? actualWmmRaw : actualHmmRaw;
    scaleX = scaleY = driveTarget / Math.max(0.001, driveActual);
  } else {
    scaleX = targetWmm / Math.max(0.001, actualWmmRaw);
    scaleY = targetHmm / Math.max(0.001, actualHmmRaw);
  }
  cutMM = scaleContours(cutMM, scaleX, scaleY);

  const finalBBoxMM = boundingBox(cutMM);
  const actualWmm = finalBBoxMM.maxX - finalBBoxMM.minX;
  const actualHmm = finalBBoxMM.maxY - finalBBoxMM.minY;

  // Run the raw artwork bbox through the identical transform pipeline to find where the image sits.
  const rawCorners: Contour = [
    [raw.rawBBox.minX, raw.rawBBox.minY],
    [raw.rawBBox.maxX, raw.rawBBox.maxY],
  ];
  let rawMM = translateContours([rawCorners], -bbox.minX, -bbox.minY);
  rawMM = scaleContours(rawMM, scale, scale);
  rawMM = scaleContours(rawMM, scaleX, scaleY);
  const [p0, p1] = rawMM[0];

  return {
    cutContoursMM: cutMM,
    imagePlacementMM: {
      x: p0[0],
      y: p0[1],
      width: p1[0] - p0[0],
      height: p1[1] - p0[1],
    },
    actualWmm,
    actualHmm,
  };
}
