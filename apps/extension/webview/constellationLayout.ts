/**
 * Layout helpers for the Skill Constellation's wheel template design.
 *
 * POE-style clusters: each topic becomes a **wheel** with the notable
 * at its center and passives arranged evenly on a ring around it. The
 * wheel's world position is decided by a topic-level d3-force simulation;
 * the INNER geometry is static and identical across every topic, so the
 * brain learns the shape once and caches it.
 *
 * Domain territories: a faint convex-hull polygon drawn behind each
 * domain's nodes so you can see "where" each brand's space is on the map.
 */

export interface Point {
  x: number;
  y: number;
}

export interface RosetteInput {
  id: string;
  tier: "notable" | "passive";
}

/**
 * Compute fixed per-skill offsets inside a topic wheel.
 *
 * One skill (the notable, or the first skill if no notable) sits at the
 * center. The rest are placed evenly on a ring whose radius scales with
 * skill count — enough to fit without crowding, not so big that wheels
 * overlap their neighbors.
 */
export function computeRosetteOffsets(
  skills: RosetteInput[]
): Map<string, { dx: number; dy: number }> {
  const offsets = new Map<string, { dx: number; dy: number }>();
  if (skills.length === 0) return offsets;

  // Notable → center; everyone else orbits. Stable sort so the same
  // skill always ends up at the same slot across re-renders.
  const sorted = [...skills].sort((a, b) => {
    if (a.tier !== b.tier) return a.tier === "notable" ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
  const [center, ...ring] = sorted;
  offsets.set(center.id, { dx: 0, dy: 0 });

  const n = ring.length;
  if (n === 0) return offsets;

  // Ring radius scales with count; clamped tight so wheels stay compact
  // and more topics fit on a single screen. Was 26–66 @ n*2.2; the new
  // range gives ~20% smaller wheels so a fullscreen fit shows meaningfully
  // more of the map without making individual skills unclickable.
  const R = Math.max(22, Math.min(52, 16 + n * 1.8));
  // Offset phase so odd/even counts don't always snap to N/S
  const phase = -Math.PI / 2 + (n % 2 === 0 ? Math.PI / n : 0);

  for (let i = 0; i < n; i++) {
    const angle = phase + (i / n) * Math.PI * 2;
    offsets.set(ring[i].id, {
      dx: Math.cos(angle) * R,
      dy: Math.sin(angle) * R,
    });
  }
  return offsets;
}

/**
 * Collision radius for a topic wheel — big enough that rings don't
 * overlap neighboring wheels but tight enough that clusters feel like
 * a dense constellation, not a sparse cloud. Matches `computeRosetteOffsets`.
 */
export function topicWheelRadius(skillCount: number): number {
  const ringR = Math.max(22, Math.min(52, 16 + Math.max(0, skillCount - 1) * 1.8));
  return ringR + 8;
}

/* ============================================================
   Convex hull (Andrew's monotone chain) — used for domain territories
   ============================================================ */

function cross(O: Point, A: Point, B: Point): number {
  return (A.x - O.x) * (B.y - O.y) - (A.y - O.y) * (B.x - O.x);
}

/**
 * O(n log n) convex hull. Returns the outer points in counter-clockwise
 * order. For fewer than 3 input points, returns the input as-is (a line
 * or single point doesn't enclose area, so the caller should skip draw).
 */
export function convexHull(points: Point[]): Point[] {
  if (points.length < 3) return [...points];
  const sorted = [...points].sort((a, b) => (a.x - b.x) || (a.y - b.y));
  const lower: Point[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * Inflate a hull outward by `padding` pixels — shift each vertex along
 * its outward normal (the bisector of its two adjacent edges). Gives the
 * territory polygon breathing room around the skills it contains.
 */
export function expandHull(hull: Point[], padding: number): Point[] {
  if (hull.length < 3) return hull;
  const n = hull.length;
  const result: Point[] = [];
  // Centroid fallback — push each vertex radially away from the centroid
  // if bisector math is unstable (very obtuse angles).
  let cx = 0;
  let cy = 0;
  for (const p of hull) { cx += p.x; cy += p.y; }
  cx /= n;
  cy /= n;

  for (let i = 0; i < n; i++) {
    const p = hull[i];
    const dx = p.x - cx;
    const dy = p.y - cy;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    result.push({
      x: p.x + (dx / d) * padding,
      y: p.y + (dy / d) * padding,
    });
  }
  return result;
}
