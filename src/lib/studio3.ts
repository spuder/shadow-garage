// Reads Silhouette Studio .studio3 documents and writes edits back into them.
//
// The format is undocumented. Everything here was worked out from files written by Silhouette
// Studio 5.0 (magic "silhouette05;"); Studio 5.0.539 opens a file with a sticker moved this way.
// All numbers are little-endian.
//
// File: the magic, then from 0x10 a table of u64 section sizes, three u64 version numbers at
// 0x3e8, and the sections laid end to end from 0x400. Section 0 is the document, section 1 the
// image store, section 2 a thumbnail PNG. Section 3 is a block of 0xFF. Sections 4 to 6 are the
// document's cached cut job, which Studio rewrites on every save: 4 holds its bounding box in
// device units (20 per mm) with the page size and counts, 5 and 6 its paths as substituted text.
// None of those are read, or updated by writeStudio3.
//
// Document: the magic again, then nested blocks. A block is a 0x01 byte, a u32 size counting
// itself and the body, then the body. Lists store the index of their last item, not a count.
// The root block's body is a run of blocks. The second holds the page size; the one that is
// itself a list of blocks is the object list (layers and objects, in drawing order).
//
// A sticker (artwork with a cut outline) in the object list has this body:
//   0x00
//   block       style, the image's id, and the outline in image pixels
//   9 f32       matrix taking image pixels to page mm, row by row
//   2 f32       centre on the page
//   4 f32       half extents: half width, 0, 0, half height
//   u32, u8
//   block       the outline in page mm (a path, below)
//   0x01, u64   serial number
//   block, then the object's name as a u32 length and that many bytes
//
// A path's body is a u32 last-subpath index and the subpaths. A subpath is a u32 size counting
// itself, a closed flag byte, a u32 last-point index and the points. A point is f32 x and y, then
// the incoming and the outgoing curve handle: each a flag byte followed, when it's 1, by two f32
// relative to the point.
//
// Image store: 0x01, u64 size, u64 last index, then the images. An image is a u64 size counting
// itself, the id (u64 length + text), a description (u64 size counting itself, then the format
// name as u64 length + text, u64 width, u64 height and more), a u64 data length and the file's
// bytes as imported.
//
// Writing only ever touches bytes it understands: a moved or resized sticker has its matrix,
// centre, extents and page outline rewritten in place, and a deleted one has its record cut out
// and the sizes around it adjusted. Everything else in the file is passed through untouched.

import { boundingBox, type Contour } from "./geometry";

const MAGIC = "silhouette05;";
const SIZE_TABLE_OFFSET = 0x10;
const VERSION_OFFSET = 0x3e8;
const SECTIONS_OFFSET = 0x400;
const PAGE_SIZE_OFFSET = 0x29; // of the page width within the page block's body; the height follows

const MATRIX_FLOATS = 9;
const CENTRE_OFFSET = 36; // from the matrix
const EXTENTS_OFFSET = 44;
const PATH_OFFSET = 65;

/** Longest straight piece a curve is cut into. */
const CURVE_STEP_MM = 0.5;
/** Most pieces one curve is cut into; a long curve at the step above needs well over a hundred. */
const MAX_CURVE_STEPS = 400;
/**
 * An entry of the object list that can't be read is counted as a left-out object rather than a
 * layer when it is at least this big. A layer is a few hundred bytes; text and the like are more.
 */
const OBJECT_MIN_BYTES = 1024;
/**
 * Outlines smaller than this both ways are left out. Studio's trace leaves specks a fraction of a
 * millimetre across beside the real outline, and they aren't worth lowering the blade for.
 */
const MIN_OUTLINE_MM = 1;

export class Studio3Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Studio3Error";
  }
}

export interface Studio3Image {
  id: string;
  widthPx: number;
  heightPx: number;
  mime: string; // "" when the bytes aren't a format a browser can draw
  bytes: Uint8Array;
}

export interface Studio3Sticker {
  name: string;
  imageId: string;
  imageRect: { x: number; y: number; width: number; height: number }; // where the artwork sits on the page, mm
  contours: Contour[]; // the cut outline on the page, mm, with curves flattened
  bbox: { minX: number; minY: number; maxX: number; maxY: number }; // of contours
}

interface Block {
  start: number; // of the 0x01 marker
  body: number;
  end: number;
}

