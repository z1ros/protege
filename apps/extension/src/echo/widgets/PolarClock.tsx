import React, { useEffect, useMemo, useRef, useState } from "react";
import type {
  EchoWindow,
  PolarClockArc,
  PolarClockPayload,
} from "@protege/types";
import {
  ECHO_PALETTE,
  POLAR_RING_COLORS,
  prefersReducedMotion,
} from "./colors.js";

export interface PolarClockProps {
  data: PolarClockPayload | null;
  loading: boolean;
  window: EchoWindow;
}

const SIZE = 360;
const CENTER = SIZE / 2;
const OUTER_RADIUS = 150; // outermost ring center radius
const INNER_RADIUS = 40;  // innermost ring center radius (leaves room for chip)
const LABEL_RADIUS = OUTER_RADIUS + 18; // hour labels outside outermost ring

interface RingLayout {
  key: string;
  /** Center-line radius for the arc stroke. */
  radius: number;
  /** Stroke thickness in px. */
  thickness: number;
  /** Ring tint. */
  color: string;
  /** Stroke opacity multiplier (older rings dimmer). */
  ringOpacity: number;
  /** Human-readable ring label (e.g. "Mon Apr 14" or "W17"). Not drawn; used for tooltip context. */
  caption: string;
  /** Sessions that belong to this ring, already sorted by startHour. */
  sessions: PolarClockArc[];
}

interface ArcGeometry {
  path: string;
  length: number;
  startAngle: number;
  endAngle: number;
  radius: number;
  thickness: number;
  intensity: number;
  color: string;
  label: string;
  key: string;
  ringOpacity: number;
}

function hourToAngle(hour: number): number {
  // 0h → -90deg (top). Clockwise.
  return ((hour / 24) * 360 - 90) * (Math.PI / 180);
}

function polar(r: number, angle: number): { x: number; y: number } {
  return { x: CENTER + r * Math.cos(angle), y: CENTER + r * Math.sin(angle) };
}

function describeArc(
  radius: number,
  startHour: number,
  endHour: number
): { path: string; length: number; midAngle: number } {
  const startAngle = hourToAngle(startHour);
  const endAngle = hourToAngle(endHour);
  const start = polar(radius, startAngle);
  const end = polar(radius, endAngle);
  const delta = endAngle - startAngle;
  const largeArc = delta > Math.PI ? 1 : 0;
  const length = Math.abs(delta) * radius;
  const midAngle = (startAngle + endAngle) / 2;
  return {
    path: `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${radius} ${radius} 0 ${largeArc} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`,
    length,
    midAngle,
  };
}

/** UTC yyyy-mm-dd day key for a Date. */
function dayKeyOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Short label for a day bucket — "Mon Apr 14". */
function prettyDayLabel(dayKey: string): string {
  const d = new Date(`${dayKey}T00:00:00Z`);
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Generate the 7 day-keys (oldest → newest) for the Week window. Newest is today (UTC). */
function weekBuckets(now: Date): string[] {
  const keys: string[] = [];
  // UTC midnight of "today".
  const today = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  ));
  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date(today.getTime() - i * 86_400_000);
    keys.push(dayKeyOf(d));
  }
  return keys;
}

/** ISO-week computation matching backend `store.ts#isoWeek`. */
function isoWeekKeyOf(d: Date): string {
  const target = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  );
  const dayNum = (target.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  target.setUTCDate(target.getUTCDate() - dayNum + 3); // Thursday of ISO week
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const weekNumber = Math.round(
    (target.getTime() - firstThursday.getTime()) / (7 * 86_400_000)
  ) + 1;
  return `${target.getUTCFullYear()}-W${weekNumber.toString().padStart(2, "0")}`;
}

/** Generate ISO week keys covering the last 30 days (oldest → newest). Usually 5 weeks, can be 4. */
function monthBuckets(now: Date): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  const today = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  ));
  // Walk back 30 days; collect unique ISO weeks. Reverse at end so oldest is first.
  for (let i = 30; i >= 0; i -= 1) {
    const d = new Date(today.getTime() - i * 86_400_000);
    const k = isoWeekKeyOf(d);
    if (!seen.has(k)) {
      seen.add(k);
      keys.push(k);
    }
  }
  return keys;
}

