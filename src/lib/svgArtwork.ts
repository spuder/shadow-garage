/** Whether a dropped or picked file is an SVG (by type, or by name when the browser gives none). */
export function isSvgFile(file: { name: string; type: string }): boolean {
  return file.type === "image/svg+xml" || /\.svg$/i.test(file.name);
}