interface StickerRecord {
  block: Block;
  matrixAt: number;
  pointOffsets: number[]; // of each outline point's x; its y follows
  handleOffsets: number[]; // likewise for each curve handle
}

export interface Studio3Document {
  studioVersion: number; // e.g. 500000539 for Silhouette Studio 5.0.539
  pageWidthMm: number | null;
  pageHeightMm: number | null;
  images: Map<string, Studio3Image>;
  stickers: Studio3Sticker[];
  skippedShapes: number; // objects that couldn't be read as a sticker (no artwork, artwork it can't show, rotated, text, ...)
  /** The file as read, and where its stickers are, for writeStudio3. */
  source: { bytes: Uint8Array; root: Block; list: Block; records: StickerRecord[] };
}

/** Where a sticker should be in the written file: the top-left of its outline, and its size relative to the original. */
export interface Studio3Placement {
  index: number; // into Studio3Document.stickers
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
}

class Reader {
  readonly bytes: Uint8Array;
  private readonly view: DataView;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get length(): number {
    return this.bytes.length;
  }
  u8(at: number): number {
    return this.view.getUint8(at);
  }
  u32(at: number): number {
    return this.view.getUint32(at, true);
  }
  /** A list's last-item index of -1: the list is empty. */
  isU64Max(at: number): boolean {
    return this.view.getBigUint64(at, true) === 0xffffffffffffffffn;
  }
  u64(at: number): number {
    const value = this.view.getBigUint64(at, true);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("size out of range");
    return Number(value);
  }
  f32(at: number): number {
    return this.view.getFloat32(at, true);
  }
  text(at: number, length: number): string {
    if (at + length > this.length) throw new RangeError("text out of range");
    return new TextDecoder().decode(this.bytes.subarray(at, at + length));
  }
}

function blockAt(r: Reader, at: number, limit: number): Block | null {
  if (at + 5 > limit || r.u8(at) !== 1) return null;
  const size = r.u32(at + 1);
  const end = at + 1 + size;
  if (size < 4 || end > limit) return null;
  return { start: at, body: at + 5, end };
}

/** The blocks that follow one another from `at`, up to the first thing that isn't one. */
function blockRun(r: Reader, at: number, limit: number): Block[] {
  const blocks: Block[] = [];
  for (let b = blockAt(r, at, limit); b; b = blockAt(r, b.end, limit)) blocks.push(b);
  return blocks;
}

/** The block's items if its body is a list of blocks and nothing else, or null. */
function blockList(r: Reader, block: Block): Block[] | null {
  if (block.end - block.body < 4) return null;
  const last = r.u32(block.body);
  if (last >= (block.end - block.body) / 5) return null;
  const items = blockRun(r, block.body + 4, block.end);
  return items.length === last + 1 && items[last].end === block.end ? items : null;
}

function readSections(r: Reader): { start: number; end: number }[] {
  const sections: { start: number; end: number }[] = [];
  let at = SECTIONS_OFFSET;
  for (let entry = SIZE_TABLE_OFFSET; entry < VERSION_OFFSET && at < r.length; entry += 8) {
    const size = r.u64(entry);
    sections.push({ start: at, end: at + size });
    at += size;
  }
  if (at !== r.length || sections.length < 2) throw new Studio3Error("This .studio3 file is damaged or cut short.");
  return sections;
}

