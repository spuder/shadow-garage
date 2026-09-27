import { describe, expect, it } from "vitest";
import { SHEET_SIZES } from "./sheet";
import { buildSheetSVG } from "./svgBuilder";

const letter = SHEET_SIZES.find((s) => s.name === "Letter")!;

describe("buildSheetSVG", () => {
  it("tags the page rect for on-screen theming while keeping a white fill for exports", () => {
    const pageRect = buildSheetSVG([], letter).match(/<rect [^>]*\/>/)?.[0];
    expect(pageRect).toBeDefined();
    expect(pageRect).toContain('class="sheet-paper"');
    expect(pageRect).toContain('fill="white"');
  });
});
