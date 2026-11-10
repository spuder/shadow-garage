import { describe, expect, it } from "vitest";
import { intersectRect } from "./printArtwork";

describe("intersectRect", () => {
  it("crops artwork that hangs past the sticker's box to the box", () => {
    expect(intersectRect({ x: -2, y: 1, width: 64, height: 10 }, { x: 0, y: 0, width: 60, height: 12 })).toEqual({ x: 0, y: 1, width: 60, height: 10 });
  });

  it("keeps artwork that already sits inside the box as it is", () => {
    const inside = { x: 1, y: 1, width: 58, height: 10 };
    expect(intersectRect(inside, { x: 0, y: 0, width: 60, height: 12 })).toEqual(inside);
  });

  it("is null when the two don't overlap, including when they only touch", () => {
    expect(intersectRect({ x: 70, y: 0, width: 5, height: 5 }, { x: 0, y: 0, width: 60, height: 12 })).toBeNull();
    expect(intersectRect({ x: 60, y: 0, width: 5, height: 5 }, { x: 0, y: 0, width: 60, height: 12 })).toBeNull();
  });
});
