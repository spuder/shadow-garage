import { describe, expect, it } from "vitest";
import { getRegmarkKeepoutRects } from "./regmarks";
import { SHEET_SIZES, nudgeIntoArea, packMixedSheet, stickerKeepout, type KeepoutRect, type MixedItem, type MixedPlacement, type SheetSize } from "./sheet";

const letter = SHEET_SIZES.find((s) => s.name === "Letter")!;
const a3 = SHEET_SIZES.find((s) => s.name === "A3")!;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function boxes(items: MixedItem[], placements: MixedPlacement[]): Box[] {
  return placements.map((p) => {
    const it = items.find((i) => i.id === p.id)!;
    return { x: p.x, y: p.y, w: p.rotated ? it.heightMm : it.widthMm, h: p.rotated ? it.widthMm : it.heightMm };
  });
}

/** True when the two boxes are at least `gap` apart (on either axis). */
function clear(a: Box, b: Box, gap: number): boolean {
  const eps = 1e-6;
  return a.x + a.w + gap <= b.x + eps || b.x + b.w + gap <= a.x + eps || a.y + a.h + gap <= b.y + eps || b.y + b.h + gap <= a.y + eps;
}

function expectValid(sheet: SheetSize, items: MixedItem[], placements: MixedPlacement[], gap: number, margin: number, keepouts: KeepoutRect[] = []) {
  const eps = 1e-6;
  const bs = boxes(items, placements);
  for (const b of bs) {
    expect(b.x).toBeGreaterThanOrEqual(margin - eps);
    expect(b.y).toBeGreaterThanOrEqual(margin - eps);
    expect(b.x + b.w).toBeLessThanOrEqual(sheet.widthMm - margin + eps);
    expect(b.y + b.h).toBeLessThanOrEqual(sheet.heightMm - margin + eps);
    // Clear of a keepout's sides by the gap, or directly above/below it.
    for (const z of keepouts) expect(clear(b, z, gap) || b.y + b.h <= z.y + eps || b.y >= z.y + z.h - eps).toBe(true);
  }
  for (let i = 0; i < bs.length; i++) {
    for (let j = i + 1; j < bs.length; j++) expect(clear(bs[i], bs[j], gap)).toBe(true);
  }
}

const count = (placements: MixedPlacement[], id: string) => placements.filter((p) => p.id === id).length;

