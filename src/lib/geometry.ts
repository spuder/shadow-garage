export type Point = [number, number];
export type Contour = Point[];

/** Douglas-Peucker polyline simplification. */
export function simplify(points: Contour, tolerance: number): Contour {
  if (points.length < 3) return points;

  function perpDist(p: Point, a: Point, b: Point): number {
    const [x, y] = p;
    const [x1, y1] = a;
    const [x2, y2] = b;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(x - x1, y - y1);
    const t = ((x - x1) * dx + (y - y1) * dy) / lenSq;
    const projX = x1 + t * dx;
    const projY = y1 + t * dy;
    return Math.hypot(x - projX, y - projY);
  }

  function rdp(pts: Contour): Contour {
    if (pts.length < 3) return pts;
    let maxDist = -1;
    let index = 0;
    const first = pts[0];
    const last = pts[pts.length - 1];
    for (let i = 1; i < pts.length - 1; i++) {
      const d = perpDist(pts[i], first, last);
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }
    if (maxDist > tolerance) {
      const left = rdp(pts.slice(0, index + 1));
      const right = rdp(pts.slice(index));
      return left.slice(0, -1).concat(right);
    }
    return [first, last];
  }

  return rdp(points);
}

/** Signed area (shoelace). Positive = counter-clockwise in a y-down coordinate system's mathematical sense; sign only matters relatively. */
export function signedArea(points: Contour): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

export function boundingBox(contours: Contour[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of contours) {
    for (const [x, y] of c) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return { minX, minY, maxX, maxY };
}

export function translateContours(contours: Contour[], dx: number, dy: number): Contour[] {
  return contours.map((c) => c.map(([x, y]) => [x + dx, y + dy] as Point));
}

export function scaleContours(contours: Contour[], sx: number, sy: number): Contour[] {
  return contours.map((c) => c.map(([x, y]) => [x * sx, y * sy] as Point));
}

/** Builds an SVG path `d` attribute from one or more closed contours (evenodd fill rule for holes). */
export function contoursToPathD(contours: Contour[], decimals = 3): string {
  return contours
    .map((c) => {
      if (c.length === 0) return "";
      const pts = c.map(([x, y]) => `${x.toFixed(decimals)},${y.toFixed(decimals)}`);
      return `M${pts[0]} L${pts.slice(1).join(" ")} Z`;
    })
    .join(" ");
}
