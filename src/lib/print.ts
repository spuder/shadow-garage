import { decodeImages } from "./printArtwork";

const PRINT_AREA_ID = "printArea";

/**
 * Prints an SVG (with physical mm width/height, as produced by svgBuilder.ts) via the browser's
 * native print dialog. Swaps it into a dedicated print-only node rather than opening a new
 * window/tab, so it inherits the current page's print CSS (see the `@media print` rules in
 * style.css) with no extra popup permissions needed. Waits until every image in it is decoded and
 * the node has been laid out, so the print never captures it with artwork still loading.
 */
export async function printSvg(svgMarkup: string) {
  let printArea = document.getElementById(PRINT_AREA_ID);
  if (!printArea) {
    printArea = document.createElement("div");
    printArea.id = PRINT_AREA_ID;
    document.body.appendChild(printArea);
  }
  await decodeImages(svgMarkup);
  printArea.innerHTML = svgMarkup;
  // Two frames lets the node lay out; the timeout covers a background tab, where frames don't run.
  await new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
    setTimeout(resolve, 200);
  });
  window.print();
}
