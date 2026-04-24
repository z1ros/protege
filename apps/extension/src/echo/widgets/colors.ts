/**
 * Shared chart palette for the Phase 1B signature visuals. Widgets that
 * can't lean on VSCode theme tokens (SVG fills, category markers) import
 * from here so hue choices stay consistent across the dashboard.
 */

export const ECHO_PALETTE = {
  accent: "#58a6ff",
  accentSoft: "rgba(88, 166, 255, 0.35)",
  accentFill: "rgba(88, 166, 255, 0.15)",
  focusLine: "#58a6ff",
  focusArea: "rgba(88, 166, 255, 0.12)",
  polarArc: "#7ee787",
  polarArcSoft: "rgba(126, 231, 135, 0.35)",
  ring: "rgba(255, 255, 255, 0.08)",
  ringFill: "#58a6ff",
  muted: "#8b949e",
  success: "#7ee787",
  warning: "#f0b84a",
  danger: "#f85149",
  purple: "#bc8cff",
  gray: "#6e7681",
} as const;

/**
 * 7-entry harmonized palette for the W2 polar-clock concentric rings.
 * Hues cycle through the spectrum (green → teal → blue → indigo → purple →
 * rose → amber) so adjacent rings stay distinguishable when stacked. Tuned
 * for a dark VSCode background — muted saturation, high enough luminance
 * to read against #0d1117.
 */
export const POLAR_RING_COLORS: readonly string[] = [
  "#7ee787", // green
  "#4ac0b0", // teal
  "#58a6ff", // blue
  "#8c7dff", // indigo
  "#bc8cff", // purple
  "#ff8ab0", // rose
  "#f0b84a", // amber
];

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}
