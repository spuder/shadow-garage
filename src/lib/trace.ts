import type { Contour, Point } from "./geometry";
import { simplify, boundingBox, signedArea } from "./geometry";

export interface RawMask {
  data: Uint8Array; // 1 = opaque (inside artwork), 0 = transparent
  width: number;
  height: number;
  rawBBox: { minX: number; minY: number; maxX: number; maxY: number }; // bbox of the un-dilated silhouette, in mask px
}

/** Downscales the image onto an offscreen canvas and thresholds the alpha channel into a binary mask. */
export function extractAlphaMask(img: HTMLImageElement | HTMLCanvasElement, maskLongEdge = 500, alphaThreshold = 16): RawMask {
  const srcW = "naturalWidth" in img ? img.naturalWidth : img.width;
  const srcH = "naturalHeight" in img ? img.naturalHeight : img.height;
  const scale = maskLongEdge / Math.max(srcW, srcH);
  const drawW = Math.max(1, Math.round(srcW * scale));
  const drawH = Math.max(1, Math.round(srcH * scale));

  // Pad the canvas well beyond the drawn image so later dilation (for margin/merging) has
  // room to expand outward without being hard-clipped at the canvas edge — a source image
  // cropped tight to its content (little/no transparent padding) would otherwise get its
  // outline flattened wherever the artwork sits close to the image boundary.
  const pad = Math.round(Math.max(drawW, drawH) * 0.5);
  const width = drawW + 2 * pad;
  const height = drawH + 2 * pad;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, pad, pad, drawW, drawH);
  const imgData = ctx.getImageData(0, 0, width, height);

  const data = new Uint8Array(width * height);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = imgData.data[(y * width + x) * 4 + 3];
      const inside = alpha >= alphaThreshold ? 1 : 0;
      data[y * width + x] = inside;
      if (inside) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (minX === Infinity) {
    // fully transparent image (shouldn't normally happen) - fall back to full rect
    minX = 0; minY = 0; maxX = width - 1; maxY = height - 1;
    data.fill(1);
  }
  return { data, width, height, rawBBox: { minX, minY, maxX: maxX + 1, maxY: maxY + 1 } };
}

/** Two-pass chamfer distance transform: expands `mask` by ~`radiusPx` (Euclidean-ish, good enough for smoothing/merging). */
export function dilateMask(mask: Uint8Array, width: number, height: number, radiusPx: number): Uint8Array {
  if (radiusPx <= 0.01) return mask;
  const INF = 1e9;
  const dist = new Float32Array(width * height);
  for (let i = 0; i < mask.length; i++) dist[i] = mask[i] ? 0 : INF;

  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= width || y >= height ? INF : dist[y * width + x]);

  const D1 = 1;
  const D2 = Math.SQRT2;

  // forward pass
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let v = dist[y * width + x];
      v = Math.min(v, at(x - 1, y) + D1, at(x, y - 1) + D1, at(x - 1, y - 1) + D2, at(x + 1, y - 1) + D2);
      dist[y * width + x] = v;
    }
  }
  // backward pass
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      let v = dist[y * width + x];
      v = Math.min(v, at(x + 1, y) + D1, at(x, y + 1) + D1, at(x + 1, y + 1) + D2, at(x - 1, y + 1) + D2);
      dist[y * width + x] = v;
    }
  }

  const out = new Uint8Array(width * height);
  for (let i = 0; i < out.length; i++) out[i] = dist[i] <= radiusPx ? 1 : 0;
  return out;
}

interface Component {
  area: number;
  startX: number;
  startY: number;
}

/** Labels 8-connected components of `mask`, returning a start pixel (topmost-then-leftmost) for each component above minArea. */
function findComponents(mask: Uint8Array, width: number, height: number, minArea: number): Component[] {
  const labels = new Int32Array(width * height).fill(-1);
  const components: Component[] = [];
  const stack: number[] = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (mask[idx] !== 1 || labels[idx] !== -1) continue;

      // flood fill this component
      let area = 0;
      let startX = x, startY = y;
      stack.length = 0;
      stack.push(idx);
      labels[idx] = components.length;
      while (stack.length) {
        const cur = stack.pop()!;
        const cx = cur % width;
        const cy = (cur - cx) / width;
        area++;
        if (cy < startY || (cy === startY && cx < startX)) {
          startX = cx;
          startY = cy;
        }
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = cx + dx, ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const nidx = ny * width + nx;
            if (mask[nidx] === 1 && labels[nidx] === -1) {
              labels[nidx] = components.length;
              stack.push(nidx);
            }
          }
        }
      }
      if (area >= minArea) {
        components.push({ area, startX, startY });
      }
    }
  }
  return components;
}

