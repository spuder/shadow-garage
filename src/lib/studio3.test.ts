import { describe, expect, it } from "vitest";
import { flatten, movedShapeParams, parseStudio3, Studio3Error, writeStudio3, type PathPoint, type Studio3Document, type Studio3Placement } from "./studio3";
import fixtureDataUrl from "./fixtures/six-stickers.studio3?inline";

// A file saved by Silhouette Studio 5.0.539: six copies of one traced sticker on a Letter page.
// The artwork and thumbnail were swapped for flat placeholders and the cached cut job (sections 5
// and 6) emptied; the document itself is byte for byte what Studio wrote.
const fixture = Uint8Array.from(atob(fixtureDataUrl.slice(fixtureDataUrl.indexOf(",") + 1)), (c) => c.charCodeAt(0));

function inPlace(doc: Studio3Document): Studio3Placement[] {
  return doc.stickers.map((s, index) => ({ index, x: s.bbox.minX, y: s.bbox.minY, scaleX: 1, scaleY: 1 }));
}

describe("parseStudio3", () => {
  const doc = parseStudio3(fixture);

  it("reads the Studio version and the page size", () => {
    expect(doc.studioVersion).toBe(500000539);
    expect(doc.pageWidthMm).toBeCloseTo(215.9, 3);
    expect(doc.pageHeightMm).toBeCloseTo(279.4, 3);
  });

  it("finds every sticker, each with its own position", () => {
    expect(doc.stickers).toHaveLength(6);
    expect(doc.skippedShapes).toBe(0);
    expect(doc.stickers.map((s) => s.name)).toEqual(Array(6).fill("Polygon"));
    expect(doc.stickers.map((s) => [Math.round(s.bbox.minX), Math.round(s.bbox.minY)])).toEqual([
      [16, 16],
      [116, 15],
      [16, 94],
      [113, 92],
      [18, 174],
      [114, 173],
    ]);
  });

  it("reads the stored artwork and where each sticker draws it", () => {
    expect(doc.images.size).toBe(1);
    const image = [...doc.images.values()][0];
    expect(image).toMatchObject({ widthPx: 1448, heightPx: 1086, mime: "image/png" });
    expect([...image.bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    for (const s of doc.stickers) expect(s.imageId).toBe(image.id);

    const { imageRect, bbox } = doc.stickers[0];
    expect(imageRect.x).toBeCloseTo(5.733, 2);
    expect(imageRect.y).toBeCloseTo(13.036, 2);
    expect(imageRect.width / imageRect.height).toBeCloseTo(1448 / 1086, 4);
    // the outline sits inside the artwork's rectangle
    expect(bbox.minX).toBeGreaterThan(imageRect.x);
    expect(bbox.maxX).toBeLessThan(imageRect.x + imageRect.width);
  });

  it("keeps the real outline and drops the trace's specks", () => {
    for (const s of doc.stickers) {
      expect(s.contours).toHaveLength(1);
      expect(s.bbox.maxX - s.bbox.minX).toBeCloseTo(77.4, 0);
      expect(s.bbox.maxY - s.bbox.minY).toBeCloseTo(66.6, 0);
    }
    // The outline has 304 points in the file. Its curves are cut into short pieces, so the longest
    // piece left is its one long straight edge.
    const outline = doc.stickers[0].contours[0];
    const longest = Math.max(...outline.map((p, i) => Math.hypot(p[0] - outline[(i + 1) % outline.length][0], p[1] - outline[(i + 1) % outline.length][1])));
    expect(outline.length).toBeGreaterThan(500);
    expect(longest).toBeCloseTo(4.76, 1);
  });

  it("rejects files that aren't Studio 5 documents", () => {
    expect(() => parseStudio3(new Uint8Array(2000))).toThrow(Studio3Error);
    expect(() => parseStudio3(new TextEncoder().encode("<svg></svg>"))).toThrow(Studio3Error);
    const older = fixture.slice();
    older[11] = "4".charCodeAt(0); // "silhouette04;"
    expect(() => parseStudio3(older)).toThrow(/isn't supported yet/);
    expect(() => parseStudio3(fixture.slice(0, 50000))).toThrow(/damaged or cut short/);
  });
});

describe("writeStudio3", () => {
  const doc = parseStudio3(fixture);

  it("writes the file back byte for byte when nothing changed", () => {
    expect(writeStudio3(doc, inPlace(doc))).toEqual(fixture);
  });

  it("moves one sticker and leaves the rest of the file alone", () => {
    const placements = inPlace(doc);
    placements[0].x += 10;
    placements[0].y += 5;
    const written = writeStudio3(doc, placements);
    expect(written).toHaveLength(fixture.length);

    const again = parseStudio3(written);
    const before = doc.stickers[0];
    const after = again.stickers[0];
    expect(after.bbox.minX).toBeCloseTo(before.bbox.minX + 10, 3);
    expect(after.bbox.minY).toBeCloseTo(before.bbox.minY + 5, 3);
    expect(after.bbox.maxX).toBeCloseTo(before.bbox.maxX + 10, 3);
    expect(after.imageRect.x).toBeCloseTo(before.imageRect.x + 10, 3);
    expect(after.imageRect.width).toBeCloseTo(before.imageRect.width, 4);
    expect(again.stickers.slice(1)).toEqual(doc.stickers.slice(1));

    // only bytes inside the moved sticker's record differ
    const { block } = doc.source.records[0];
    const changed = [...written.keys()].filter((i) => written[i] !== fixture[i]);
    expect(changed.length).toBeGreaterThan(0);
    expect(changed[0]).toBeGreaterThanOrEqual(block.start);
    expect(changed[changed.length - 1]).toBeLessThan(block.end);
  });

  it("resizes a sticker about its top-left corner, artwork and all", () => {
    const placements = inPlace(doc);
    placements[3] = { ...placements[3], scaleX: 0.5, scaleY: 0.5 };
    const again = parseStudio3(writeStudio3(doc, placements));
    const before = doc.stickers[3];
    const after = again.stickers[3];
    expect(after.bbox.minX).toBeCloseTo(before.bbox.minX, 3);
    expect(after.bbox.minY).toBeCloseTo(before.bbox.minY, 3);
    expect(after.bbox.maxX - after.bbox.minX).toBeCloseTo((before.bbox.maxX - before.bbox.minX) / 2, 3);
    expect(after.bbox.maxY - after.bbox.minY).toBeCloseTo((before.bbox.maxY - before.bbox.minY) / 2, 3);
    expect(after.imageRect.width).toBeCloseTo(before.imageRect.width / 2, 3);
    // the artwork keeps its place relative to the outline
    expect(after.imageRect.x - after.bbox.minX).toBeCloseTo((before.imageRect.x - before.bbox.minX) / 2, 3);
    expect(after.imageRect.y - after.bbox.minY).toBeCloseTo((before.imageRect.y - before.bbox.minY) / 2, 3);
  });

  it("deletes stickers that aren't placed and keeps the file readable", () => {
    const placements = inPlace(doc).filter((p) => p.index !== 1 && p.index !== 4);
    const written = writeStudio3(doc, placements);
    const dropped = [1, 4].reduce((sum, i) => sum + doc.source.records[i].block.end - doc.source.records[i].block.start, 0);
    expect(written).toHaveLength(fixture.length - dropped);

    const again = parseStudio3(written);
    expect(again.stickers).toEqual([0, 2, 3, 5].map((i) => doc.stickers[i]));
    expect(again.images.size).toBe(1);
    expect(again.pageWidthMm).toBeCloseTo(215.9, 3);
  });

  it("can delete every sticker", () => {
    const again = parseStudio3(writeStudio3(doc, []));
    expect(again.stickers).toHaveLength(0);
    expect(again.images.size).toBe(1);
  });

  it("refuses a placement for a sticker the file doesn't have, or two for the same one", () => {
    expect(() => writeStudio3(doc, [{ index: 6, x: 0, y: 0, scaleX: 1, scaleY: 1 }])).toThrow(Studio3Error);
    const [first] = inPlace(doc);
    expect(() => writeStudio3(doc, [first, first])).toThrow(Studio3Error);
  });
});

describe("what it leaves out", () => {
  it("counts a sticker whose artwork isn't a format a browser can draw, and keeps it in the file", () => {
    const bytes = fixture.slice();
    const at = bytes.findIndex((_, i) => bytes[i] === 0x89 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x4e && bytes[i + 3] === 0x47); // the image store's PNG
    bytes[at] = 0x00;
    const doc = parseStudio3(bytes);
    expect(doc.stickers).toHaveLength(0);
    expect(doc.skippedShapes).toBe(6);
    // Nothing is placed, so nothing is deleted: the file comes back untouched.
    expect(writeStudio3(doc, [])).toEqual(bytes);
  });

  it("counts an object it can't read, but not the layers around the stickers", () => {
    const original = parseStudio3(fixture);
    expect(original.skippedShapes).toBe(0);
    const bytes = fixture.slice();
    // A transform that isn't a plain scale and move, as a sticker with a skew or perspective has.
    new DataView(bytes.buffer).setFloat32(original.source.records[0].matrixAt + 32, 2, true);
    const doc = parseStudio3(bytes);
    expect(doc.stickers).toHaveLength(5);
    expect(doc.skippedShapes).toBe(1);
  });
});

describe("flatten", () => {
  it("cuts a long curve into pieces no longer than half a millimetre", () => {
    const k = 0.5523 * 50; // a quarter of a circle of radius 50 mm
    const points: PathPoint[] = [
      { x: 50, y: 0, inX: 0, inY: 0, outX: 0, outY: k },
      { x: 0, y: 50, inX: k, inY: 0, outX: 0, outY: 0 },
    ];
    const line = flatten(points);
    const arc = line.slice(0, line.findIndex(([x, y]) => x === 0 && y === 50) + 1);
    expect(arc.length).toBeGreaterThan(100);
    for (let i = 1; i < arc.length; i++) {
      expect(Math.hypot(arc[i][0] - arc[i - 1][0], arc[i][1] - arc[i - 1][1])).toBeLessThanOrEqual(0.55);
    }
  });
});

describe("a document with no stickers", () => {
  it("reads one whose image store is empty, as Studio saves after the last sticker is deleted", () => {
    // Section 1 becomes a bare store: the 0x01 marker, its own size (16), and a last index of -1.
    const view = new DataView(fixture.buffer, fixture.byteOffset, fixture.byteLength);
    const sizes = Array.from({ length: 4 }, (_, i) => Number(view.getBigUint64(0x10 + 8 * i, true)));
    const store = new Uint8Array(17);
    store[0] = 1;
    store[1] = 16;
    store.fill(0xff, 9);
    const start1 = 0x400 + sizes[0];
    const bytes = new Uint8Array(fixture.length - sizes[1] + store.length);
    bytes.set(fixture.subarray(0, start1));
    bytes.set(store, start1);
    bytes.set(fixture.subarray(start1 + sizes[1]), start1 + store.length);
    new DataView(bytes.buffer).setBigUint64(0x10 + 8, BigInt(store.length), true);

    const doc = parseStudio3(bytes);
    expect(doc.images.size).toBe(0);
    // The outlines are still there; with no artwork to go with them they read as cut-only shapes.
    expect(doc.stickers).toHaveLength(6);
    expect(doc.stickers.every((s) => !s.artwork)).toBe(true);
  });
});

describe("shapes", () => {
  /** The fixture with the first sticker's reference to its artwork broken, so it is an outline alone. */
  function withFirstStickerAsShape(): Uint8Array {
    const bytes = fixture.slice();
    const id = parseStudio3(fixture).stickers[0].imageId;
    const text = new TextEncoder().encode(id);
    const at = bytes.findIndex((_, i) => text.every((c, j) => bytes[i + j] === c)); // its first use, in the document
    bytes[at] = bytes[at] === 0x30 ? 0x31 : 0x30;
    return bytes;
  }

  it("reads an outline with no artwork as a cut-only shape, beside the stickers", () => {
    const doc = parseStudio3(withFirstStickerAsShape());
    expect(doc.stickers).toHaveLength(6);
    expect(doc.skippedShapes).toBe(0);
    const [shape, ...rest] = doc.stickers;
    expect(shape.artwork).toBe(false);
    expect(shape.imageId).toBe("");
    expect(shape.imageRect).toEqual({
      x: shape.bbox.minX,
      y: shape.bbox.minY,
      width: shape.bbox.maxX - shape.bbox.minX,
      height: shape.bbox.maxY - shape.bbox.minY,
    });
    expect(rest.every((s) => s.artwork)).toBe(true);
  });

  it("moves a shape like a sticker, and deleting it leaves the rest", () => {
    const doc = parseStudio3(withFirstStickerAsShape());
    const { minX, minY } = doc.stickers[0].bbox;
    const moved = parseStudio3(writeStudio3(doc, inPlace(doc).map((p) => (p.index === 0 ? { ...p, x: minX + 12, y: minY + 7 } : p))));
    expect(moved.stickers[0].bbox.minX).toBeCloseTo(minX + 12, 3);
    expect(moved.stickers[0].bbox.minY).toBeCloseTo(minY + 7, 3);
    const rest = parseStudio3(writeStudio3(doc, inPlace(doc).filter((p) => p.index !== 0)));
    expect(rest.stickers).toHaveLength(5);
  });
});

describe("movedShapeParams", () => {
  const text = "type=autoshape;subtype=polygon;p1=117.06285,51.22940;p2=131.11183,70.59422;sides=5;auto_type=1";

  it("moves the points with the outline and leaves everything else", () => {
    const out = movedShapeParams(text, (x) => x + 10, (y) => y + 5);
    expect(out).toBe("type=autoshape;subtype=polygon;p1=127.06285,56.22940;p2=141.11183,75.59422;sides=5;auto_type=1");
  });

  it("keeps the text the same length when a number gains or loses a digit", () => {
    const shrunk = movedShapeParams(text, (x) => x - 30, (y) => y - 45); // 117.06 -> 87.06, 51.23 -> 6.23
    const grown = movedShapeParams(text, (x) => x + 90, (y) => y + 60); // 117.06 -> 207.06, 51.23 -> 111.23
    for (const out of [shrunk, grown]) expect(out).toHaveLength(text.length);
    expect(shrunk).toContain("p1=87.06285");
    expect(grown).toContain("p1=207.06285");
    expect(grown).toContain("sides=5;auto_type=1");
  });

  it("scales about the same point as the outline", () => {
    const out = movedShapeParams("p1=100.00000,50.00000", (x) => (x - 90) * 2 + 90, (y) => (y - 40) * 2 + 40);
    expect(out).toBe("p1=110.00000,60.00000");
  });
});
