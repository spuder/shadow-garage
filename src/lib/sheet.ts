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
  x: number; // top-left of the sticker's bounding box as placed (i.e. after any rotation)
  y: number;
  rotated: boolean; // turned a quarter turn clockwise, so it occupies heightMm x widthMm
}

export interface KeepoutRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const EPS = 1e-6;

function rectContains(outer: KeepoutRect, inner: KeepoutRect): boolean {
  return (
    inner.x >= outer.x - EPS &&
    inner.y >= outer.y - EPS &&
    inner.x + inner.w <= outer.x + outer.w + EPS &&
    inner.y + inner.h <= outer.y + outer.h + EPS
  );
}

/** rows: topmost then leftmost. columns: leftmost then topmost. snug: the hole it fills most exactly. */
type Heuristic = "rows" | "columns" | "snug";

/** How far right/down a placement may reach; used to hold one orientation inside a band. */
interface Reach {
  maxRight: number;
  maxBottom: number;
}

const ANYWHERE: Reach = { maxRight: Infinity, maxBottom: Infinity };

interface Spot {
  x: number;
  y: number;
  a: number; // primary score, lower is better
  b: number; // tie-break
}

function betterSpot(s: Spot, than: Spot | null): boolean {
  if (!than) return true;
  if (Math.abs(s.a - than.a) > EPS) return s.a < than.a;
  return s.b < than.b - EPS;
}

/**
 * The unused part of the sheet as a set of maximal free rectangles ("MaxRects"): every free
 * rectangle is as large as it can be, and they overlap each other. Unlike a shelf, this lets a
 * later sticker drop into the space left under a short one or beside a keepout.
 */
class FreeSpace {
  private free: KeepoutRect[];

  constructor(area: KeepoutRect, holes: KeepoutRect[] = []) {
    this.free = [area];
    for (const h of holes) this.occupy(h);
  }

  clone(): FreeSpace {
    const copy = new FreeSpace({ x: 0, y: 0, w: 0, h: 0 });
    copy.free = this.free.slice();
    return copy;
  }

  find(w: number, h: number, heuristic: Heuristic, reach: Reach): Spot | null {
    let best: Spot | null = null;
    for (const f of this.free) {
      if (w > f.w + EPS || h > f.h + EPS) continue;
      if (f.x + w > reach.maxRight + EPS || f.y + h > reach.maxBottom + EPS) continue;
      let spot: Spot;
      if (heuristic === "rows") spot = { x: f.x, y: f.y, a: f.y, b: f.x };
      else if (heuristic === "columns") spot = { x: f.x, y: f.y, a: f.x, b: f.y };
      else spot = { x: f.x, y: f.y, a: Math.min(f.w - w, f.h - h), b: Math.max(f.w - w, f.h - h) };
      if (betterSpot(spot, best)) best = spot;
    }
    return best;
  }

  occupy(r: KeepoutRect): void {
    const kept: KeepoutRect[] = [];
    const fresh: KeepoutRect[] = [];
    for (const f of this.free) {
      if (r.x >= f.x + f.w - EPS || r.x + r.w <= f.x + EPS || r.y >= f.y + f.h - EPS || r.y + r.h <= f.y + EPS) {
        kept.push(f);
        continue;
      }
      // Split what's left of f into the (overlapping) full-height / full-width strips around r.
      if (r.x > f.x + EPS) fresh.push({ x: f.x, y: f.y, w: r.x - f.x, h: f.h });
      if (r.x + r.w < f.x + f.w - EPS) fresh.push({ x: r.x + r.w, y: f.y, w: f.x + f.w - (r.x + r.w), h: f.h });
      if (r.y > f.y + EPS) fresh.push({ x: f.x, y: f.y, w: f.w, h: r.y - f.y });
      if (r.y + r.h < f.y + f.h - EPS) fresh.push({ x: f.x, y: r.y + r.h, w: f.w, h: f.y + f.h - (r.y + r.h) });
    }
    // Only the new pieces can be redundant: an untouched rectangle was already maximal.
    fresh.forEach((piece, i) => {
      const redundant =
        kept.some((k) => rectContains(k, piece)) ||
        fresh.some((o, j) => j !== i && rectContains(o, piece) && (j < i || !rectContains(piece, o)));
      if (!redundant) kept.push(piece);
    });
    this.free = kept;
  }
}

