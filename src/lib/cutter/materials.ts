// Cut settings per material, all for the AutoBlade. Each paper type (src/lib/paperTypes.ts) points
// at one of these, so choosing the paper type in the app also chooses how it's cut.

export interface CutMaterial {
  id: string;
  name: string;
  /** Silhouette media id (Graphtec.py MEDIA table). Informational on the Cameo 3, which doesn't take an FW command. */
  mediaId: number;
  pressure: number; // 1..33
  speed: number; // 1..10 on the Cameo 3
  autoBladeDepth: number; // 0..10, set by the AutoBlade itself via TF
}

// Adhesive sticker sheets: a kiss cut through the sticker layer, leaving the backing intact.
// Starting values are inkscape-silhouette's "Sticker Sheet" entry (media 134). They have not yet
// been tuned on real hardware for a clean kiss cut — adjust after test cuts. Note: per upstream,
// a pressure of 19 or more makes the Cameo run its track-enhancing roller pass automatically.
export const STICKER_PAPER: CutMaterial = {
  id: "sticker-paper",
  name: "Sticker paper",
  mediaId: 134,
  pressure: 20,
  speed: 10,
  autoBladeDepth: 1,
};

// Plain 20 lb (75 g/m²) copy/printer paper: cut all the way through (there's no backing).
// Based on inkscape-silhouette's "Print Paper Light Weight" (media 132, pressure 5), raised to 10
// with the blade out to 2 so it reliably cuts through rather than scoring, and slowed to 5: at the
// sticker preset's speed 10 and pressure 20, plain paper tore and the carriage lost position on the
// Cameo 3. Untested starting values — check with Test cut.
export const PRINTER_PAPER_20LB: CutMaterial = {
  id: "printer-paper-20lb",
  name: "20 lb printer paper",
  mediaId: 132,
  pressure: 10,
  speed: 5,
  autoBladeDepth: 2,
};

export const CUT_MATERIALS: CutMaterial[] = [STICKER_PAPER, PRINTER_PAPER_20LB];