/** Short label for an ISO week bucket — "W17 · Apr 20". The caption shows week number + Monday date. */
function prettyWeekLabel(weekKey: string): string {
  // Parse yyyy-Www → compute Monday of that ISO week.
  const m = /^(\d{4})-W(\d{2})$/.exec(weekKey);
  if (!m) return weekKey;
  const year = Number(m[1]);
  const week = Number(m[2]);
  // ISO week 1 = week containing Jan 4th. Mon of that week is the anchor.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Dow = (jan4.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  const mondayOfWeek1 = new Date(jan4.getTime() - jan4Dow * 86_400_000);
  const monday = new Date(mondayOfWeek1.getTime() + (week - 1) * 7 * 86_400_000);
  const mDate = monday.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  return `W${week.toString().padStart(2, "0")} · ${mDate}`;
}

interface LayoutSpec {
  /** Ring keys oldest → newest (innermost → outermost). */
  bucketKeys: string[];
  /** Thickness (px) per ring. */
  thickness: number;
  /** Gap (px) between rings. */
  gap: number;
  /** Human-readable caption per ring. */
  captionOf: (key: string) => string;
  /** Extract the bucket key from a session for the current window. */
  keyOf: (s: PolarClockArc) => string;
}

function computeLayout(
  window: EchoWindow,
  now: Date
): LayoutSpec {
  if (window === "today") {
    return {
      bucketKeys: [dayKeyOf(now)],
      thickness: 40,
      gap: 0,
      captionOf: prettyDayLabel,
      keyOf: (s) => s.dayKey,
    };
  }
  if (window === "week") {
    return {
      bucketKeys: weekBuckets(now),
      thickness: 14,
      gap: 2,
      captionOf: prettyDayLabel,
      keyOf: (s) => s.dayKey,
    };
  }
  // month
  return {
    bucketKeys: monthBuckets(now),
    thickness: 20,
    gap: 2,
    captionOf: prettyWeekLabel,
    keyOf: (s) => s.weekKey,
  };
}

function buildRings(
  layout: LayoutSpec,
  sessions: PolarClockArc[]
): RingLayout[] {
  const { bucketKeys, thickness, gap, captionOf, keyOf } = layout;
  const n = bucketKeys.length;
  // Group sessions by bucket.
  const byBucket = new Map<string, PolarClockArc[]>();
  for (const s of sessions) {
    const k = keyOf(s);
    const list = byBucket.get(k);
    if (list) list.push(s);
    else byBucket.set(k, [s]);
  }
  // Radial layout: innermost ring at INNER_RADIUS, outermost at OUTER_RADIUS.
  const rings: RingLayout[] = [];
  // Available span for n centered strokes: span = (n-1)*(thickness + gap)
  // We want innermost center at INNER_RADIUS, outermost at OUTER_RADIUS.
  // If n === 1, just place at OUTER_RADIUS (thickness already large).
  for (let i = 0; i < n; i += 1) {
    const key = bucketKeys[i];
    const radius =
      n === 1
        ? OUTER_RADIUS - thickness / 2
        : INNER_RADIUS + (i * (OUTER_RADIUS - INNER_RADIUS)) / (n - 1);
    // Older rings dimmer: 0.7 at innermost → 1.0 at outermost.
    const ringOpacity = n === 1 ? 1 : 0.7 + (0.3 * i) / (n - 1);
    const color = POLAR_RING_COLORS[i % POLAR_RING_COLORS.length];
    const bucketSessions = (byBucket.get(key) ?? [])
      .slice()
      .sort((a, b) => a.startHour - b.startHour);
    rings.push({
      key,
      radius,
      thickness,
      color,
      ringOpacity,
      caption: captionOf(key),
      sessions: bucketSessions,
    });
  }
  // thickness/gap are part of the contract but not directly read by callers —
  // referencing gap silences an unused-var lint while documenting intent.
  void gap;
  return rings;
}

