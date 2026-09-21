export interface Camera {
  scale: number; // screen px per mm
  tx: number; // screen px offset of mm-origin (0,0)
  ty: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Centers `contentW x contentH` (mm) inside `containerW x containerH` (px), leaving a little padding. */
export function fitCamera(containerW: number, containerH: number, contentW: number, contentH: number, padding = 0.92): Camera {
  const scale = Math.min(containerW / contentW, containerH / contentH) * padding;
  const tx = (containerW - contentW * scale) / 2;
  const ty = (containerH - contentH * scale) / 2;
  return { scale, tx, ty };
}

/** Zooms so the mm-point currently under (screenX, screenY) stays under the cursor. */
export function zoomAt(cam: Camera, screenX: number, screenY: number, factor: number, minScale: number, maxScale: number): Camera {
  const newScale = clamp(cam.scale * factor, minScale, maxScale);
  const mmX = (screenX - cam.tx) / cam.scale;
  const mmY = (screenY - cam.ty) / cam.scale;
  return { scale: newScale, tx: screenX - mmX * newScale, ty: screenY - mmY * newScale };
}

export function panBy(cam: Camera, dxPx: number, dyPx: number): Camera {
  return { ...cam, tx: cam.tx + dxPx, ty: cam.ty + dyPx };
}

export function mmToScreen(cam: Camera, mmX: number, mmY: number): [number, number] {
  return [cam.tx + mmX * cam.scale, cam.ty + mmY * cam.scale];
}

export function screenToMm(cam: Camera, sx: number, sy: number): [number, number] {
  return [(sx - cam.tx) / cam.scale, (sy - cam.ty) / cam.scale];
}
