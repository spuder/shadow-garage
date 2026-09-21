import type { Contour } from "./geometry";
import { boundingBox, scaleContours, translateContours } from "./geometry";
import { computeCutPath, type RawMask } from "./trace";

export interface DesignResult {
  cutContoursMM: Contour[]; // final cut-line polygons, origin at (0,0)
  imagePlacementMM: { x: number; y: number; width: number; height: number }; // where to draw the raster artwork
  actualWmm: number; // the size actually achieved (aspect-preserving, so this can be slightly under the requested target)
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
export function computeDesign(raw: RawMask, targetWmm: number, targetHmm: number, marginMm: number): DesignResult {
  const rawW = raw.rawBBox.maxX - raw.rawBBox.minX;

  // Clamp margin so it never consumes the whole sticker, and never drops below the merge floor.
  const safeMarginMm = Math.max(MIN_MARGIN_MM, Math.min(marginMm, Math.min(targetWmm, targetHmm) * 0.4));

  const innerWmm = Math.max(0.1, targetWmm - 2 * safeMarginMm);
  const scale = innerWmm / rawW; // mm per mask-px, derived from width; height follows from the artwork's own aspect ratio
  const marginPx = safeMarginMm / scale;

  const { contours, bbox } = computeCutPath(raw, marginPx);

  // Move dilated-contour space so its bbox starts at (0,0), then scale to mm.
  let cutMM = translateContours(contours, -bbox.minX, -bbox.minY);
  cutMM = scaleContours(cutMM, scale, scale);

  const dilatedBBoxMM = boundingBox(cutMM);
  const actualWmmRaw = dilatedBBoxMM.maxX - dilatedBBoxMM.minX;
  const actualHmmRaw = dilatedBBoxMM.maxY - dilatedBBoxMM.minY;

  // Exact-fit correction: a single uniform scale (never independent per-axis) so the result
  // always fits within the requested size without ever distorting its proportions.
  const fixScale = Math.min(targetWmm / Math.max(0.001, actualWmmRaw), targetHmm / Math.max(0.001, actualHmmRaw));
  cutMM = scaleContours(cutMM, fixScale, fixScale);

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
  rawMM = scaleContours(rawMM, fixScale, fixScale);
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
