import { describe, expect, it } from "vitest";
import type { DesignResult } from "../design";
import type { Contour } from "../geometry";
import { SHEET_SIZES } from "../sheet";
import { buildCutPaths, closeWithOvercut, CutJobError, layoutJob, orderPaths, rotateToNearest } from "./job";
import { modelById } from "./models";

const cameo3 = modelById("silhouette-cameo3")!;
const sheet = (name: string) => SHEET_SIZES.find((s) => s.name === name)!;

const square: Contour = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
];

function designOf(contours: Contour[]): DesignResult {
  return { cutContoursMM: contours, imagePlacementMM: { x: 0, y: 0, width: 10, height: 10 }, actualWmm: 10, actualHmm: 10 };
}

describe("closeWithOvercut", () => {
  it("returns to the start and continues along the first edge", () => {
    expect(closeWithOvercut(square, 1)).toEqual([...square, [0, 0], [1, 0]]);
  });

  it("wraps past a corner when the overcut is longer than the first edge", () => {
    expect(closeWithOvercut(square, 12)).toEqual([...square, [0, 0], [10, 0], [10, 2]]);
  });

  it("doesn't duplicate an explicit closing point", () => {
    expect(closeWithOvercut([...square, [0, 0]], 0)).toEqual([...square, [0, 0]]);
  });
});

describe("path ordering", () => {
  it("starts each outline at the vertex nearest the blade", () => {
    expect(rotateToNearest(square, [11, 11])[0]).toEqual([10, 10]);
  });

  it("visits the nearest outline next", () => {
    const far = square.map(([x, y]) => [x + 100, y] as [number, number]);
    const near = square.map(([x, y]) => [x + 20, y] as [number, number]);
    const ordered = orderPaths([far, square, near]);
    expect(ordered.map((c) => Math.min(...c.map((p) => p[0])))).toEqual([0, 20, 100]);
  });

  it("translates each sticker to its sheet position and closes it", () => {
    const paths = buildCutPaths([{ design: designOf([square]), x: 40, y: 50 }], 0);
    expect(paths).toEqual([[[40, 50], [50, 50], [50, 60], [40, 60], [40, 50]]]);
  });
});

describe("layoutJob", () => {
  it("makes the top-left registration mark the origin", () => {
    const { frame, regmarks } = layoutJob(sheet("Letter"), cameo3, "standard");
    expect(regmarks).toMatchObject({ style: "standard", originXmm: 10, originYmm: 10 });
    expect(regmarks!.widthMm).toBeCloseTo(195.9);
    expect(regmarks!.heightMm).toBeCloseTo(259.4);
    expect(frame.offsetXmm).toBe(-10);
    expect(frame.clip.maxX).toBeCloseTo(195.9);
  });

  it("cuts from the sheet corner without marks", () => {
    const { frame, regmarks } = layoutJob(sheet("A4"), cameo3, false);
    expect(regmarks).toBeNull();
    expect(frame).toEqual({ offsetXmm: 0, offsetYmm: 0, clip: { minX: 0, minY: 0, maxX: 210, maxY: 297 } });
  });

  it("rejects mark styles the model can't read", () => {
    expect(() => layoutJob(sheet("Letter"), cameo3, "four_corner")).toThrow(CutJobError);
  });

  it("rejects sheets bigger than the mat", () => {
    expect(() => layoutJob(sheet("A3"), cameo3, false)).toThrow(/doesn't fit/);
  });
});
