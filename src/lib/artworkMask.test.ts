import { describe, expect, it } from "vitest";
import { backgroundMask, maskForTracing, removeBackground } from "./artworkMask";

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

describe("removeBackground", () => {
  // A 12 x 12 image filling its canvas: white page, a black square in the middle with a grey
  // anti-aliased edge, and a white dot inside the square.
  const N = 12;
  function image(): Uint8ClampedArray {
    const px = new Uint8ClampedArray(N * N * 4);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const inner = x >= 4 && x < 8 && y >= 4 && y < 8;
        const rim = x >= 3 && x < 9 && y >= 3 && y < 9 && !inner;
        const v = x === 5 && y === 5 ? 255 : inner ? 0 : rim ? 128 : 255;
        px.set([v, v, v, 255], (y * N + x) * 4);
      }
    }
    return px;
  }
  const at = (px: Uint8ClampedArray, x: number, y: number) => [...px.slice((y * N + x) * 4, (y * N + x) * 4 + 4)];

  it("clears the page, keeps the artwork and the white inside it, and un-blends the rim", () => {
    const px = image();
    expect(removeBackground(px, N, N)).toBe(true);
    expect(at(px, 0, 0)[3]).toBe(0); // page
    expect(at(px, 2, 6)[3]).toBe(0);
    expect(at(px, 6, 6)).toEqual([0, 0, 0, 255]); // artwork
    expect(at(px, 5, 5)).toEqual([255, 255, 255, 255]); // white enclosed by artwork
    // The grey rim was half-blended with white: it becomes black at about half opacity.
    const rim = at(px, 3, 6);
    expect(rim[0]).toBeLessThan(5);
    expect(rim[3]).toBeGreaterThan(120);
    expect(rim[3]).toBeLessThan(135);
  });

  it("leaves an image with no plain background alone", () => {
    const px = new Uint8ClampedArray(N * N * 4);
    for (let i = 0; i < N * N; i++) px.set([(i * 37) % 256, (i * 91) % 256, (i * 13) % 256, 255], i * 4);
    const before = px.slice();
    expect(removeBackground(px, N, N)).toBe(false);
    expect(px).toEqual(before);
  });
});