/** never: upright only. ifNeeded: upright unless only turned fits. preferred: the reverse. best: whichever scores better. */
type Turn = "never" | "ifNeeded" | "preferred" | "best";

interface Strategy {
  heuristic: Heuristic;
  turn: Turn;
}

/**
 * Packs a mixed set of differently-sized items onto a sheet. `mode: "single"` places one copy of
 * each item; `"fill"` places as many balanced sets as fit (the same number of every design) and
 * then tops the sheet up with whatever still fits. `keepouts` are rectangles (e.g. registration
 * mark corners) to route around: stickers stay `gapMm` clear of their sides, and may sit directly
 * above or below them. With `allowRotation`, a sticker may be turned a quarter turn when that
 * fits more on the sheet.
 *
 * Several layouts are tried (plain shelves of upright rows, then free space tracked as maximal
 * rectangles under a few placement strategies) and the one that fits the most wins, with ties
 * going to the plainest.
 */
export function packMixedSheet(
  sheet: SheetSize,
  items: MixedItem[],
  gapMm: number,
  marginMm: number,
  mode: "single" | "fill",
  keepouts: KeepoutRect[] = [],
  allowRotation = true
): MixedPlacement[] {
  if (items.length === 0) return [];

  const usableW = sheet.widthMm - 2 * marginMm;
  const usableH = sheet.heightMm - 2 * marginMm;
  if (usableW <= 0 || usableH <= 0) return [];

  // Every sticker is packed as if it were gapMm bigger on its right and bottom, with the sheet
  // grown to match, so abutting rectangles end up exactly gapMm apart. Keepouts grow sideways the
  // same way, and start gapMm lower so a sticker's bottom allowance may overlap their top edge
  // (capped at half their height, so a gap bigger than the keepout can't make it vanish).
  const area: KeepoutRect = { x: marginMm, y: marginMm, w: usableW + gapMm, h: usableH + gapMm };
  const empty = new FreeSpace(
    area,
    keepouts.map((z) => {
      const drop = Math.min(gapMm, z.h / 2);
      return { x: z.x, y: z.y + drop, w: z.w + gapMm, h: z.h - drop };
    })
  );

  /**
   * Upright rows, each as tall as its tallest sticker and narrowed around any keepout it
   * overlaps. Never the tightest, but always tidy, and a floor for the strategies below.
   */
  function packShelves(): MixedPlacement[] {
    const bottom = sheet.heightMm - marginMm;
    const rowBounds = (y: number, h: number): { left: number; right: number } => {
      let l = marginMm;
      let r = sheet.widthMm - marginMm;
      for (const z of keepouts) {
        if (y >= z.y + z.h || y + h <= z.y) continue; // no vertical overlap
        if (z.x + z.w / 2 < sheet.widthMm / 2) l = Math.max(l, z.x + z.w + gapMm);
        else r = Math.min(r, z.x - gapMm);
      }
      return { left: l, right: r };
    };

    const placed: MixedPlacement[] = [];
    let shelfY = marginMm;
    let shelfH = 0;
    let cursorX: number | null = null;
    const placeOne = (item: MixedItem): boolean => {
      if (item.widthMm > usableW || item.heightMm > usableH) return false;
      let bounds = rowBounds(shelfY, item.heightMm);
      // A taller sticker can reach a keepout the row's earlier ones cleared, so re-check the left edge.
      cursorX = cursorX === null ? bounds.left : Math.max(cursorX, bounds.left);
      if (cursorX + item.widthMm > bounds.right) {
        // wrap to a new shelf
        shelfY += shelfH + gapMm;
        shelfH = 0;
        bounds = rowBounds(shelfY, item.heightMm);
        cursorX = bounds.left;
      }
      if (shelfY + item.heightMm > bottom) return false; // out of vertical room
      if (cursorX + item.widthMm > bounds.right) return false; // row too narrow even after wrapping (squeezed between keepouts)
      placed.push({ id: item.id, x: cursorX, y: shelfY, rotated: false });
      cursorX += item.widthMm + gapMm;
      shelfH = Math.max(shelfH, item.heightMm);
      return true;
    };

    let placedAny = true;
    while (placedAny) {
      placedAny = false;
      for (const item of items) {
        if (placeOne(item)) placedAny = true;
      }
      if (mode === "single") break;
    }
    return placed;
  }

  function place(space: FreeSpace, item: MixedItem, strategy: Strategy, reach: Reach = ANYWHERE): MixedPlacement | null {
    const turnable = allowRotation && strategy.turn !== "never" && Math.abs(item.widthMm - item.heightMm) > EPS;
    const orientations = !turnable ? [false] : strategy.turn === "preferred" ? [true, false] : [false, true];
    let best: { spot: Spot; rotated: boolean } | null = null;
    for (const rotated of orientations) {
      const w = (rotated ? item.heightMm : item.widthMm) + gapMm;
      const h = (rotated ? item.widthMm : item.heightMm) + gapMm;
      const spot = space.find(w, h, strategy.heuristic, reach);
      if (!spot) continue;
      if (!best || (strategy.turn === "best" && betterSpot(spot, best.spot))) best = { spot, rotated };
      if (strategy.turn !== "best") break;
    }
    if (!best) return null;
    const { spot, rotated } = best;
    space.occupy({
      x: spot.x,
      y: spot.y,
      w: (rotated ? item.heightMm : item.widthMm) + gapMm,
      h: (rotated ? item.widthMm : item.heightMm) + gapMm,
    });
    return { id: item.id, x: spot.x, y: spot.y, rotated };
  }

  const turns: Turn[] = allowRotation ? ["never", "ifNeeded", "preferred", "best"] : ["never"];
  const strategies: Strategy[] = [];
  for (const turn of turns) {
    strategies.push({ heuristic: "rows", turn });
    if (turn === "ifNeeded" || turn === "preferred") strategies.push({ heuristic: "columns", turn });
  }
  strategies.push({ heuristic: "snug", turn: "never" });
  if (allowRotation) strategies.push({ heuristic: "snug", turn: "best" });

  // Biggest first: large stickers need the open space, small ones fit in what's left.
  const bigFirst = items
    .slice()
    .sort((p, q) => Math.max(q.widthMm, q.heightMm) - Math.max(p.widthMm, p.heightMm) || q.widthMm * q.heightMm - p.widthMm * p.heightMm);

  if (mode === "single") {
    const orders = [items, bigFirst, items.slice().sort((p, q) => q.heightMm - p.heightMm)];
    let best = packShelves();
    if (best.length === items.length) return best;
    for (const order of orders) {
      for (const strategy of strategies) {
        const space = empty.clone();
        const placed: MixedPlacement[] = [];
        for (const item of order) {
          const p = place(space, item, strategy);
          if (p) placed.push(p);
        }
        if (placed.length === items.length) return placed;
        if (placed.length > best.length) best = placed;
      }
    }
    return best;
  }

  // ---- fill ----
  /** Keeps placing one of each (in `order`) until a whole pass places nothing. */
  function topUp(space: FreeSpace, placed: MixedPlacement[], order: MixedItem[], strategy: Strategy, reach: Reach = ANYWHERE): void {
    let placedAny = true;
    while (placedAny) {
      placedAny = false;
      for (const item of order) {
        const p = place(space, item, strategy, reach);
        if (p) {
          placed.push(p);
          placedAny = true;
        }
      }
    }
  }

  const candidates: MixedPlacement[][] = [packShelves()];

  for (const strategy of strategies) {
    let space = empty.clone();
    let placed: MixedPlacement[] = [];
    if (bigFirst.length > 1) {
      // Find the most complete sets that fit, each design's copies grouped together (which packs
      // far tighter than interleaving different sizes), biggest design first.
      const packSets = (sets: number): { space: FreeSpace; placed: MixedPlacement[] } | null => {
        const s = empty.clone();
        const out: MixedPlacement[] = [];
        for (const item of bigFirst) {
          for (let n = 0; n < sets; n++) {
            const p = place(s, item, strategy);
            if (!p) return null;
            out.push(p);
          }
        }
        return { space: s, placed: out };
      };
      const setArea = bigFirst.reduce((sum, it) => sum + (it.widthMm + gapMm) * (it.heightMm + gapMm), 0);
      let lo = 0;
      let hi = Math.floor((area.w * area.h) / setArea);
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        const attempt = packSets(mid);
        if (attempt) {
          lo = mid;
          space = attempt.space;
          placed = attempt.placed;
        } else {
          hi = mid - 1;
        }
      }
    }
    topUp(space, placed, bigFirst, strategy);
    candidates.push(placed);
  }

  if (bigFirst.length === 1 && allowRotation && Math.abs(bigFirst[0].widthMm - bigFirst[0].heightMm) > EPS) {
    // One design: also try an upright block of r rows (or c columns) with the rest of the sheet
    // turned. Giving up an upright row can make room for more than a row's worth turned.
    const item = bigFirst[0];
    const stepX = item.widthMm + gapMm;
    const stepY = item.heightMm + gapMm;
    const bands: { heuristic: Heuristic; reach: Reach }[] = [];
    for (let r = 1; r * stepY <= area.h + EPS; r++) bands.push({ heuristic: "rows", reach: { maxRight: Infinity, maxBottom: area.y + r * stepY } });
    for (let c = 1; c * stepX <= area.w + EPS; c++) bands.push({ heuristic: "columns", reach: { maxRight: area.x + c * stepX, maxBottom: Infinity } });
    for (const band of bands) {
      const space = empty.clone();
      const placed: MixedPlacement[] = [];
      topUp(space, placed, bigFirst, { heuristic: band.heuristic, turn: "never" }, band.reach);
      topUp(space, placed, bigFirst, { heuristic: band.heuristic, turn: "preferred" });
      candidates.push(placed);
    }
  }

  // Compare each layout's per-design counts from the scarcest design up, so whole sets count for
  // more than extra copies of whatever is smallest; the earliest (plainest) layout wins ties.
  const tally = (placed: MixedPlacement[]): number[] => items.map((it) => placed.filter((p) => p.id === it.id).length).sort((p, q) => p - q);
  let best = candidates[0];
  let bestTally = tally(best);
  for (const placed of candidates.slice(1)) {
    const t = tally(placed);
    const firstDiff = t.findIndex((n, i) => n !== bestTally[i]);
    if (firstDiff >= 0 && t[firstDiff] > bestTally[firstDiff]) {
      best = placed;
      bestTally = t;
    }
  }
  return best;
}

