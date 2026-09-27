import { PRINTER_PAPER_20LB, STICKER_PAPER, type CutMaterial } from "./cutter/materials";

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
}

// Only stocks the app can print on honestly: the border around each design is filled with
// exportColor when printing, so a coloured stock (holographic, black, silver) would get a fake
// printed border rather than showing the real material. Both sticker stocks share the one sticker
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
    id: "printer-paper-20lb",
    name: "20 lb printer paper",
    adhesive: false,
    swatch: "#f7f7f5",
    exportColor: "#ffffff",
    showBorder: true,
    cutMaterial: PRINTER_PAPER_20LB,
  },
];
