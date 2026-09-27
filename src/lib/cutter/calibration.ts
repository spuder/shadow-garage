// Print-and-cut calibration: a printed rectangle + centre cross inside the registration marks, and
// the identical geometry as a cut job. Comparing the cut to the print with a ruler gives the
// cutter's real X/Y scale and offset after registration — the measurement needed to diagnose or
// tune print-and-cut on a new model.

import type { Contour } from "../geometry";
import { buildRegmarksSVG } from "../regmarks";
import type { SheetSize } from "../sheet";
import { closeWithOvercut, DEFAULT_OVERCUT_MM } from "./job";

export const CALIBRATION_WIDTH_MM = 140;
export const CALIBRATION_HEIGHT_MM = 200;
const CROSS_ARM_MM = 10;
const LINE_MM = 0.3;

/** The target rectangle, centred on the sheet (well inside the marks' clearance on Letter and A4). */
export function calibrationTarget(sheet: SheetSize) {
  const x = (sheet.widthMm - CALIBRATION_WIDTH_MM) / 2;
  const y = (sheet.heightMm - CALIBRATION_HEIGHT_MM) / 2;
  return { x, y, width: CALIBRATION_WIDTH_MM, height: CALIBRATION_HEIGHT_MM, cx: x + CALIBRATION_WIDTH_MM / 2, cy: y + CALIBRATION_HEIGHT_MM / 2 };
}

/** Cut paths in sheet millimetres: the closed rectangle, then the two cross strokes. */
export function calibrationPaths(sheet: SheetSize, overcutMm = DEFAULT_OVERCUT_MM): Contour[] {
  const { x, y, width, height, cx, cy } = calibrationTarget(sheet);
  const rect: Contour = [
    [x, y],
    [x + width, y],
    [x + width, y + height],
    [x, y + height],
  ];
  return [
    closeWithOvercut(rect, overcutMm),
    [
      [cx - CROSS_ARM_MM, cy],
      [cx + CROSS_ARM_MM, cy],
    ],
    [
      [cx, cy - CROSS_ARM_MM],
      [cx, cy + CROSS_ARM_MM],
    ],
  ];
}

/** Printable calibration sheet: registration marks plus the target drawn as thin black lines. */
export function buildCalibrationSVG(sheet: SheetSize, regmarkStyle: "standard" | "four_corner"): string {
  const { x, y, width, height, cx, cy } = calibrationTarget(sheet);
  const stroke = `fill="none" stroke="black" stroke-width="${LINE_MM}"`;
  const text = (tx: number, ty: number, body: string, extra = "") =>
    `<text x="${tx}" y="${ty}" font-family="Helvetica, Arial, sans-serif" font-size="3.5" text-anchor="middle"${extra}>${body}</text>`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${sheet.widthMm}mm" height="${sheet.heightMm}mm" viewBox="0 0 ${sheet.widthMm} ${sheet.heightMm}">`,
    `<rect x="0" y="0" width="${sheet.widthMm}" height="${sheet.heightMm}" fill="white"/>`,
    `<g id="print">`,
    `<rect x="${x}" y="${y}" width="${width}" height="${height}" ${stroke}/>`,
    `<path d="M${cx - CROSS_ARM_MM},${cy} L${cx + CROSS_ARM_MM},${cy} M${cx},${cy - CROSS_ARM_MM} L${cx},${cy + CROSS_ARM_MM}" ${stroke}/>`,
    text(cx, y - 3, `${width} mm`),
    text(x - 3, cy, `${height} mm`, ` transform="rotate(-90 ${x - 3} ${cy})"`),
    text(cx, cy + 22, "Calibration cut: the blade should follow these lines."),
    text(cx, cy + 27, "If it doesn't, measure the cut rectangle's width and height."),
    `</g>`,
    buildRegmarksSVG(sheet.widthMm, sheet.heightMm, regmarkStyle === "four_corner"),
    `</svg>`,
  ].join("");
}