describe("packMixedSheet", () => {
  it("fills a plain grid when the stickers divide the sheet evenly", () => {
    const sheet = { name: "t", widthMm: 100, heightMm: 100 };
    const items = [{ id: "a", widthMm: 20, heightMm: 20 }];
    const placed = packMixedSheet(sheet, items, 0, 0, "fill");
    expect(placed).toHaveLength(25);
    expect(placed.every((p) => !p.rotated)).toBe(true);
    expectValid(sheet, items, placed, 0, 0);
  });

  it("turns stickers to use the strip an upright grid leaves over", () => {
    // Upright: 3 columns of 30 leave a 10 mm strip, 2 rows of 45 leave 10 mm: 6 stickers.
    // Mixing orientations fits more.
    const sheet = { name: "t", widthMm: 100, heightMm: 105 };
    const items = [{ id: "a", widthMm: 30, heightMm: 45 }];
    const upright = packMixedSheet(sheet, items, 0, 0, "fill", [], false);
    const turned = packMixedSheet(sheet, items, 0, 0, "fill", [], true);
    expect(upright).toHaveLength(6);
    expect(upright.every((p) => !p.rotated)).toBe(true);
    expect(turned.length).toBeGreaterThan(6);
    expect(turned.some((p) => p.rotated)).toBe(true);
    expectValid(sheet, items, turned, 0, 0);
  });

  it("turns a sticker that only fits sideways", () => {
    const sheet = { name: "t", widthMm: 100, heightMm: 200 };
    const items = [{ id: "wide", widthMm: 150, heightMm: 40 }];
    expect(packMixedSheet(sheet, items, 4, 5, "single", [], false)).toHaveLength(0);
    const placed = packMixedSheet(sheet, items, 4, 5, "single");
    expect(placed).toEqual([{ id: "wide", x: 5, y: 5, rotated: true }]);
  });

  it("leaves stickers upright and in order when one of each already fits", () => {
    const items = [
      { id: "a", widthMm: 50, heightMm: 30 },
      { id: "b", widthMm: 40, heightMm: 60 },
      { id: "c", widthMm: 70, heightMm: 20 },
    ];
    const placed = packMixedSheet(letter, items, 4, 8, "single");
    expect(placed.map((p) => p.id)).toEqual(["a", "b", "c"]);
    expect(placed.every((p) => !p.rotated)).toBe(true);
    expect(placed[0]).toMatchObject({ x: 8, y: 8 });
    expectValid(letter, items, placed, 4, 8);
  });

  it("drops small stickers into the space beside a tall one", () => {
    // A shelf would start a new row under the tall sticker; the short ones stack beside it instead.
    const sheet = { name: "t", widthMm: 100, heightMm: 100 };
    const items = [
      { id: "tall", widthMm: 50, heightMm: 100 },
      { id: "s1", widthMm: 50, heightMm: 30 },
      { id: "s2", widthMm: 50, heightMm: 30 },
      { id: "s3", widthMm: 50, heightMm: 30 },
    ];
    const placed = packMixedSheet(sheet, items, 0, 0, "single");
    expect(placed).toHaveLength(4);
    expectValid(sheet, items, placed, 0, 0);
  });

  it("fills with balanced sets, then tops up with whatever still fits", () => {
    const items = [
      { id: "big", widthMm: 90, heightMm: 70 },
      { id: "small", widthMm: 25, heightMm: 25 },
    ];
    const placed = packMixedSheet(letter, items, 4, 8, "fill");
    expectValid(letter, items, placed, 4, 8);
    expect(count(placed, "big")).toBeGreaterThanOrEqual(4);
    expect(count(placed, "small")).toBeGreaterThanOrEqual(count(placed, "big"));
  });

  it("keeps stickers clear of the registration-mark corners", () => {
    const keepouts = getRegmarkKeepoutRects(letter.widthMm, letter.heightMm, false);
    const items = [
      { id: "a", widthMm: 38, heightMm: 52 },
      { id: "b", widthMm: 61, heightMm: 24 },
    ];
    for (const mode of ["single", "fill"] as const) {
      const placed = packMixedSheet(letter, items, 3, 12, mode, keepouts);
      expect(placed.length).toBeGreaterThan(0);
      expectValid(letter, items, placed, 3, 12, keepouts);
    }
  });

  it("never fits fewer with rotation allowed than without", () => {
    for (const [w, h] of [[50, 31], [23, 77], [64, 64], [110, 45], [18, 29]]) {
      const items = [{ id: "a", widthMm: w, heightMm: h }];
      const keepouts = getRegmarkKeepoutRects(letter.widthMm, letter.heightMm, false);
      const off = packMixedSheet(letter, items, 4, 12, "fill", keepouts, false);
      const on = packMixedSheet(letter, items, 4, 12, "fill", keepouts, true);
      expect(on.length).toBeGreaterThanOrEqual(off.length);
      expectValid(letter, items, on, 4, 12, keepouts);
    }
  });

  it("keeps a taller sticker out of a keepout its shorter row-mates cleared", () => {
    const a4 = SHEET_SIZES.find((s) => s.name === "A4")!;
    const keepouts = getRegmarkKeepoutRects(a4.widthMm, a4.heightMm, true);
    const items = [
      { id: "a", widthMm: 12, heightMm: 16 },
      { id: "b", widthMm: 12.5, heightMm: 15 },
    ];
    for (const mode of ["single", "fill"] as const) {
      const placed = packMixedSheet(a4, items, 0, 12, mode, keepouts, false);
      expectValid(a4, items, placed, 0, 12, keepouts);
    }
  });

  it("still avoids keepouts when the gap is bigger than they are", () => {
    const keepouts = getRegmarkKeepoutRects(letter.widthMm, letter.heightMm, false);
    const items = [{ id: "a", widthMm: 40, heightMm: 40 }];
    const placed = packMixedSheet(letter, items, 30, 12, "fill", keepouts);
    expect(placed.length).toBeGreaterThan(0);
    for (const b of boxes(items, placed)) {
      for (const z of keepouts) expect(clear(b, z, 0)).toBe(true);
    }
  });

  it("never gives a less balanced mixed fill with rotation allowed than without", () => {
    const items = [
      { id: "a", widthMm: 60, heightMm: 55 },
      { id: "b", widthMm: 60, heightMm: 25 },
      { id: "c", widthMm: 95, heightMm: 50 },
    ];
    const tally = (placed: MixedPlacement[]) => items.map((it) => count(placed, it.id)).sort((p, q) => p - q);
    const off = tally(packMixedSheet(letter, items, 4, 8, "fill", [], false));
    const on = tally(packMixedSheet(letter, items, 4, 8, "fill", [], true));
    expect(off).toEqual([4, 5, 5]);
    expect(on[0]).toBeGreaterThanOrEqual(off[0]);
    expect(on[1]).toBeGreaterThanOrEqual(off[1]);
  });

  it("returns nothing when no sticker fits", () => {
    expect(packMixedSheet(letter, [{ id: "a", widthMm: 400, heightMm: 400 }], 4, 8, "fill")).toEqual([]);
    expect(packMixedSheet(letter, [], 4, 8, "fill")).toEqual([]);
  });

  it("stays fast on a sheet of tiny stickers", () => {
    const items = [{ id: "a", widthMm: 6.35, heightMm: 9 }];
    const start = performance.now();
    const placed = packMixedSheet(a3, items, 0, 8, "fill");
    const ms = performance.now() - start;
    expect(placed.length).toBeGreaterThan(1500);
    expect(ms).toBeLessThan(1500);
  });
});

