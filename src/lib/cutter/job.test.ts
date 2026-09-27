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

describe("sheet to cutter coordinates", () => {
  it("sends a placed sticker at its exact size, mark-relative, axes swapped", async () => {
    const { pathCommands } = await import("./graphtec");
    const sticker: Contour = [
      [0, 0],
      [50, 0],
      [50, 20],
      [0, 20],
    ];
    const paths = buildCutPaths([{ design: designOf([sticker]), x: 40, y: 60 }], 0);
    const { frame } = layoutJob(sheet("Letter"), cameo3, "standard");
    const pts = pathCommands(paths, frame).map((c) => c.slice(1).split(",").map(Number));
    const downs = pts.map((p) => p[0]);
    const acrosses = pts.map((p) => p[1]);
    // 50 x 20 mm = 1000 x 400 SU, starting at ((40-10)*20, (60-10)*20)
    expect(Math.min(...acrosses)).toBe(600);
    expect(Math.max(...acrosses) - Math.min(...acrosses)).toBe(1000);
    expect(Math.min(...downs)).toBe(1000);
    expect(Math.max(...downs) - Math.min(...downs)).toBe(400);
  });
});
