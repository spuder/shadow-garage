import { describe, expect, it } from "vitest";
import { boundingBox } from "../geometry";
import { REGMARK_CLEARANCE_MM } from "../regmarks";
import { SHEET_SIZES } from "../sheet";
import { buildCalibrationSVG, calibrationPaths, calibrationTarget } from "./calibration";
import { pathCommands } from "./graphtec";
import { layoutJob } from "./job";
import { modelById } from "./models";

const cameo3 = modelById("silhouette-cameo3")!;

describe("calibration target", () => {
  for (const sheet of SHEET_SIZES.filter((s) => s.name !== "A3")) {
    it(`fits inside the marks' clearance on ${sheet.name}`, () => {
      const t = calibrationTarget(sheet);
      expect(t.x).toBeGreaterThan(REGMARK_CLEARANCE_MM);
      expect(t.y).toBeGreaterThan(REGMARK_CLEARANCE_MM);
      expect(sheet.widthMm - (t.x + t.width)).toBeGreaterThan(REGMARK_CLEARANCE_MM);
      expect(sheet.heightMm - (t.y + t.height)).toBeGreaterThan(REGMARK_CLEARANCE_MM);
      const { frame } = layoutJob(sheet, cameo3, "standard");
      expect(() => pathCommands(calibrationPaths(sheet), frame)).not.toThrow();
    });
  }

  it("cuts exactly the printed rectangle", () => {
    const letter = SHEET_SIZES.find((s) => s.name === "Letter")!;
    const t = calibrationTarget(letter);
    const [rect] = calibrationPaths(letter, 0);
    expect(boundingBox([rect])).toEqual({ minX: t.x, minY: t.y, maxX: t.x + 140, maxY: t.y + 200 });
    expect(buildCalibrationSVG(letter, "standard")).toContain(`<rect x="${t.x}" y="${t.y}" width="140" height="200"`);
  });
});
