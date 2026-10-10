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
}

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
export const PAPER_TYPES: PaperType[] = [
  { id: "white", name: "White sticker", adhesive: true, swatch: "#ffffff", exportColor: "#ffffff", showBorder: true, cutMaterial: STICKER_PAPER },
  {
    id: "clear",
    name: "Clear sticker",
    adhesive: true,
    swatch: "repeating-conic-gradient(#3a3a44 0% 25%, #dcdce2 0% 50%) 50% / 10px 10px",
    exportColor: "transparent",
    showBorder: false,
    cutMaterial: STICKER_PAPER,
  },
  {
    id: "holographic",
    name: "Holographic sticker",
    adhesive: true,
    swatch: "linear-gradient(135deg, #c9f0ff, #e8c9ff, #ffd6e8, #fff3c4, #c9ffe0)",
    exportColor: "transparent",
    showBorder: false,
    cutMaterial: STICKER_PAPER,
    colorAdjust: HOLOGRAPHIC_COLOR_ADJUST,
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
