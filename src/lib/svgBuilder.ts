import type { DesignResult } from "./design";
import { contoursToPathD, translateContours } from "./geometry";
import { buildRegmarksSVG } from "./regmarks";
import type { SheetSize } from "./sheet";

export const CUT_LINE_COLOR = "#ff0000";

export interface RenderOptions {
  imageDataUrl: string;
  borderColor: string; // fill shown in the margin between artwork edge and cut line (driven by the selected paper type)
  cutStrokeWidthMm: number;
  showBorder: boolean;
}

/** Markup for a single sticker (border fill + image + cut outline), translated so its own bbox origin sits at (x, y). */
function stickerGroup(design: DesignResult, x: number, y: number, opts: RenderOptions, index: number): { print: string; cut: string } {
  const contours = translateContours(design.cutContoursMM, x, y);
  const d = contoursToPathD(contours);
  const img = design.imagePlacementMM;

  const printParts: string[] = [];
  if (opts.showBorder) {
    printParts.push(`<path d="${d}" fill="${opts.borderColor}" fill-rule="evenodd"/>`);
  }
  printParts.push(
    `<image href="${opts.imageDataUrl}" x="${(x + img.x).toFixed(3)}" y="${(y + img.y).toFixed(3)}" width="${img.width.toFixed(3)}" height="${img.height.toFixed(3)}" preserveAspectRatio="none"/>`
  );

  const cut = `<path id="cut-${index}" d="${d}" fill="none" stroke="${CUT_LINE_COLOR}" stroke-width="${opts.cutStrokeWidthMm}"/>`;

  return { print: `<g>${printParts.join("")}</g>`, cut };
}

/** Single-sticker SVG, sized exactly to the sticker's own bounding box. Used for the main preview + single-item export. */
export function buildSingleStickerSVG(design: DesignResult, opts: RenderOptions): string {
  const w = design.actualWmm;
  const h = design.actualHmm;
  const { print, cut } = stickerGroup(design, 0, 0, opts, 0);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}">`,
    `<g id="print">${print}</g>`,
    `<g id="cutlines">${cut}</g>`,
    `</svg>`,
  ].join("");
}

export interface SheetItem {
  design: DesignResult;
  x: number;
  y: number;
  opts: RenderOptions;
}

/** Full-sheet SVG placing each item (possibly different designs) at its packed position. Used for Sheet Preview + sheet export. */
export function buildSheetSVG(items: SheetItem[], sheet: SheetSize, regmarks: false | "standard" | "four_corner" = false): string {
  const prints: string[] = [];
  const cuts: string[] = [];
  items.forEach((item, i) => {
    const { print, cut } = stickerGroup(item.design, item.x, item.y, item.opts, i);
    prints.push(print);
    cuts.push(cut);
  });
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${sheet.widthMm}mm" height="${sheet.heightMm}mm" viewBox="0 0 ${sheet.widthMm} ${sheet.heightMm}">`,
    `<rect x="0" y="0" width="${sheet.widthMm}" height="${sheet.heightMm}" fill="white"/>`,
    `<g id="print">${prints.join("")}</g>`,
    `<g id="cutlines">${cuts.join("")}</g>`,
    regmarks ? buildRegmarksSVG(sheet.widthMm, sheet.heightMm, regmarks === "four_corner") : "",
    `</svg>`,
  ].join("");
}
