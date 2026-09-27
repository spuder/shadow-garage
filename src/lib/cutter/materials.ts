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
// Pressure and depth are inkscape-silhouette's "Sticker Sheet" entry (media 134), not yet tuned for
// a clean kiss cut. Its speed 10 (the Cameo 3's maximum) made the carriage bind up and lose
// position mid-job, shifting everything cut afterwards, so it's halved. Note: per upstream, a
// pressure of 19 or more makes the Cameo run its track-enhancing roller pass automatically.
export const STICKER_PAPER: CutMaterial = {
  id: "sticker-paper",
  name: "Sticker paper",
  mediaId: 134,
  pressure: 20,
  speed: 5,
  autoBladeDepth: 1,
};

// Plain 20 lb (75 g/m²) copy/printer paper: cut all the way through (there's no backing).
// Based on inkscape-silhouette's "Print Paper Light Weight" (media 132, pressure 5), raised to 10
// with the blade out to 2 so it reliably cuts through rather than scoring, and slowed to 3: at
// higher speeds plain paper tore and the carriage bound up and lost position on the Cameo 3.
// Untested starting values — check with Test cut.
export const PRINTER_PAPER_20LB: CutMaterial = {
  id: "printer-paper-20lb",
  name: "20 lb printer paper",
  mediaId: 132,
  pressure: 10,
  speed: 3,
  autoBladeDepth: 2,
};

export const CUT_MATERIALS: CutMaterial[] = [STICKER_PAPER, PRINTER_PAPER_20LB];
