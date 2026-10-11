export function downloadSvgString(svgMarkup: string, filename: string) {
  downloadBlob(new Blob([svgMarkup], { type: "image/svg+xml" }), filename);
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
