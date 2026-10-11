import { describe, expect, it } from "vitest";
import { scaleDesign, type DesignResult } from "./design";

// A 40 x 20 outline whose artwork sits 2 mm in from the left and 1 mm down.
const base: DesignResult = {
  cutContoursMM: [[[0, 0], [40, 0], [40, 20], [0, 20]]],
  imagePlacementMM: { x: 2, y: 1, width: 36, height: 18 },
  actualWmm: 40,
  actualHmm: 20,
};

describe("scaleDesign", () => {
  it("returns the outline as it is at its own size", () => {
    expect(scaleDesign(base, 40, 20)).toEqual(base);
  });

  it("hits the driving axis and lets the other follow when the aspect is kept", () => {
    const byWidth = scaleDesign(base, 20, 99, true, "width");
    expect([byWidth.actualWmm, byWidth.actualHmm]).toEqual([20, 10]);
    expect(byWidth.cutContoursMM[0][2]).toEqual([20, 10]);
    expect(byWidth.imagePlacementMM).toEqual({ x: 1, y: 0.5, width: 18, height: 9 });

    const byHeight = scaleDesign(base, 99, 40, true, "height");
    expect([byHeight.actualWmm, byHeight.actualHmm]).toEqual([80, 40]);
  });

  it("stretches each axis on its own when the aspect is unlocked", () => {
    const stretched = scaleDesign(base, 80, 10, false);
    expect([stretched.actualWmm, stretched.actualHmm]).toEqual([80, 10]);
    expect(stretched.imagePlacementMM).toEqual({ x: 4, y: 0.5, width: 72, height: 9 });
  });
});
