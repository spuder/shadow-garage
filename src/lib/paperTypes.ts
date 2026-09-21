export interface PaperType {
  id: string;
  name: string;
  swatch: string; // CSS background for the on-screen swatch button (can be a gradient/pattern)
  exportColor: string; // solid color actually used as the border fill in the rendered/exported SVG
  showBorder: boolean; // false = artwork sits on transparent background, no border fill at all
}

export const PAPER_TYPES: PaperType[] = [
  { id: "white", name: "White", swatch: "#ffffff", exportColor: "#ffffff", showBorder: true },
  {
    id: "clear",
    name: "Clear",
    swatch: "repeating-conic-gradient(#3a3a44 0% 25%, #dcdce2 0% 50%) 50% / 10px 10px",
    exportColor: "transparent",
    showBorder: false,
  },
  {
    id: "holographic",
    name: "Holographic",
    swatch: "linear-gradient(120deg, #ff9a9e, #fad0c4, #fbc2eb, #a6c1ee, #a1ffce)",
    exportColor: "#dcd6f7",
    showBorder: true,
  },
  { id: "matte", name: "Matte Black", swatch: "#1c1c1e", exportColor: "#1c1c1e", showBorder: true },
  {
    id: "glossy-silver",
    name: "Glossy Silver",
    swatch: "linear-gradient(135deg, #f4f4f5, #c9c9cf, #f4f4f5)",
    exportColor: "#cfcfd4",
    showBorder: true,
  },
];