function sniffMime(bytes: Uint8Array): string {
  const startsWith = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (startsWith(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (startsWith(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (startsWith(0x47, 0x49, 0x46)) return "image/gif";
  if (startsWith(0x42, 0x4d)) return "image/bmp";
  if (startsWith(0x52, 0x49, 0x46, 0x46)) return "image/webp";
  if (new TextDecoder().decode(bytes.subarray(0, 512)).includes("<svg")) return "image/svg+xml";
  return "";
}

function readImages(r: Reader, section: { start: number; end: number }): Map<string, Studio3Image> {
  const images = new Map<string, Studio3Image>();
  if (section.end - section.start < 17 || r.u8(section.start) !== 1) return images; // no images in this document
  if (r.isU64Max(section.start + 9)) return images; // a document with no stickers stores the last index as -1
  const last = r.u64(section.start + 9);
  let at = section.start + 17;
  for (let i = 0; i <= last; i++) {
    const end = at + r.u64(at);
    const idLength = r.u64(at + 8);
    const id = r.text(at + 16, idLength);
    const about = at + 16 + idLength;
    const dataAt = about + r.u64(about);
    const dims = about + 16 + r.u64(about + 8); // past the format name
    const dataLength = r.u64(dataAt);
    if (end > section.end || dataAt + 8 + dataLength > end) throw new Studio3Error("Couldn't read the images stored in this .studio3 file.");
    const bytes = r.bytes.subarray(dataAt + 8, dataAt + 8 + dataLength);
    images.set(id, { id, widthPx: r.u64(dims), heightPx: r.u64(dims + 8), mime: sniffMime(bytes), bytes });
    at = end;
  }
  return images;
}

export interface PathPoint {
  x: number;
  y: number;
  inX: number; // curve handles, relative to the point; zero when there isn't one
  inY: number;
  outX: number;
  outY: number;
}

interface Path {
  subpaths: { closed: boolean; points: PathPoint[] }[];
  pointOffsets: number[];
  handleOffsets: number[];
}

/** The block as a path if it is exactly one, or null. */
function readPath(r: Reader, block: Block): Path | null {
  const path: Path = { subpaths: [], pointOffsets: [], handleOffsets: [] };
  if (block.end - block.body < 4) return null;
  const last = r.u32(block.body);
  if (last >= (block.end - block.body) / 9) return null;
  let at = block.body + 4;
  for (let i = 0; i <= last; i++) {
    if (at + 9 > block.end) return null;
    const end = at + r.u32(at);
    const lastPoint = r.u32(at + 5);
    if (end > block.end || r.u8(at + 4) > 1 || lastPoint >= (end - at) / 10) return null;
    const points: PathPoint[] = [];
    let p = at + 9;
    for (let j = 0; j <= lastPoint; j++) {
      if (p + 10 > end) return null;
      const point: PathPoint = { x: r.f32(p), y: r.f32(p + 4), inX: 0, inY: 0, outX: 0, outY: 0 };
      path.pointOffsets.push(p);
      p += 8;
      for (const handle of ["in", "out"] as const) {
        const flag = r.u8(p++);
        if (flag > 1 || (flag === 1 && p + 8 > end)) return null;
        if (flag === 0) continue;
        point[`${handle}X`] = r.f32(p);
        point[`${handle}Y`] = r.f32(p + 4);
        path.handleOffsets.push(p);
        p += 8;
      }
      points.push(point);
    }
    if (p !== end) return null;
    path.subpaths.push({ closed: r.u8(at + 4) === 1, points });
    at = end;
  }
  return at === block.end ? path : null;
}

/** A closed subpath as a polygon, its curves cut into short straight pieces. */
export function flatten(points: PathPoint[]): Contour {
  const out: Contour = [];
  points.forEach((a, i) => {
    const b = points[(i + 1) % points.length];
    out.push([a.x, a.y]);
    if (a.outX === 0 && a.outY === 0 && b.inX === 0 && b.inY === 0) return; // a straight edge
    const c1x = a.x + a.outX;
    const c1y = a.y + a.outY;
    const c2x = b.x + b.inX;
    const c2y = b.y + b.inY;
    const length = Math.hypot(c1x - a.x, c1y - a.y) + Math.hypot(c2x - c1x, c2y - c1y) + Math.hypot(b.x - c2x, b.y - c2y);
    const steps = Math.min(MAX_CURVE_STEPS, Math.ceil(length / CURVE_STEP_MM));
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      const u = 1 - t;
      out.push([
        u * u * u * a.x + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * b.x,
        u * u * u * a.y + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * b.y,
      ]);
    }
  });
  return out;
}

/** The object's name, which follows its outline; "" if it isn't where it's expected. */
function readName(r: Reader, at: number, limit: number): string {
  const before = blockAt(r, at + 9, limit); // past the serial number
  if (!before || before.end + 4 > limit) return "";
  const length = r.u32(before.end);
  return length <= 256 && before.end + 4 + length <= limit ? r.text(before.end + 4, length) : "";
}

/** The image an object's style block names, if any. Ids are stored as a u32 length of 32 and that many hex digits. */
function findImageId(r: Reader, style: Block, images: Map<string, Studio3Image>): string | null {
  for (let at = style.body; at + 36 <= style.end; at++) {
    if (r.u32(at) !== 32) continue;
    const id = r.text(at + 4, 32);
    if (images.has(id)) return id;
  }
  return null;
}

type RecordResult = { sticker: Studio3Sticker; record: StickerRecord } | "skipped" | null;

/** Reads one entry of the object list: a sticker, an outline this reader can't use, or (null) something else such as a layer. */
function readRecord(r: Reader, block: Block, images: Map<string, Studio3Image>): RecordResult {
  if (block.end - block.body < 6 || r.u8(block.body) !== 0) return null;
  const style = blockAt(r, block.body + 1, block.end);
  if (!style) return null;
  const matrixAt = style.end;
  const pathBlock = blockAt(r, matrixAt + PATH_OFFSET, block.end);
  if (!pathBlock) return null;
  const m = Array.from({ length: MATRIX_FLOATS }, (_, i) => r.f32(matrixAt + 4 * i));
  if (m[6] !== 0 || m[7] !== 0 || m[8] !== 1) return null;
  const path = readPath(r, pathBlock);
  if (!path) return null;

  const imageId = findImageId(r, style, images);
  const upright = Math.abs(m[1]) < 1e-6 && Math.abs(m[3]) < 1e-6 && m[0] > 0 && m[4] > 0;
  if (!imageId || !upright || !images.get(imageId)!.mime) return "skipped";
  const contours = path.subpaths
    .filter((s) => s.closed && s.points.length >= 2)
    .map((s) => flatten(s.points))
    .filter((c) => {
      const box = boundingBox([c]);
      return box.maxX - box.minX >= MIN_OUTLINE_MM || box.maxY - box.minY >= MIN_OUTLINE_MM;
    });
  if (contours.length === 0) return "skipped";

  const image = images.get(imageId)!;
  return {
    sticker: {
      name: readName(r, pathBlock.end, block.end),
      imageId,
      imageRect: { x: m[2], y: m[5], width: m[0] * image.widthPx, height: m[4] * image.heightPx },
      contours,
      bbox: boundingBox(contours),
    },
    record: { block, matrixAt, pointOffsets: path.pointOffsets, handleOffsets: path.handleOffsets },
  };
}

function parse(bytes: Uint8Array): Studio3Document {
  const r = new Reader(bytes);
  if (r.length < SECTIONS_OFFSET || r.text(0, 10) !== MAGIC.slice(0, 10)) throw new Studio3Error("This isn't a Silhouette Studio .studio3 file.");
  if (r.text(0, MAGIC.length) !== MAGIC) {
    throw new Studio3Error("This .studio3 file comes from a version of Silhouette Studio that isn't supported yet. Files saved by Studio 5 are.");
  }
  const sections = readSections(r);
  const doc = sections[0];
  const root = doc.end - doc.start > MAGIC.length ? blockAt(r, doc.start + MAGIC.length, doc.end) : null;
  if (!root) throw new Studio3Error("Couldn't find the document inside this .studio3 file.");

  const top = blockRun(r, root.body, root.end);
  let list: Block | null = null;
  let entries: Block[] = [];
  for (const block of top) {
    const items = blockList(r, block);
    if (!items) continue;
    list = block;
    entries = items;
    break;
  }
  if (!list) throw new Studio3Error("Couldn't find the objects inside this .studio3 file.");

  const images = readImages(r, sections[1]);
  const stickers: Studio3Sticker[] = [];
  const records: StickerRecord[] = [];
  let skippedShapes = 0;
  for (const entry of entries) {
    const result = readRecord(r, entry, images);
    if (result === "skipped") skippedShapes++;
    else if (result) {
      stickers.push(result.sticker);
      records.push(result.record);
    } else if (entry.end - entry.body >= OBJECT_MIN_BYTES) skippedShapes++;
  }

  // A page smaller than a stamp or bigger than a room means the size isn't where it's expected.
  const sane = (mm: number) => Number.isFinite(mm) && mm >= 20 && mm <= 5000;
  const page = top[1];
  const hasPage = page && page.end - page.body >= PAGE_SIZE_OFFSET + 8;
  const pageWidthMm = hasPage ? r.f32(page.body + PAGE_SIZE_OFFSET) : NaN;
  const pageHeightMm = hasPage ? r.f32(page.body + PAGE_SIZE_OFFSET + 4) : NaN;
  const pageOk = sane(pageWidthMm) && sane(pageHeightMm);

  return {
    studioVersion: r.u64(VERSION_OFFSET),
    pageWidthMm: pageOk ? pageWidthMm : null,
    pageHeightMm: pageOk ? pageHeightMm : null,
    images,
    stickers,
    skippedShapes,
    source: { bytes, root, list, records },
  };
}

/** Reads a .studio3 file. Throws Studio3Error if it isn't one or can't be understood. */
export function parseStudio3(bytes: Uint8Array): Studio3Document {
  try {
    return parse(bytes);
  } catch (e) {
    // A read past the end of the file, or a size too big to be one.
    if (e instanceof RangeError) throw new Studio3Error("This .studio3 file is damaged or cut short.");
    throw e;
  }
}

/**
 * The document's file with its stickers moved and resized to `placements`. Stickers without a
 * placement are deleted from it. Stickers left where they were keep their bytes exactly.
 */
export function writeStudio3(doc: Studio3Document, placements: Studio3Placement[]): Uint8Array {
  const { bytes, root, list, records } = doc.source;
  const out = bytes.slice();
  const view = new DataView(out.buffer);
  const get = (at: number) => view.getFloat32(at, true);
  const set = (at: number, value: number) => view.setFloat32(at, value, true);

  const kept = new Set<number>();
  for (const p of placements) {
    const sticker = doc.stickers[p.index];
    if (!sticker || kept.has(p.index)) throw new Studio3Error(`There's no sticker ${p.index} to place in this .studio3 file.`);
    kept.add(p.index);
    const { minX, minY } = sticker.bbox;
    const unchanged = Math.abs(p.scaleX - 1) < 1e-6 && Math.abs(p.scaleY - 1) < 1e-6 && Math.abs(p.x - minX) < 1e-4 && Math.abs(p.y - minY) < 1e-4;
    if (unchanged) continue;

    const mapX = (x: number) => (x - minX) * p.scaleX + p.x;
    const mapY = (y: number) => (y - minY) * p.scaleY + p.y;
    const { matrixAt, pointOffsets, handleOffsets } = records[p.index];
    set(matrixAt, get(matrixAt) * p.scaleX);
    set(matrixAt + 8, mapX(get(matrixAt + 8)));
    set(matrixAt + 16, get(matrixAt + 16) * p.scaleY);
    set(matrixAt + 20, mapY(get(matrixAt + 20)));
    set(matrixAt + CENTRE_OFFSET, mapX(get(matrixAt + CENTRE_OFFSET)));
    set(matrixAt + CENTRE_OFFSET + 4, mapY(get(matrixAt + CENTRE_OFFSET + 4)));
    set(matrixAt + EXTENTS_OFFSET, get(matrixAt + EXTENTS_OFFSET) * p.scaleX);
    set(matrixAt + EXTENTS_OFFSET + 12, get(matrixAt + EXTENTS_OFFSET + 12) * p.scaleY);
    for (const at of pointOffsets) {
      set(at, mapX(get(at)));
      set(at + 4, mapY(get(at + 4)));
    }
    for (const at of handleOffsets) {
      set(at, get(at) * p.scaleX);
      set(at + 4, get(at + 4) * p.scaleY);
    }
  }

  const removed = records.filter((_, i) => !kept.has(i)).map((rec) => rec.block);
  if (removed.length === 0) return out;

  // Cut the deleted records out. Every size that covers them sits earlier in the file, so those
  // stay where they are and just get smaller.
  const removedBytes = removed.reduce((sum, b) => sum + (b.end - b.start), 0);
  const result = new Uint8Array(out.length - removedBytes);
  let from = 0;
  let to = 0;
  for (const block of removed) {
    result.set(out.subarray(from, block.start), to);
    to += block.start - from;
    from = block.end;
  }
  result.set(out.subarray(from), to);

  const sizes = new DataView(result.buffer);
  const shrink = (at: number, by: number) => sizes.setUint32(at, sizes.getUint32(at, true) - by, true);
  shrink(list.body, removed.length); // the list's last index
  shrink(list.start + 1, removedBytes);
  shrink(root.start + 1, removedBytes);
  sizes.setBigUint64(SIZE_TABLE_OFFSET, sizes.getBigUint64(SIZE_TABLE_OFFSET, true) - BigInt(removedBytes), true);
  return result;
}
