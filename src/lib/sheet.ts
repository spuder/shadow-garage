export interface SheetSize {
  name: string;
  widthMm: number;
  heightMm: number;
}

// Letter first so it's the default selection.
export const SHEET_SIZES: SheetSize[] = [
  { name: "Letter", widthMm: 215.9, heightMm: 279.4 },
  { name: "A4", widthMm: 210, heightMm: 297 },
  { name: "A3", widthMm: 297, heightMm: 420 },
];

export interface SheetLayout {
  cols: number;
  rows: number;
  count: number; // min(cols*rows, requestedQuantity)
  usedWidthMm: number;
  usedHeightMm: number;
  positions: { x: number; y: number }[]; // top-left of each sticker's bounding box, in mm from sheet origin
}

/** Packs as many `itemW x itemH` copies as fit on a sheet (with outer margin + gap), capped at `quantity`. */
export function packSheet(
  sheet: SheetSize,
  itemWmm: number,
  itemHmm: number,
  gapMm: number,
  marginMm: number,
  quantity: number
): SheetLayout {
  const usableW = sheet.widthMm - 2 * marginMm;
  const usableH = sheet.heightMm - 2 * marginMm;

  const cols = Math.max(0, Math.floor((usableW + gapMm) / (itemWmm + gapMm)));
  const rows = Math.max(0, Math.floor((usableH + gapMm) / (itemHmm + gapMm)));
  const count = Math.min(cols * rows, quantity);

  const positions: { x: number; y: number }[] = [];
  outer: for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (positions.length >= count) break outer;
      positions.push({
        x: marginMm + c * (itemWmm + gapMm),
        y: marginMm + r * (itemHmm + gapMm),
      });
    }
  }

  return {
    cols,
    rows,
    count,
    usedWidthMm: cols > 0 ? cols * itemWmm + (cols - 1) * gapMm : 0,
    usedHeightMm: rows > 0 ? rows * itemHmm + (rows - 1) * gapMm : 0,
    positions,
  };
}

export interface MixedItem {
  id: string;
  widthMm: number;
  heightMm: number;
}

export interface MixedPlacement {
  id: string;
  x: number;
  y: number;
}

export interface KeepoutRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Shelf-packs a mixed set of differently-sized items onto a sheet, round-robining across
 * items so a multi-design sheet comes out as a balanced set rather than "fill item 1 fully,
 * then item 2." `mode: "single"` places exactly one copy of each item; `"fill"` keeps
 * round-robining copies until nothing more fits. `keepouts` are rectangles (e.g. registration
 * mark corners) to route around — only rows that actually overlap one get narrowed, rather than
 * shrinking the whole usable area in from every edge.
 */
export function packMixedSheet(
  sheet: SheetSize,
  items: MixedItem[],
  gapMm: number,
  marginMm: number,
  mode: "single" | "fill",
  keepouts: KeepoutRect[] = []
): MixedPlacement[] {
  if (items.length === 0) return [];

  const top = marginMm;
  const bottom = sheet.heightMm - marginMm;
  const left = marginMm;
  const right = sheet.widthMm - marginMm;
  const sheetCenterX = sheet.widthMm / 2;

  // For a row spanning [y, y+h), narrow [left, right) around any keepout it vertically overlaps —
  // a zone left of center pushes the row's left edge in; a zone right of center pushes the right
  // edge in. Assumes keepouts sit near the sheet's corners, not the middle of an edge.
  function rowBounds(y: number, h: number): { left: number; right: number } {
    let l = left;
    let r = right;
    for (const z of keepouts) {
      if (y >= z.y + z.h || y + h <= z.y) continue; // no vertical overlap
      if (z.x + z.w / 2 < sheetCenterX) l = Math.max(l, z.x + z.w + gapMm);
      else r = Math.min(r, z.x - gapMm);
    }
    return { left: l, right: r };
  }

  const placements: MixedPlacement[] = [];
  let shelfY = top;
  let shelfH = 0;
  let cursorX: number | null = null;

  function placeOne(item: MixedItem): boolean {
    if (item.widthMm > right - left || item.heightMm > bottom - top) return false;

    let bounds = rowBounds(shelfY, item.heightMm);
    if (cursorX === null) cursorX = bounds.left;

    if (cursorX + item.widthMm > bounds.right) {
      // wrap to a new shelf
      shelfY += shelfH + gapMm;
      shelfH = 0;
      bounds = rowBounds(shelfY, item.heightMm);
      cursorX = bounds.left;
    }

    if (shelfY + item.heightMm > bottom) return false; // out of vertical room
    if (cursorX + item.widthMm > bounds.right) return false; // row too narrow even after wrapping (squeezed between keepouts)

    placements.push({ id: item.id, x: cursorX, y: shelfY });
    cursorX += item.widthMm + gapMm;
    shelfH = Math.max(shelfH, item.heightMm);
    return true;
  }

  if (mode === "single") {
    for (const item of items) placeOne(item);
    return placements;
  }

  // fill: round-robin through the items, stop once a full pass places nothing
  let placedAnyThisPass = true;
  while (placedAnyThisPass) {
    placedAnyThisPass = false;
    for (const item of items) {
      if (placeOne(item)) placedAnyThisPass = true;
    }
  }
  return placements;
}
