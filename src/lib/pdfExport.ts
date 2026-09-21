import { jsPDF } from "jspdf";
import "svg2pdf.js";

/** Renders an SVG markup string (with mm width/height) into a same-sized PDF and triggers a download. */
export async function exportSvgStringAsPdf(svgMarkup: string, widthMm: number, heightMm: number, filename: string) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgMarkup, "image/svg+xml");
  const svgEl = doc.documentElement as unknown as SVGSVGElement;

  // svg2pdf reads layout via the live DOM in some code paths; mount off-screen during conversion.
  const host = document.createElement("div");
  host.style.position = "fixed";
  host.style.left = "-99999px";
  host.style.top = "0";
  document.body.appendChild(host);
  host.appendChild(svgEl);

  try {
    const pdf = new jsPDF({
      orientation: widthMm > heightMm ? "landscape" : "portrait",
      unit: "mm",
      format: [widthMm, heightMm],
    });
    await pdf.svg(svgEl, { x: 0, y: 0, width: widthMm, height: heightMm });
    pdf.save(filename);
  } finally {
    document.body.removeChild(host);
  }
}

export function downloadSvgString(svgMarkup: string, filename: string) {
  const blob = new Blob([svgMarkup], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
