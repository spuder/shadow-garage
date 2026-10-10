import { describe, expect, it } from "vitest";
import { isSvgFile } from "./svgArtwork";

describe("isSvgFile", () => {
  it("recognises an SVG by type or by extension", () => {
    expect(isSvgFile({ name: "logo.svg", type: "image/svg+xml" })).toBe(true);
    expect(isSvgFile({ name: "LOGO.SVG", type: "" })).toBe(true);
    expect(isSvgFile({ name: "logo.png", type: "image/png" })).toBe(false);
    expect(isSvgFile({ name: "svg-notes.png", type: "image/png" })).toBe(false);
  });
});
