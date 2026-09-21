const PRINT_AREA_ID = "printArea";

/**
 * Prints an SVG (with physical mm width/height, as produced by svgBuilder.ts) via the browser's
 * native print dialog. Swaps it into a dedicated print-only node rather than opening a new
 * window/tab, so it inherits the current page's print CSS (see the `@media print` rules in
 * style.css) with no extra popup permissions needed.
 */
export function printSvg(svgMarkup: string) {
  let printArea = document.getElementById(PRINT_AREA_ID);
  if (!printArea) {
    printArea = document.createElement("div");
    printArea.id = PRINT_AREA_ID;
    document.body.appendChild(printArea);
  }
  printArea.innerHTML = svgMarkup;
  window.print();
}