// 8 neighbor offsets in a consistent clockwise cycle, starting at West.
const OFFSETS: Point[] = [
  [-1, 0], [-1, -1], [0, -1], [1, -1],
  [1, 0], [1, 1], [0, 1], [-1, 1],
];

function offsetIndex(cx: number, cy: number, px: number, py: number): number {
  const dx = px - cx, dy = py - cy;
  for (let i = 0; i < 8; i++) if (OFFSETS[i][0] === dx && OFFSETS[i][1] === dy) return i;
  return 0;
}

/** Moore-neighbor boundary tracing starting from a topmost-leftmost pixel of a connected component. */
function traceBoundary(mask: Uint8Array, width: number, height: number, startX: number, startY: number): Contour {
  const fg = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] === 1;

  const boundary: Point[] = [[startX, startY]];
  let cx = startX, cy = startY;
  let bx = startX - 1, by = startY; // west neighbor is guaranteed background (topmost-leftmost pixel)
  const maxSteps = width * height * 8 + 16;

  for (let step = 0; step < maxSteps; step++) {
    const startIdx = offsetIndex(cx, cy, bx, by);
    let moved = false;
    for (let k = 1; k <= 8; k++) {
      const [dx, dy] = OFFSETS[(startIdx + k) % 8];
      const px = cx + dx, py = cy + dy;
      if (fg(px, py)) {
        boundary.push([px, py]);
        bx = cx; by = cy;
        cx = px; cy = py;
        moved = true;
        break;
      } else {
        bx = px; by = py;
      }
    }
    if (!moved) break; // isolated single pixel
    if (cx === startX && cy === startY) {
      boundary.pop();
      break;
    }
  }
  return boundary;
}

/** Chaikin corner-cutting: turns a blocky pixel-boundary polygon into a smooth closed curve. */
function chaikinSmooth(points: Contour, iterations: number): Contour {
  let pts = points;
  for (let it = 0; it < iterations; it++) {
    const n = pts.length;
    if (n < 3) return pts;
    const next: Point[] = [];
    for (let i = 0; i < n; i++) {
      const p0 = pts[i];
      const p1 = pts[(i + 1) % n];
      next.push([0.75 * p0[0] + 0.25 * p1[0], 0.75 * p0[1] + 0.25 * p1[1]]);
      next.push([0.25 * p0[0] + 0.75 * p1[0], 0.25 * p0[1] + 0.75 * p1[1]]);
    }
    pts = next;
  }
  return pts;
}

export interface CutPathResult {
  contours: Contour[]; // in mask px space, smoothed, one closed contour per connected blob
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
}

/** Full pipeline: dilate the raw mask by `marginPx`, find blobs, trace + smooth each into a clean polygon. */
export function computeCutPath(raw: RawMask, marginPx: number, minAreaPx = 9): CutPathResult {
  // Defensive clamp: never dilate further than the mask canvas has room for, regardless of
  // how it was constructed — avoids a hard-clipped/flattened outline if a caller ever requests
  // a radius larger than the available padding.
  const safeRadiusPx = Math.min(marginPx, Math.min(raw.width, raw.height) * 0.4);
  const dilated = dilateMask(raw.data, raw.width, raw.height, safeRadiusPx);
  const components = findComponents(dilated, raw.width, raw.height, minAreaPx);

  const contours: Contour[] = [];
  for (const comp of components) {
    let poly = traceBoundary(dilated, raw.width, raw.height, comp.startX, comp.startY);
    if (poly.length < 3) continue;
    poly = simplify(poly, 0.75);
    poly = chaikinSmooth(poly, 2);
    poly = simplify(poly, 0.4);
    // normalize winding so all contours share the same orientation
    if (signedArea(poly) < 0) poly.reverse();
    contours.push(poly);
  }

  if (contours.length === 0) {
    // shouldn't happen once an image is loaded, but fall back to the raw bbox rectangle
    const { minX, minY, maxX, maxY } = raw.rawBBox;
    contours.push([[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]]);
  }

  return { contours, bbox: boundingBox(contours) };
}