describe("stickerKeepout", () => {
  const gap = 4;
  const narrow: SheetSize = { name: "Test", widthMm: 60, heightMm: 100 };
  const fixed: Box = { x: 0, y: 60, w: 60, h: 30 }; // across the whole width, so only the space above it is left
  const items: MixedItem[] = [
    { id: "a", widthMm: 50, heightMm: 28 },
    { id: "b", widthMm: 50, heightMm: 28 },
  ];

  it("keeps the gap above a fixed sticker: the second one doesn't fit flush on top of it", () => {
    const placements = packMixedSheet(narrow, items, gap, 0, "single", [stickerKeepout(fixed, gap)], false);
    expect(placements).toHaveLength(1);
    for (const b of boxes(items, placements)) expect(clear(b, fixed, gap)).toBe(true);
  });

  it("without the extra height the packer would put one directly on it", () => {
    const placements = packMixedSheet(narrow, items, gap, 0, "single", [fixed], false);
    expect(placements).toHaveLength(2);
    expect(boxes(items, placements).some((b) => !clear(b, fixed, gap))).toBe(true);
  });

  it("leaves the gap on every side when packing around one in the middle of a sheet", () => {
    const mid: Box = { x: 60, y: 90, w: 40, h: 30 };
    const stickers: MixedItem[] = [{ id: "s", widthMm: 30, heightMm: 25 }];
    const placements = packMixedSheet(letter, stickers, gap, 8, "fill", [stickerKeepout(mid, gap)], false);
    expect(placements.length).toBeGreaterThan(20);
    for (const b of boxes(stickers, placements)) expect(clear(b, mid, gap)).toBe(true);
  });
});

describe("nudgeIntoArea", () => {
  const marks = getRegmarkKeepoutRects(letter.widthMm, letter.heightMm, false);

  it("returns a sticker that is already in the clear exactly as it was", () => {
    const rect: Box = { x: 60.123, y: 80.456, w: 40, h: 30 };
    expect(nudgeIntoArea(rect, letter, 12, marks)).toEqual({ x: 60.123, y: 80.456 });
  });

  it("pulls a sticker in from the edge to the margin, and no further", () => {
    expect(nudgeIntoArea({ x: 5, y: 150, w: 30, h: 30 }, letter, 12, [])).toEqual({ x: 12, y: 150 });
    expect(nudgeIntoArea({ x: 200, y: 260, w: 30, h: 30 }, letter, 12, [])).toEqual({ x: letter.widthMm - 12 - 30, y: letter.heightMm - 12 - 30 });
  });

  it("moves a sticker off a registration mark by the shortest way", () => {
    const rect: Box = { x: 12, y: 12, w: 40, h: 40 };
    const at = nudgeIntoArea(rect, letter, 12, marks);
    const moved: Box = { ...rect, ...at };
    for (const m of marks) expect(clear(moved, m, 0)).toBe(true);
    expect(Math.abs(at.x - 12) + Math.abs(at.y - 12)).toBeCloseTo(18, 6); // the mark's keepout is 30 mm; the margin is 12
  });

  it("keeps a sticker that is bigger than the area as near as it can get", () => {
    expect(nudgeIntoArea({ x: 0, y: 0, w: 300, h: 40 }, letter, 12, [])).toEqual({ x: 12, y: 12 });
  });
});
