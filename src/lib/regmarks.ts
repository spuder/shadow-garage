// Silhouette-style print-and-cut registration marks, matching the spec used by
// fablabnbg/inkscape-silhouette's render_silhouette_regmarks.py: a solid square top-left plus
// L-shaped brackets top-right/bottom-left, sized and positioned so a cutter's optical sensor
// (or that project's own detection) can find them and align the cut to what was printed.

import type { KeepoutRect } from "./sheet";

export const REGMARK_ORIGIN_MM = 10; // distance of the mark cluster from each page edge
export const REGMARK_ARM_MM = 20; // length of each L-bracket's arms
export const REGMARK_SQUARE_MM = 5; // size of the solid top-left square
export const REGMARK_STROKE_MM = 0.3; // thinner is measurably more accurate for optical detection

// How much clear space around the sheet edge the marks actually need — packing must stay
// outside this, or printed stickers could overlap and obscure a mark.
export const REGMARK_CLEARANCE_MM = REGMARK_ORIGIN_MM + REGMARK_ARM_MM;

function lMarkPath(cornerX: number, cornerY: number, hDir: 1 | -1, vDir: 1 | -1): string {
  const p1 = `${(cornerX + hDir * REGMARK_ARM_MM).toFixed(3)},${cornerY.toFixed(3)}`;
  const p2 = `${cornerX.toFixed(3)},${cornerY.toFixed(3)}`;
  const p3 = `${cornerX.toFixed(3)},${(cornerY + vDir * REGMARK_ARM_MM).toFixed(3)}`;
  return `<path d="M${p1} L${p2} L${p3}" fill="none" stroke="black" stroke-width="${REGMARK_STROKE_MM}"/>`;
}

/**
 * The marks only occupy small squares at 3 (or 4) corners, not a full-width/height band along
 * every edge — so packing only needs to dodge those specific squares, not shrink the whole
 * usable sheet area in from all four sides uniformly (which wastes a lot of width/height on a
 * page that's much narrower than the 30mm clearance makes it look).
 */
export function getRegmarkKeepoutRects(sheetWidthMm: number, sheetHeightMm: number, fourCorner: boolean): KeepoutRect[] {
  const s = REGMARK_CLEARANCE_MM;
  const rects: KeepoutRect[] = [
    { x: 0, y: 0, w: s, h: s }, // top-left
    { x: sheetWidthMm - s, y: 0, w: s, h: s }, // top-right
    { x: 0, y: sheetHeightMm - s, w: s, h: s }, // bottom-left
  ];
  if (fourCorner) rects.push({ x: sheetWidthMm - s, y: sheetHeightMm - s, w: s, h: s }); // bottom-right
  return rects;
}

/** Registration marks for one sheet, in mm, positioned relative to the sheet's own (0,0) origin. */
export function buildRegmarksSVG(sheetWidthMm: number, sheetHeightMm: number, fourCorner = false): string {
  const regWidth = sheetWidthMm - 2 * REGMARK_ORIGIN_MM;
  const regHeight = sheetHeightMm - 2 * REGMARK_ORIGIN_MM;
  const topRightX = REGMARK_ORIGIN_MM + regWidth;
  const bottomLeftY = REGMARK_ORIGIN_MM + regHeight;

  const parts: string[] = [];
  parts.push(
    fourCorner
      ? lMarkPath(REGMARK_ORIGIN_MM, REGMARK_ORIGIN_MM, 1, 1)
      : `<rect x="${REGMARK_ORIGIN_MM}" y="${REGMARK_ORIGIN_MM}" width="${REGMARK_SQUARE_MM}" height="${REGMARK_SQUARE_MM}" fill="black"/>`
  );
  parts.push(lMarkPath(topRightX, REGMARK_ORIGIN_MM, -1, 1));
  parts.push(lMarkPath(REGMARK_ORIGIN_MM, bottomLeftY, 1, -1));
  if (fourCorner) parts.push(lMarkPath(topRightX, bottomLeftY, -1, -1));

  return `<g id="regmarks">${parts.join("")}</g>`;
}