export function PolarClock({
  data,
  loading,
  window,
}: PolarClockProps): JSX.Element {
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(
    null
  );
  const [hoverLabel, setHoverLabel] = useState<string | null>(null);
  const [animateIn, setAnimateIn] = useState(false);
  const reduced = useRef(prefersReducedMotion());

  useEffect(() => {
    if (!data) return;
    if (reduced.current) {
      setAnimateIn(true);
      return;
    }
    setAnimateIn(false);
    const id = globalThis.requestAnimationFrame(() => setAnimateIn(true));
    return () => globalThis.cancelAnimationFrame(id);
  }, [data, window]);

  const rings = useMemo<RingLayout[]>(() => {
    if (!data) return [];
    const layout = computeLayout(window, new Date());
    return buildRings(layout, data.sessions);
  }, [data, window]);

  const geometry = useMemo<ArcGeometry[]>(() => {
    const arcs: ArcGeometry[] = [];
    for (const ring of rings) {
      for (let i = 0; i < ring.sessions.length; i += 1) {
        const s = ring.sessions[i];
        const startH = Math.max(0, Math.min(24, s.startHour));
        const endH = Math.max(startH + 1 / 60, Math.min(24, s.endHour));
        const { path, length } = describeArc(ring.radius, startH, endH);
        arcs.push({
          path,
          length,
          startAngle: hourToAngle(startH),
          endAngle: hourToAngle(endH),
          radius: ring.radius,
          thickness: ring.thickness,
          intensity: Math.max(0.25, Math.min(1, s.intensity)),
          color: ring.color,
          label: s.label,
          key: `arc-${ring.key}-${i}-${s.startHour.toFixed(2)}`,
          ringOpacity: ring.ringOpacity,
        });
      }
    }
    return arcs;
  }, [rings]);

  return (
    <section className="echo-widget echo-polar" data-widget="W2">
      <header className="echo-widget-head">
        <h2>When you code</h2>
        <span className="echo-widget-tag">W2</span>
      </header>
      {/* Archetype strip — lifted out of the center hole so arc crowding
          never overlaps the label. Always rendered (skeleton placeholder
          during loading) so the body below can't jump height as data
          arrives. */}
      <div className="echo-polar-archetype">
        <div className="echo-polar-archetype-label">
          {data ? (
            <>
              <strong>{data.archetype}</strong>
              {data.archetypeCaption ? (
                <span className="echo-polar-archetype-caption">
                  {" "}&middot; {formatArchetypeCaption(data.archetypeCaption)}
                </span>
              ) : null}
            </>
          ) : (
            <span className="echo-polar-archetype-placeholder">&nbsp;</span>
          )}
        </div>
      </div>
      <div className="echo-widget-body">
        {loading ? (
          <div className="echo-widget-skeleton" />
        ) : data ? (
          <PolarBody
            rings={rings}
            geometry={geometry}
            animateIn={animateIn}
            hoverKey={hoverKey}
            hoverPos={hoverPos}
            hoverLabel={hoverLabel}
            setHoverKey={setHoverKey}
            setHoverPos={setHoverPos}
            setHoverLabel={setHoverLabel}
          />
        ) : (
          <div className="echo-widget-empty">Session data pending.</div>
        )}
      </div>
    </section>
  );
}

/** Rewrite the "peak: 11:00am · 67m" caption to a zero-padded 24h clock.
 *  Non-peak captions (e.g. "Not enough sessions yet", "Code a few sessions
 *  to find your rhythm") pass through unchanged. */
function formatArchetypeCaption(caption: string): string {
  const match = /^peak:\s*(\d{1,2}):(\d{2})(am|pm)\s*·\s*(\d+)m$/i.exec(caption);
  if (!match) return caption;
  const h12 = Number(match[1]);
  const minutes = match[2];
  const suffix = match[3].toLowerCase();
  const mins = match[4];
  let h24 = h12 % 12;
  if (suffix === "pm") h24 += 12;
  return `peak ${h24.toString().padStart(2, "0")}:${minutes} · ${mins}m`;
}

