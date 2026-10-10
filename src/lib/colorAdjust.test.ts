import { describe, expect, it } from "vitest";
import { applyColorAdjust, NO_COLOR_ADJUST, toneCurve, toneTable } from "./colorAdjust";
import { HOLOGRAPHIC_COLOR_ADJUST } from "./paperTypes";

describe("colour adjustment", () => {
  it("is the identity with no adjustment", () => {
    for (const x of [0, 0.2, 0.5, 0.95, 1]) expect(toneCurve(NO_COLOR_ADJUST, x)).toBeCloseTo(x, 10);
    const px = new Uint8ClampedArray([12, 128, 242, 200]);
    applyColorAdjust(px, NO_COLOR_ADJUST);
    expect([...px]).toEqual([12, 128, 242, 200]);
  });

  it("pale tints darkens light colours far more than dark ones, and stays monotonic", () => {
    const a = { ...NO_COLOR_ADJUST, paleTints: 100 };
    expect(0.95 - toneCurve(a, 0.95)).toBeGreaterThan(0.4);
    expect(0.22 - toneCurve(a, 0.22)).toBeLessThan(0.03);
    const table = toneTable(a);
    for (let i = 1; i < table.length; i++) expect(table[i]).toBeGreaterThanOrEqual(table[i - 1]);
  });

  it("holographic default lifts a near-white tint into printable range without crushing darks", () => {
    expect(toneCurve(HOLOGRAPHIC_COLOR_ADJUST, 0.95)).toBeCloseTo(0.61, 2);
    expect(toneCurve(HOLOGRAPHIC_COLOR_ADJUST, 0.5)).toBeCloseTo(0.38, 2);
    expect(toneCurve(HOLOGRAPHIC_COLOR_ADJUST, 0.22)).toBeGreaterThan(0.18);
  });

  it("baked pixels follow the same table as the preview filter and leave alpha alone", () => {
    const a = { ...HOLOGRAPHIC_COLOR_ADJUST, saturation: 0 }; // grey stays grey without saturation
    const px = new Uint8ClampedArray([242, 242, 242, 77, 0, 0, 0, 255]);
    applyColorAdjust(px, a);
    const expected = Math.round(toneCurve(a, 242 / 255) * 255);
    expect(Math.abs(px[0] - expected)).toBeLessThanOrEqual(1);
    expect(px[0]).toBe(px[1]);
    expect(px[3]).toBe(77);
    expect([...px.slice(4)]).toEqual([0, 0, 0, 255]);
  });

  it("saturation pushes colour away from grey", () => {
    const px = new Uint8ClampedArray([200, 220, 230, 255]);
    applyColorAdjust(px, { ...NO_COLOR_ADJUST, saturation: 50 });
    expect(px[2] - px[0]).toBeGreaterThan(30);
  });
});
