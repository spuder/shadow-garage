import { describe, expect, it } from "vitest";
import { parseStudio3, Studio3Error, writeStudio3, type Studio3Document, type Studio3Placement } from "./studio3";
import fixtureDataUrl from "./fixtures/six-stickers.studio3?inline";

// A file saved by Silhouette Studio 5.0.539: six copies of one traced sticker on a Letter page.
// The artwork and thumbnail were swapped for flat placeholders and the cached cut job dropped;
// the document itself is byte for byte what Studio wrote.
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