/**
 * The keepout that makes the packer leave `gapMm` clear on every side of a sticker that is fixed
 * in place. The packer lets a sticker touch the top and bottom of a keepout (it was written for
 * registration-mark clearance zones), so this one is `gapMm` taller at both ends.
 */
export function stickerKeepout(rect: KeepoutRect, gapMm: number): KeepoutRect {
  return { x: rect.x, y: rect.y - gapMm, w: rect.w, h: rect.h + 2 * gapMm };
}

/**
 * The nearest spot to `rect` that is inside the sheet's margin and clear of the keepouts, so a
 * sticker moves only as far as it has to. A rect that is already fine comes back exactly as it
 * was; one with nowhere better to go (bigger than the area) is left as near as it can get.
 */
export function nudgeIntoArea(rect: KeepoutRect, sheet: SheetSize, marginMm: number, keepouts: KeepoutRect[]): { x: number; y: number } {
  const maxX = Math.max(marginMm, sheet.widthMm - marginMm - rect.w);
  const maxY = Math.max(marginMm, sheet.heightMm - marginMm - rect.h);
  let x = Math.min(Math.max(rect.x, marginMm), maxX);
  let y = Math.min(Math.max(rect.y, marginMm), maxY);
  const hit = (px: number, py: number) => keepouts.find((z) => px < z.x + z.w && z.x < px + rect.w && py < z.y + z.h && z.y < py + rect.h);
  for (let pass = 0; pass <= keepouts.length; pass++) {
    const z = hit(x, y);
    if (!z) break;
    const spots = [
      { x: z.x + z.w, y },
      { x: z.x - rect.w, y },
      { x, y: z.y + z.h },
      { x, y: z.y - rect.h },
    ]
      .filter((p) => p.x >= marginMm && p.x <= maxX && p.y >= marginMm && p.y <= maxY && !hit(p.x, p.y))
      .sort((a, b) => Math.abs(a.x - x) + Math.abs(a.y - y) - (Math.abs(b.x - x) + Math.abs(b.y - y)));
    if (spots.length === 0) break;
    ({ x, y } = spots[0]);
  }
  return { x, y };
}
