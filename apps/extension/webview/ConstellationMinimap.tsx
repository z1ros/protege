import React, { useCallback, useEffect, useRef } from "react";
import type { Transform } from "./constellationCamera";

/** Minimum shape the minimap needs from each constellation node. */
export interface MinimapNode {
  x?: number | null;
  y?: number | null;
  color: string;
  detected?: boolean;
  matchesFilter?: boolean;
}

interface Props {
  nodesRef: React.MutableRefObject<MinimapNode[]>;
  transformRef: React.MutableRefObject<Transform>;
  /** Main canvas size — used to project the viewport rectangle. */
  mainSize: { w: number; h: number };
  /** Called with world coords when the user clicks in the minimap. */
  onJumpTo: (worldX: number, worldY: number) => void;
}

const MINI_W = 150;
const MINI_H = 96;
const PAD = 16;

/**
 * Tiny overlay that shows the whole constellation at a glance, with a
 * viewport rectangle indicating the main camera's current view. Click to
 * pan the main camera to that world point. Redraws on RAF so the viewport
 * rectangle tracks pans/zooms in real time, including the easing animation.
 */
export function ConstellationMinimap({ nodesRef, transformRef, mainSize, onJumpTo }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boundsRef = useRef({ minX: 0, maxX: 0, minY: 0, maxY: 0, found: false });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = MINI_W * dpr;
    canvas.height = MINI_H * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    const render = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, MINI_W, MINI_H);

      // Backdrop — deep-space navy with a thin electric border.
      ctx.fillStyle = "rgba(8,14,32,0.88)";
      ctx.fillRect(0, 0, MINI_W, MINI_H);
      ctx.strokeStyle = "rgba(74,158,255,0.22)";
      ctx.lineWidth = 1;
      ctx.strokeRect(0.5, 0.5, MINI_W - 1, MINI_H - 1);

      const nodes = nodesRef.current;
      if (!nodes || nodes.length === 0) {
        raf = requestAnimationFrame(render);
        return;
      }

      // World-space bounds over every placed node (no filter — users want
      // the minimap to reflect the whole map, even when some filters dim).
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      let found = false;
      for (const n of nodes) {
        if (n.x == null || n.y == null) continue;
        found = true;
        if (n.x < minX) minX = n.x;
        if (n.x > maxX) maxX = n.x;
        if (n.y < minY) minY = n.y;
        if (n.y > maxY) maxY = n.y;
      }
      boundsRef.current = { minX, maxX, minY, maxY, found };
      if (!found) {
        raf = requestAnimationFrame(render);
        return;
      }

      const bw = Math.max(1, maxX - minX + PAD * 2);
      const bh = Math.max(1, maxY - minY + PAD * 2);
      const k = Math.min(MINI_W / bw, MINI_H / bh);
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      const toX = (wx: number) => MINI_W / 2 + (wx - cx) * k;
      const toY = (wy: number) => MINI_H / 2 + (wy - cy) * k;

      // Dots — filtered-out nodes render very dim so users still sense
      // their position, but the active set clearly dominates.
      for (const n of nodes) {
        if (n.x == null || n.y == null) continue;
        const matches = n.matchesFilter !== false;
        const x = toX(n.x);
        const y = toY(n.y);
        ctx.fillStyle = n.color;
        ctx.globalAlpha = !matches ? 0.1 : n.detected ? 0.92 : 0.45;
        ctx.fillRect(x - 0.7, y - 0.7, 1.4, 1.4);
      }
      ctx.globalAlpha = 1;

      // Viewport rectangle — inverse of main transform.
      const t = transformRef.current;
      const wx0 = (0 - t.x) / t.k;
      const wy0 = (0 - t.y) / t.k;
      const wx1 = (mainSize.w - t.x) / t.k;
      const wy1 = (mainSize.h - t.y) / t.k;
      const rx = toX(wx0);
      const ry = toY(wy0);
      const rw = toX(wx1) - rx;
      const rh = toY(wy1) - ry;
      ctx.fillStyle = "rgba(74,158,255,0.1)";
      ctx.fillRect(rx, ry, rw, rh);
      ctx.strokeStyle = "rgba(74,158,255,0.9)";
      ctx.lineWidth = 1;
      ctx.strokeRect(rx + 0.5, ry + 0.5, rw - 1, rh - 1);

      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, [nodesRef, transformRef, mainSize.w, mainSize.h]);

  /** Convert a click position in the mini-canvas back into world coords. */
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const { minX, maxX, minY, maxY, found } = boundsRef.current;
      if (!found) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const bw = Math.max(1, maxX - minX + PAD * 2);
      const bh = Math.max(1, maxY - minY + PAD * 2);
      const k = Math.min(MINI_W / bw, MINI_H / bh);
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      const wx = cx + (mx - MINI_W / 2) / k;
      const wy = cy + (my - MINI_H / 2) / k;
      onJumpTo(wx, wy);
    },
    [onJumpTo]
  );

  return (
    <canvas
      ref={canvasRef}
      className="constellation-minimap"
      style={{ width: MINI_W, height: MINI_H }}
      onClick={handleClick}
      title="Click to jump there"
    />
  );
}
