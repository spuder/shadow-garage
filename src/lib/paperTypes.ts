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

// The sticker stocks all share the one tuned sticker preset for now; a stock that needs different
// settings (thick vinyl, holographic film) gets its own entry in materials.ts.
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
    swatch: "linear-gradient(120deg, #ff9a9e, #fad0c4, #fbc2eb, #a6c1ee, #a1ffce)",
    exportColor: "#dcd6f7",
    showBorder: true,
    cutMaterial: STICKER_PAPER,
  },
  { id: "matte", name: "Matte black sticker", adhesive: true, swatch: "#1c1c1e", exportColor: "#1c1c1e", showBorder: true, cutMaterial: STICKER_PAPER },
  {
    id: "glossy-silver",
    name: "Glossy silver sticker",
    adhesive: true,
    swatch: "linear-gradient(135deg, #f4f4f5, #c9c9cf, #f4f4f5)",
    exportColor: "#cfcfd4",
    showBorder: true,
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
