import { describe, expect, it } from "vitest";
import { boundingBox } from "./geometry";
import type { DesignResult } from "./design";
import { studio3StickerFor } from "./studio3Artwork";

// A 40 x 20 mm sticker whose 36 x 16 mm artwork sits 2 mm in from its outline.
const design: DesignResult = {
  cutContoursMM: [
    [
      [0, 0],
      [40, 0],
      [40, 20],
      [0, 20],
    ],
  ],
  imagePlacementMM: { x: 2, y: 2, width: 36, height: 16 },
  actualWmm: 40,
  actualHmm: 20,
};
const image = { bytes: new Uint8Array(), widthPx: 1, heightPx: 1 };

describe("studio3StickerFor", () => {
  it("places the outline and artwork where the sheet has them", () => {
    const s = studio3StickerFor(design, 100, 50, false, "Logo", image);
    expect(s.name).toBe("Logo");
    expect(s.imageRect).toEqual({ x: 102, y: 52, width: 36, height: 16 });
    expect(boundingBox(s.contours)).toEqual({ minX: 100, minY: 50, maxX: 140, maxY: 70 });
  });

  it("turns a rotated sticker's artwork with its outline", () => {
    const s = studio3StickerFor(design, 100, 50, true, "Logo", image);
    // Turned a quarter turn clockwise it is 20 wide and 40 tall, and the artwork keeps 2 mm all round.
    expect(boundingBox(s.contours)).toEqual({ minX: 100, minY: 50, maxX: 120, maxY: 90 });
    expect(s.imageRect).toEqual({ x: 102, y: 52, width: 16, height: 36 });
  });

  it("keeps an off-centre artwork on the right side when turned", () => {
    const offCentre = { ...design, imagePlacementMM: { x: 1, y: 3, width: 30, height: 10 } };
    const s = studio3StickerFor(offCentre, 0, 0, true, "x", image);
    // The artwork's top edge (3 mm in) ends up on the right: x from 20 - 3 - 10 = 7 to 17.
    expect(s.imageRect).toEqual({ x: 7, y: 1, width: 10, height: 30 });
  });
});
