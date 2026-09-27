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
// Depth is inkscape-silhouette's "Sticker Sheet" entry (media 134). Its pressure 20 / speed 10 made
// the Cameo 3 bind up and lose position mid-job. Pressure 1 / speed 1 (the minimum) cuts cleanly on
// a Cameo 3: the AutoBlade depth does the cutting. Note: per upstream, a pressure of 19 or more makes the
// Cameo run its track-enhancing roller pass automatically.
export const STICKER_PAPER: CutMaterial = {
  id: "sticker-paper",
  name: "Sticker paper",
  mediaId: 134,
  pressure: 1,
  speed: 1,
  autoBladeDepth: 1,
};

// Plain 20 lb (75 g/m²) copy/printer paper: cut all the way through (there's no backing).
// Based on inkscape-silhouette's "Print Paper Light Weight" (media 132, pressure 5), with the blade
// out to 2 so it cuts through rather than scoring. At higher speeds plain paper tore and the
// carriage bound up, and pressure 10 skipped partway down the sheet on a Cameo 3 while a blade-up
// dry run of the same sheet was clean, so the blade was dragging. Pressure 1, speed 2 cut cleanly
// on a Cameo 3 (the AutoBlade at 2 does the cutting); 1 / 1 does too, like every material.
export const PRINTER_PAPER_20LB: CutMaterial = {
  id: "printer-paper-20lb",
  name: "20 lb printer paper",
  mediaId: 132,
  pressure: 1,
  speed: 1,
  autoBladeDepth: 2,
};

export const CUT_MATERIALS: CutMaterial[] = [STICKER_PAPER, PRINTER_PAPER_20LB];
