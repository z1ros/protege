/**
 * Pure camera math for the Skill Constellation. No refs, no DOM — every
 * function takes plain inputs and returns a target `{ x, y, k }` transform
 * the component can then animate toward.
 *
 * The constellation canvas transform is applied as:
 *   ctx.translate(t.x, t.y); ctx.scale(t.k, t.k);
 * so a world-point (wx, wy) lands at screen (t.x + wx*k, t.y + wy*k).
 * To *center* a world-point at screen (sw/2, sh/2) with zoom k:
 *   t.x = sw/2 - wx*k;  t.y = sh/2 - wy*k
 */

export interface Transform {
  x: number;
  y: number;
  k: number;
}

export interface Size {
  w: number;
  h: number;
}

export interface WorldPoint {
  x?: number | null;
  y?: number | null;
}

/** Cubic ease-out — snappy start, soft landing. */
export function easeOutCubic(u: number): number {
  return 1 - Math.pow(1 - u, 3);
}

/** Linearly interpolate two transforms. */
export function lerpTransform(a: Transform, b: Transform, t: number): Transform {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    k: a.k + (b.k - a.k) * t,
  };
}

/**
 * Compute a transform that frames all given nodes with padding.
 * Falls back to identity if no nodes have positions yet.
 *
 *   • padding — pixels of empty space around the bounding box at final zoom
 *   • minK / maxK — clamp the computed zoom so we don't slam to 0.1× or 8×
 */
export function computeFitAll(
  points: WorldPoint[],
  size: Size,
  opts: { padding?: number; minK?: number; maxK?: number } = {}
): Transform {
  const { padding = 70, minK = 0.4, maxK = 1.6 } = opts;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let found = false;
  for (const p of points) {
    if (p.x == null || p.y == null) continue;
    found = true;
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  if (!found) return { x: 0, y: 0, k: 1 };

  const bw = maxX - minX + padding * 2;
  const bh = maxY - minY + padding * 2;
  const kRaw = Math.min(size.w / bw, size.h / bh);
  const k = Math.max(minK, Math.min(maxK, kRaw));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return {
    x: size.w / 2 - cx * k,
    y: size.h / 2 - cy * k,
    k,
  };
}

/**
 * Compute a transform that centers a single node in the viewport at the
 * given zoom. Used for "fly to search result."
 */
export function computeFlyTo(
  node: WorldPoint,
  size: Size,
  zoom = 1.6
): Transform | null {
  if (node.x == null || node.y == null) return null;
  return {
    x: size.w / 2 - node.x * zoom,
    y: size.h / 2 - node.y * zoom,
    k: zoom,
  };
}
