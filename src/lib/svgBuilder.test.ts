import { describe, expect, it } from "vitest";
import { placedCutContours, type DesignResult } from "./design";
import { boundingBox } from "./geometry";
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

  it("keeps the cut lines by default and can leave them out for printing", () => {
    const withLines = buildSheetSVG([], letter, "standard");
    const without = buildSheetSVG([], letter, "standard", false);
    expect(withLines).toContain('<g id="cutlines">');
    expect(without).not.toContain('id="cutlines"');
    expect(without).toContain('<g id="print">');
    expect(without).toContain('<g id="regmarks">');
  });

  it("turns a rotated sticker's cut path and artwork by the same quarter turn", () => {
    // 40 x 20 sticker whose artwork sits 2 mm in from the left and 1 mm down.
    const design: DesignResult = {
      cutContoursMM: [[[0, 0], [40, 0], [40, 20], [0, 20]]],
      imagePlacementMM: { x: 2, y: 1, width: 30, height: 18 },
      actualWmm: 40,
      actualHmm: 20,
    };
    const contours = placedCutContours(design, 100, 50, true);
    expect(boundingBox(contours)).toEqual({ minX: 100, minY: 50, maxX: 120, maxY: 90 });
    expect(contours[0][0]).toEqual([120, 50]); // the sticker's top-left ends up top-right

    const opts = { imageDataUrl: "data:,", borderColor: "#fff", cutStrokeWidthMm: 0.1, showBorder: false };
    const svg = buildSheetSVG([{ design, x: 100, y: 50, rotated: true, opts }], letter);
    expect(svg).toContain('<g transform="translate(120.000 50.000) rotate(90)"><image href="data:," x="2.000" y="1.000"');
    expect(svg).toContain('d="M120.000,50.000 L120.000,90.000 100.000,90.000 100.000,50.000 Z"');
  });

  it("can clip artwork to the cut line, with a clip path of its own for every sticker drawn", () => {
    const design: DesignResult = {
      cutContoursMM: [[[0, 0], [40, 0], [40, 20], [0, 20]]],
      imagePlacementMM: { x: -5, y: -5, width: 50, height: 30 }, // the image is bigger than the sticker
      actualWmm: 40,
      actualHmm: 20,
    };
    const opts = { imageDataUrl: "data:,", borderColor: "#fff", cutStrokeWidthMm: 0.1, showBorder: false };
    expect(buildSheetSVG([{ design, x: 10, y: 10, opts }], letter)).not.toContain("clipPath");

    const item = { design, x: 10, y: 10, opts: { ...opts, clipArtwork: true } };
    const svg = buildSheetSVG([item, { ...item, x: 60 }], letter);
    const ids = [...svg.matchAll(/<clipPath id="([^"]+)"><path d="([^"]+)" clip-rule="evenodd"\/><\/clipPath><g clip-path="url\(#([^)]+)\)"><image /g)];
    expect(ids).toHaveLength(2);
    expect(ids[0][2]).toBe("M10.000,10.000 L50.000,10.000 50.000,30.000 10.000,30.000 Z");
    expect(ids[0][1]).toBe(ids[0][3]);
    expect(ids[1][1]).not.toBe(ids[0][1]);
    // a second build (the copy sent to the printer) must not reuse the first one's ids
    expect(buildSheetSVG([item], letter)).not.toContain(`id="${ids[0][1]}"`);
  });

  it("filters only the artwork when a colour adjustment is set, defining the filter once", () => {
    const design: DesignResult = {
      cutContoursMM: [[[0, 0], [10, 0], [10, 10], [0, 10]]],
      imagePlacementMM: { x: 1, y: 1, width: 8, height: 8 },
      actualWmm: 10,
      actualHmm: 10,
    };
    const colorAdjust = { brightness: -25, contrast: 20, saturation: 40, paleTints: 0 };
    const opts = { imageDataUrl: "data:,", borderColor: "#fff", cutStrokeWidthMm: 0.1, showBorder: true, colorAdjust };
    const svg = buildSheetSVG([{ design, x: 0, y: 0, opts }, { design, x: 20, y: 0, opts }], letter, "standard");
    expect(svg.match(/<filter /g)).toHaveLength(1);
    expect(svg).toContain('<feColorMatrix type="saturate" values="1.4"/>');
    // out = 0.75 * (1.2x - 0.1), clamped: 0 at black, 0.825 at white.
    expect(svg).toMatch(/<feFuncR type="table" tableValues="0 [^"]* 0.825"\/>/);
    expect(svg.match(/<image [^>]*filter="url\(#color-adjust-m25_20_40_0\)"/g)).toHaveLength(2);
    // Border fill, cut lines and marks stay unfiltered so they keep printing white/red/black.
    expect(svg.match(/filter="/g)).toHaveLength(2);

    for (const none of [undefined, { brightness: 0, contrast: 0, saturation: 0, paleTints: 0 }]) {
      const plain = buildSheetSVG([{ design, x: 0, y: 0, opts: { ...opts, colorAdjust: none } }], letter);
      expect(plain).not.toContain("<filter");
      expect(plain).not.toContain("filter=");
    }
  });
});
