// Turns the packed sheet (the same SheetItem[] the SVG/PDF export uses) into cutter-ready paths,
// and works out where those paths land on the device.

import type { DesignResult } from "../design";
import { translateContours, type Contour, type Point } from "../geometry";
import { regmarkLayout } from "../regmarks";
import type { SheetSize } from "../sheet";
import type { CutterModel } from "./models";
import type { CutFrame, RegmarkSpec } from "./protocol";

/** Extra distance cut past each outline's start so the blade fully closes the shape. */
export const DEFAULT_OVERCUT_MM = 1;

export class CutJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CutJobError";
  }
}

export interface PlacedDesign {
  design: DesignResult;
  x: number;
  y: number;
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** Drops a trailing point that duplicates the first (some contours arrive explicitly closed). */
function openRing(contour: Contour): Contour {
  if (contour.length > 1 && dist(contour[0], contour[contour.length - 1]) < 1e-9) return contour.slice(0, -1);
  return contour;
}

/** Returns the closed outline as an explicit path: all points, back to the start, then on for overcutMm. */
export function closeWithOvercut(contour: Contour, overcutMm: number): Contour {
  const ring = openRing(contour);
  if (ring.length < 2) return ring.slice();
  const out: Contour = [...ring, ring[0]];
  let remaining = overcutMm;
  for (let i = 0; remaining > 1e-9; i = (i + 1) % ring.length) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const len = dist(a, b);
    if (len === 0) continue;
    if (len >= remaining) {
      const t = remaining / len;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      break;
    }
    out.push(b);
    remaining -= len;
  }
  return out;
}

/** Rotates a closed outline so it starts at the vertex nearest `from` (shorter blade-up travel). */
export function rotateToNearest(contour: Contour, from: Point): Contour {
  const ring = openRing(contour);
  let best = 0;
  for (let i = 1; i < ring.length; i++) {
    if (dist(ring[i], from) < dist(ring[best], from)) best = i;
  }
  return [...ring.slice(best), ...ring.slice(0, best)];
}

/** Greedy nearest-neighbour ordering of closed outlines, starting from the device origin. */
export function orderPaths(contours: Contour[], start: Point = [0, 0]): Contour[] {
  const remaining = contours.filter((c) => c.length >= 2);
  const ordered: Contour[] = [];
  let pos = start;
  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestDist = Infinity;
    remaining.forEach((c, idx) => {
      for (const p of c) {
        const d = dist(p, pos);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = idx;
        }
      }
    });
    const next = rotateToNearest(remaining.splice(bestIdx, 1)[0], pos);
    ordered.push(next);
    pos = next[0]; // a closed outline ends where it started
  }
  return ordered;
}

/** Sheet-space cut paths for every placed sticker, ordered and closed with an overcut. */
export function buildCutPaths(items: PlacedDesign[], overcutMm = DEFAULT_OVERCUT_MM): Contour[] {
  const contours = items.flatMap((it) => translateContours(it.design.cutContoursMM, it.x, it.y));
  return orderPaths(contours).map((c) => closeWithOvercut(c, overcutMm));
}

/** A small square for checking blade settings on a scrap sheet. */
export function testSquarePaths(xMm = 15, yMm = 15, sizeMm = 10, overcutMm = DEFAULT_OVERCUT_MM): Contour[] {
  const square: Contour = [
    [xMm, yMm],
    [xMm + sizeMm, yMm],
    [xMm + sizeMm, yMm + sizeMm],
    [xMm, yMm + sizeMm],
  ];
  return [closeWithOvercut(square, overcutMm)];
}

export interface JobLayout {
  frame: CutFrame;
  regmarks: RegmarkSpec | null;
}

/**
 * Where a sheet's cut paths land on the cutter. With registration marks the cutter finds the
 * printed top-left mark and makes it the device origin, so sheet coordinates shift by the mark
 * origin and must stay inside the marked area. Without marks, the sheet's top-left corner is the
 * device origin (sheet placed top-left on the mat).
 */
export function layoutJob(sheet: SheetSize, model: CutterModel, regmarkStyle: false | "standard" | "four_corner"): JobLayout {
  const eps = 0.01;
  if (sheet.widthMm > model.mat.widthMm + eps || sheet.heightMm > model.mat.heightMm + eps) {
    throw new CutJobError(`A ${sheet.name} sheet doesn't fit on the ${model.name}'s ${(model.mat.widthMm / 25.4).toFixed(0)}×${(model.mat.heightMm / 25.4).toFixed(0)} in mat.`);
  }

  if (!regmarkStyle) {
    return {
      regmarks: null,
      frame: {
        offsetXmm: model.marginLeftMm,
        offsetYmm: model.marginTopMm,
        clip: { minX: 0, minY: 0, maxX: sheet.widthMm, maxY: sheet.heightMm },
      },
    };
  }

  if (model.regmarks === "none") throw new CutJobError(`The ${model.name} can't read registration marks. Turn Registration Marks off.`);
  if (regmarkStyle !== model.regmarks) {
    const wanted = model.regmarks === "standard" ? "Standard (3-mark)" : "Four-corner";
    throw new CutJobError(`The ${model.name} reads ${wanted} registration marks — switch the Registration Marks style and reprint.`);
  }

  const { originMm, widthMm, heightMm } = regmarkLayout(sheet.widthMm, sheet.heightMm);
  return {
    regmarks: { style: regmarkStyle, originXmm: originMm, originYmm: originMm, widthMm, heightMm },
    frame: {
      offsetXmm: -originMm,
      offsetYmm: -originMm,
      clip: { minX: 0, minY: 0, maxX: widthMm, maxY: heightMm },
    },
  };
}
