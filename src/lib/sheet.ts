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

/**
 * Shelf-packs a mixed set of differently-sized items onto a sheet, round-robining across
 * items so a multi-design sheet comes out as a balanced set rather than "fill item 1 fully,
 * then item 2." `mode: "single"` places exactly one copy of each item; `"fill"` keeps
 * round-robining copies until nothing more fits.
 */
export function packMixedSheet(
  sheet: SheetSize,
  items: MixedItem[],
  gapMm: number,
  marginMm: number,
  mode: "single" | "fill"
): MixedPlacement[] {
  if (items.length === 0) return [];

  const usableW = sheet.widthMm - 2 * marginMm;
  const usableH = sheet.heightMm - 2 * marginMm;

  const placements: MixedPlacement[] = [];
  let shelfY = 0;
  let shelfH = 0;
  let cursorX = 0;

  function placeOne(item: MixedItem): boolean {
    if (item.widthMm > usableW || item.heightMm > usableH) return false;

    // wrap to a new shelf if this item doesn't fit on the current row
    if (cursorX > 0 && cursorX + item.widthMm > usableW) {
      shelfY += shelfH + gapMm;
      shelfH = 0;
      cursorX = 0;
    }
    if (shelfY + item.heightMm > usableH) return false; // out of vertical room

    placements.push({ id: item.id, x: marginMm + cursorX, y: marginMm + shelfY });
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