function PolarBody({
  rings,
  geometry,
  animateIn,
  hoverKey,
  hoverPos,
  hoverLabel,
  setHoverKey,
  setHoverPos,
  setHoverLabel,
}: {
  rings: RingLayout[];
  geometry: ArcGeometry[];
  animateIn: boolean;
  hoverKey: string | null;
  hoverPos: { x: number; y: number } | null;
  hoverLabel: string | null;
  setHoverKey: (key: string | null) => void;
  setHoverPos: (pos: { x: number; y: number } | null) => void;
  setHoverLabel: (label: string | null) => void;
}): JSX.Element {
  return (
    <div className="echo-polar-body" style={{ position: "relative" }}>
      <svg
        className="echo-polar-svg"
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        role="img"
        aria-label="Concentric-ring polar coding clock"
      >
        {/* Hour ticks sit below the rings so arcs overlay cleanly. */}
        {renderHourTicks(rings)}

        {/* Ring outlines — drawn before arcs so empty rings show. */}
        {rings.map((ring) => {
          const empty = ring.sessions.length === 0;
          return (
            <circle
              key={`ring-${ring.key}`}
              cx={CENTER}
              cy={CENTER}
              r={ring.radius}
              fill="none"
              stroke={empty ? "rgba(255,255,255,0.09)" : "rgba(255,255,255,0.04)"}
              strokeWidth={ring.thickness}
              strokeDasharray={empty ? "3 5" : undefined}
              opacity={empty ? 0.6 : 1}
            />
          );
        })}

        {/* Session arcs. */}
        {geometry.map((arc) => (
          <path
            key={arc.key}
            d={arc.path}
            fill="none"
            stroke={arc.color}
            strokeOpacity={arc.intensity * arc.ringOpacity}
            strokeWidth={arc.thickness}
            strokeLinecap="round"
            style={
              animateIn
                ? {
                    strokeDasharray: arc.length,
                    strokeDashoffset: 0,
                    transition:
                      "stroke-dashoffset 600ms ease-out, stroke-opacity 150ms ease",
                  }
                : {
                    strokeDasharray: arc.length,
                    strokeDashoffset: arc.length,
                  }
            }
            onMouseEnter={(e) => {
              setHoverKey(arc.key);
              setHoverLabel(arc.label);
              const rect = (
                e.currentTarget.ownerSVGElement as SVGSVGElement
              ).getBoundingClientRect();
              setHoverPos({
                x: e.clientX - rect.left,
                y: e.clientY - rect.top,
              });
            }}
            onMouseMove={(e) => {
              const rect = (
                e.currentTarget.ownerSVGElement as SVGSVGElement
              ).getBoundingClientRect();
              setHoverPos({
                x: e.clientX - rect.left,
                y: e.clientY - rect.top,
              });
            }}
            onMouseLeave={() => {
              setHoverKey(null);
              setHoverPos(null);
              setHoverLabel(null);
            }}
          />
        ))}

        {renderHourLabels()}
        <PolarCenter />
      </svg>
      {hoverKey && hoverPos && hoverLabel ? (
        <div
          className="echo-polar-tooltip"
          style={{
            position: "absolute",
            left: hoverPos.x + 12,
            top: hoverPos.y + 12,
            pointerEvents: "none",
            background: "rgba(13,17,23,0.95)",
            border: "1px solid rgba(255,255,255,0.12)",
            color: "#e6edf3",
            padding: "4px 8px",
            borderRadius: 4,
            fontSize: 11,
            whiteSpace: "nowrap",
            zIndex: 10,
          }}
        >
          {hoverLabel}
        </div>
      ) : null}
    </div>
  );
}

function renderHourTicks(rings: RingLayout[]): JSX.Element[] {
  if (rings.length === 0) return [];
  const outermost = rings[rings.length - 1];
  const outerEdge = outermost.radius + outermost.thickness / 2;
  const ticks: JSX.Element[] = [];
  for (let h = 0; h < 24; h += 3) {
    const a = hourToAngle(h);
    const inner = polar(INNER_RADIUS - 10, a);
    const outer = polar(outerEdge + 4, a);
    ticks.push(
      <line
        key={`tick-${h}`}
        x1={inner.x}
        y1={inner.y}
        x2={outer.x}
        y2={outer.y}
        stroke="rgba(255,255,255,0.08)"
        strokeWidth={h % 6 === 0 ? 1 : 0.5}
      />
    );
  }
  return ticks;
}

function renderHourLabels(): JSX.Element[] {
  const labels = [0, 6, 12, 18];
  return labels.map((h) => {
    const a = hourToAngle(h);
    const p = polar(LABEL_RADIUS, a);
    return (
      <text
        key={`lbl-${h}`}
        x={p.x}
        y={p.y}
        fontSize={10}
        fill={ECHO_PALETTE.muted}
        textAnchor="middle"
        dominantBaseline="middle"
      >
        {h.toString().padStart(2, "0")}
      </text>
    );
  });
}

/** Quiet bull's-eye for the inner hole. No text — the archetype label
 *  lives in the widget header now. A subtle outline + a tiny dot keeps
 *  the composition centered without fighting the arcs for attention. */
function PolarCenter(): JSX.Element {
  return (
    <g>
      <circle
        cx={CENTER}
        cy={CENTER}
        r={INNER_RADIUS - 8}
        fill="rgba(13,17,23,0.9)"
        stroke="rgba(255,255,255,0.08)"
      />
      <circle
        cx={CENTER}
        cy={CENTER}
        r={3}
        fill="rgba(255,255,255,0.35)"
      />
    </g>
  );
}
