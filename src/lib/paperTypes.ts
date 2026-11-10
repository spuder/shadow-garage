import { PRINTER_PAPER_20LB, STICKER_PAPER, type CutMaterial } from "./cutter/materials";
import type { ColorAdjust } from "./colorAdjust";

export interface PaperType {
  id: string;
  name: string;
  /** Adhesive sticker stock (kiss cut, backing left intact) vs. plain paper (cut all the way through). */
  adhesive: boolean;
  swatch: string; // CSS background for the on-screen swatch button (can be a gradient/pattern)
  exportColor: string; // solid color actually used as the border fill in the rendered/exported SVG
  showBorder: boolean; // false = artwork sits on transparent background, no border fill at all
  /** Cutter settings used when cutting this paper type (src/lib/cutter/materials.ts). */
  cutMaterial: CutMaterial;
  /**
   * Starting point for the Color Adjust sliders on this stock (none = no adjustment). Inkjet dye ink
   * is translucent with no white ink, so foil/film stocks need darker, more saturated artwork.
   */
  colorAdjust?: ColorAdjust;
  /** Whether the Laminated box starts ticked for this stock: sheets usually laminated after printing. */
  laminatedByDefault?: boolean;
  /**
   * Set when the cutter's optical sensor usually can't read registration marks printed on this
   * stock: ink is see-through on foil and film, so the sensor sees shine (or the mat) rather than
   * matte black. `summary` is one short line shown under Print (it opens to `detail`); both are
   * added to a failed mark search's message.
   */
  marksTip?: { summary: string; detail: string };
}

const MATTE_PATCH_DETAIL =
  "Otherwise the cutter can't find the registration marks: inkjet ink is see-through on this stock, so its sensor sees shine instead of black. Stick matte white label paper or masking tape over the three corners where the marks print (about 30 mm in from each edge), so they print on something the sensor can see. Manual registration won't get around it: the cutter still reads the marks with its sensor.";

/**
 * Holographic starting point. Pale tints at 60 plus brightness -10 take a near-white like #f2f0e5
 * (~0.95) to ~0.61 and a mid tone of 0.5 to ~0.38, while a dark of 0.22 only drops to ~0.19, so
 * the pale bands of gradient art lay down enough ink to read on foil without crushing the shadows.
 */
export const HOLOGRAPHIC_COLOR_ADJUST: ColorAdjust = { brightness: -10, contrast: 0, saturation: 40, paleTints: 60 };

// Only stocks the app can print on honestly: the border around each design is filled with
// exportColor when printing, so a coloured stock (black, silver) would get a fake printed border
// rather than showing the real material. Holographic is allowed because it has no border fill
// (showBorder: false), so the foil itself shows around the artwork. Both sticker stocks share the one sticker
// cut preset; a stock that needs different settings gets its own entry in materials.ts.
/**
 * How many AutoBlade depth steps a laminated sheet adds to its paper type's depth: the clear
 * overlay (about 3 mil) is one more layer for the blade to get through. Pressure is left alone,
 * since extra pressure drags the mat on a Cameo 3.
 */
export const LAMINATE_EXTRA_DEPTH = 1;

export const PAPER_TYPES: PaperType[] = [
  { id: "white", name: "White sticker", adhesive: true, swatch: "#ffffff", exportColor: "#ffffff", showBorder: true, cutMaterial: STICKER_PAPER, laminatedByDefault: true },
  {
    id: "clear",
    name: "Clear sticker",
    adhesive: true,
    swatch: "repeating-conic-gradient(#3a3a44 0% 25%, #dcdce2 0% 50%) 50% / 10px 10px",
    exportColor: "transparent",
    showBorder: false,
    cutMaterial: STICKER_PAPER,
    marksTip: { summary: "Clear film: tape over the 3 mark corners before printing.", detail: MATTE_PATCH_DETAIL },
  },
  {
    id: "holographic",
    name: "Holographic sticker",
    adhesive: true,
    swatch: "linear-gradient(135deg, #c9f0ff, #e8c9ff, #ffd6e8, #fff3c4, #c9ffe0)",
    exportColor: "transparent",
    showBorder: false,
    cutMaterial: STICKER_PAPER,
    laminatedByDefault: true,
    colorAdjust: HOLOGRAPHIC_COLOR_ADJUST,
    marksTip: { summary: "Holographic: tape over the 3 mark corners before printing.", detail: MATTE_PATCH_DETAIL },
  },
  {
    id: "printer-paper-20lb",
    name: "20 lb printer paper",
    adhesive: false,
    swatch: "#f7f7f5",
    exportColor: "#ffffff",
    showBorder: true,
    cutMaterial: PRINTER_PAPER_20LB,
  },
];
