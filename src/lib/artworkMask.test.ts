import { describe, expect, it } from "vitest";
import { backgroundMask, maskForTracing } from "./artworkMask";

// A 40 x 40 canvas with the image drawn in the middle 20 x 20 (the rest is transparent padding),
// as rasterizeForMask lays it out.
const W = 40;
const box = { x: 10, y: 10, width: 20, height: 20 };
type RGBA = [number, number, number, number];

function canvas(pixel: (x: number, y: number) => RGBA): Uint8ClampedArray {
  const px = new Uint8ClampedArray(W * W * 4);
  for (let y = box.y; y < box.y + box.height; y++) {
    for (let x = box.x; x < box.x + box.width; x++) px.set(pixel(x - box.x, y - box.y), (y * W + x) * 4);
  }
  return px;
}
const inSquare = (x: number, y: number, from: number, to: number) => x >= from && x < to && y >= from && y < to;
const WHITE: RGBA = [255, 255, 255, 255];
const BLACK: RGBA = [0, 0, 0, 255];

describe("maskForTracing", () => {
  it("traces artwork with a transparent background from its alpha", () => {
    const m = maskForTracing(canvas((x, y) => (inSquare(x, y, 5, 15) ? BLACK : [0, 0, 0, 0])), W, W, box)!;
    expect(m.raw.rawBBox).toEqual({ minX: 15, minY: 15, maxX: 25, maxY: 25 });
    expect(m.artWidthFraction).toBeCloseTo(0.5);
  });

  it("traces artwork on a white page around the artwork, keeping white inside it", () => {
    // A black ring with a white middle, on white.
    const ring = (x: number, y: number): RGBA => (inSquare(x, y, 4, 16) && !inSquare(x, y, 7, 13) ? BLACK : WHITE);
    const m = maskForTracing(canvas(ring), W, W, box)!;
    expect(m.raw.rawBBox).toEqual({ minX: 14, minY: 14, maxX: 26, maxY: 26 });
    expect(m.raw.data[20 * W + 20]).toBe(1); // the white middle is enclosed, so it's artwork
    expect(m.raw.data[11 * W + 11]).toBe(0); // the white page is background
    expect(m.artWidthFraction).toBeCloseTo(0.6);
  });

  it("can't trace a photo that fills the image edge to edge", () => {
    expect(maskForTracing(canvas((x, y) => [x * 12, y * 12, 128, 255]), W, W, box)).toBeNull();
  });

  it("can't trace a plain rectangle with nothing on it", () => {
    expect(maskForTracing(canvas(() => WHITE), W, W, box)).toBeNull();
  });
});

describe("backgroundMask", () => {
  it("tolerates slight noise in the background colour", () => {
    const noisy = (x: number, y: number): RGBA => (inSquare(x, y, 6, 14) ? BLACK : [250 - ((x + y) % 3) * 4, 252, 248, 255]);
    const m = backgroundMask(canvas(noisy), W, W, box)!;
    expect(m.rawBBox).toEqual({ minX: 16, minY: 16, maxX: 24, maxY: 24 });
  });

  it("is null when the image's edge isn't mostly one colour", () => {
    expect(backgroundMask(canvas((x) => (x % 2 ? BLACK : WHITE)), W, W, box)).toBeNull();
  });
});
