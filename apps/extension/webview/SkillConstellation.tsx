import React, { useEffect, useRef, useState, useCallback, useMemo } from "react";
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  forceX,
  forceY,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from "d3-force";
import type { ConceptRow } from "@protege/types";
import { vscode } from "./vscode.js";
import taxonomy from "./skills-taxonomy.json";
import {
  computeFitAll,
  computeFlyTo,
  easeOutCubic,
  lerpTransform,
  type Transform,
} from "./constellationCamera";
import { ConstellationMinimap } from "./ConstellationMinimap";
import {
  ConstellationNodeDrawer,
  type ConnectedSkill,
  type DrawerNode,
} from "./ConstellationNodeDrawer";

/* ==========================================================
   Types
   ========================================================== */

interface TaxSkill {
  id: string;
  name: string;
  difficulty: number;
  pattern?: string;
}

interface TaxTopic {
  id: string;
  label: string;
  skills: TaxSkill[];
}

interface TaxDomain {
  id: string;
  label: string;
  color: string;
  topics: TaxTopic[];
}

interface SkillNode extends SimulationNodeDatum {
  id: string;
  name: string;
  domain: string;
  domainLabel: string;
  topic: string;
  color: string;
  difficulty: number;
  mastery: number;
  timesUsed: number;
  detected: boolean;
  matchesFilter: boolean;
  /** Landmark Orbit tier:
   *  - "notable"  → top N per topic; labeled ring, visible past mid-zoom
   *  - "passive"  → the long tail; 2.5px dot if detected, 1px dust if not
   *
   *  Keystones (one giant brand glyph per domain) are NOT on skills —
   *  they live in the ConstellationKeystones SVG overlay. */
  tier: "notable" | "passive";
  /** Importance score (higher = more visually prominent).
   *  iqContribution + mastery*40 + difficulty*8 + (detected ? 25 : 0). */
  importance: number;
}

interface SkillLink extends SimulationLinkDatum<SkillNode> {}

/* ==========================================================
   Build graph from taxonomy + user mastery
   ========================================================== */

function fuzzyMatch(concept: ConceptRow, skillName: string): boolean {
  const a = concept.name.toLowerCase().replace(/[^a-z0-9]/g, "");
  const b = skillName.toLowerCase().replace(/[^a-z0-9]/g, "");
  return a === b || a.includes(b) || b.includes(a);
}

/**
 * Demo mastery data — generated deterministically from skill id so the
 * constellation looks alive even before the user has saved any files.
 * ~35% of all skills get a random mastery level, the rest stay dark.
 */
function generateMockConcepts(domains: TaxDomain[]): ConceptRow[] {
  const mocks: ConceptRow[] = [];
  for (const d of domains) {
    for (const t of d.topics) {
      for (const s of t.skills) {
        // Deterministic pseudo-random from skill id
        let h = 0;
        for (let i = 0; i < s.id.length; i++) h = (h * 31 + s.id.charCodeAt(i)) | 0;
        const rand = Math.abs(h % 100);
        if (rand < 35) {
          // Weight mastery by difficulty — easier skills tend to be more mastered,
          // harder skills are rarer but when mastered they're impressive. This
          // creates visual variety (varied node sizes) instead of flat uniformity.
          const diffWeight = 1 - (s.difficulty - 1) / 5; // 1→1.0, 5→0.2
          const mastery = Math.min(1, 0.1 + diffWeight * 0.4 + (rand / 100) * 0.5);
          mocks.push({
            name: s.name,
            cluster: d.id as any,
            mastery,
            rawMastery: mastery,
            timesUsed: Math.floor(mastery * 25),
            distinctFiles: Math.floor(mastery * 8) + 1,
            weight: s.difficulty * 0.6,
            iqContribution: mastery * s.difficulty * 3,
            level: mastery > 0.7 ? "expert" : mastery > 0.4 ? "competent" : mastery > 0.2 ? "functional" : "familiar",
            lastUsedAt: new Date().toISOString(),
            daysSinceUsed: Math.floor(rand / 5),
          });
        }
      }
    }
  }
  return mocks;
}

/* Career areas — meta-groupings of domains for the area filter chips */
type Area = "frontend" | "backend" | "mobile" | "devops" | "data" | "fundamentals";

const AREAS: { id: Area; label: string; domains: string[] }[] = [
  { id: "frontend", label: "Frontend", domains: ["javascript", "typescript", "react", "nextjs", "css"] },
  { id: "backend", label: "Backend", domains: ["node", "python", "java", "csharp", "go", "rust", "php", "ruby", "kotlin", "sql"] },
  { id: "mobile", label: "Mobile", domains: ["mobile", "swift", "kotlin"] },
  { id: "devops", label: "DevOps", domains: ["devops", "cloud", "protocols"] },
  { id: "data", label: "Data & AI", domains: ["sql", "ai-ml", "python"] },
  { id: "fundamentals", label: "Fundamentals", domains: ["dsa", "system-design", "security", "testing", "accessibility", "web-performance", "dev-tools"] },
];

type LevelFilter = "all" | "expert" | "competent" | "functional" | "familiar" | "undiscovered";

function getNodeLevel(mastery: number, detected: boolean): LevelFilter {
  if (!detected) return "undiscovered";
  if (mastery >= 0.7) return "expert";
  if (mastery >= 0.4) return "competent";
  if (mastery >= 0.2) return "functional";
  return "familiar";
}

interface BuildOpts {
  search: string;
  domainFilter: string | null;
  areaFilter: Area | null;
  topicFilter: string | null;
  levelFilter: LevelFilter;
  mySkillsOnly: boolean;
}

function buildNodes(
  domains: TaxDomain[],
  userConcepts: ConceptRow[],
  opts: BuildOpts
): SkillNode[] {
  const { search, domainFilter, areaFilter, topicFilter, levelFilter, mySkillsOnly } = opts;
  const searchLower = search.toLowerCase();
  const areaDomains = areaFilter
    ? new Set(AREAS.find((a) => a.id === areaFilter)?.domains ?? [])
    : null;
  const nodes: SkillNode[] = [];

  for (const domain of domains) {
    if (domainFilter && domain.id !== domainFilter) continue;
    if (areaDomains && !areaDomains.has(domain.id)) continue;
    for (const topic of domain.topics) {
      if (topicFilter && topic.id !== topicFilter) continue;
      for (const skill of topic.skills) {
        const match = userConcepts.find((c) => fuzzyMatch(c, skill.name));
        const detected = !!match;
        const mastery = match?.mastery ?? 0;

        if (mySkillsOnly && !detected) continue;
        const nodeLevel = getNodeLevel(mastery, detected);
        if (levelFilter !== "all" && nodeLevel !== levelFilter) continue;

        const matchesFilter =
          !searchLower ||
          skill.name.toLowerCase().includes(searchLower) ||
          domain.label.toLowerCase().includes(searchLower) ||
          topic.label.toLowerCase().includes(searchLower);

        const iqContribution = match?.iqContribution ?? 0;
        // Composite importance — rewards detected+mastered+difficult skills
        // so the visible heroes are the ones the user actually cares about.
        const importance =
          iqContribution +
          mastery * 40 +
          skill.difficulty * 8 +
          (detected ? 25 : 0) +
          (matchesFilter ? 0 : -15);

        nodes.push({
          id: skill.id,
          name: skill.name,
          domain: domain.id,
          domainLabel: domain.label,
          topic: topic.id,
          color: domain.color,
          difficulty: skill.difficulty,
          mastery,
          timesUsed: match?.timesUsed ?? 0,
          detected,
          matchesFilter,
          tier: "passive", // promoted below
          importance,
        });
      }
    }
  }

  // Landmark Orbit: one "notable" per topic, picked by a weighted score.
  // Detected skills earn a notable slot before undetected ones — a skill
  // you've actually used deserves to be the topic's representative. If no
  // skill in the topic is detected, the hardest/highest-importance one
  // becomes notable so every topic always has a labeled anchor.
  const NOTABLE_SCORE = (n: SkillNode) => n.importance + n.difficulty * 10;
  const byTopic = new Map<string, SkillNode[]>();
  for (const n of nodes) {
    const arr = byTopic.get(n.topic);
    if (arr) arr.push(n);
    else byTopic.set(n.topic, [n]);
  }
  for (const group of byTopic.values()) {
    const detected = group.filter((n) => n.detected);
    const pool = detected.length > 0 ? detected : group;
    let best = pool[0];
    let bestScore = NOTABLE_SCORE(best);
    for (let i = 1; i < pool.length; i++) {
      const s = NOTABLE_SCORE(pool[i]);
      if (s > bestScore) {
        best = pool[i];
        bestScore = s;
      }
    }
    best.tier = "notable";
  }

  return nodes;
}

function buildLinks(nodes: SkillNode[]): SkillLink[] {
  const links: SkillLink[] = [];
  const topicFirsts = new Map<string, string>();
  const domainFirsts = new Map<string, string>();

  for (const n of nodes) {
    if (!topicFirsts.has(n.topic)) {
      topicFirsts.set(n.topic, n.id);
    } else {
      links.push({ source: topicFirsts.get(n.topic)!, target: n.id });
    }
    if (!domainFirsts.has(n.domain)) {
      domainFirsts.set(n.domain, n.id);
    }
  }

  // Bridge topics within a domain
  const domainTopics = new Map<string, string[]>();
  for (const n of nodes) {
    const topics = domainTopics.get(n.domain) ?? [];
    if (!topics.includes(n.topic)) topics.push(n.topic);
    domainTopics.set(n.domain, topics);
  }
  for (const topics of domainTopics.values()) {
    for (let i = 1; i < topics.length; i++) {
      const a = topicFirsts.get(topics[i - 1]);
      const b = topicFirsts.get(topics[i]);
      if (a && b) links.push({ source: a, target: b });
    }
  }

  // Cross-domain bridges — connect first nodes of neighboring domains
  // so the whole graph feels interconnected, not isolated clusters.
  const domainIds = [...domainFirsts.keys()];
  for (let i = 1; i < domainIds.length; i++) {
    const a = domainFirsts.get(domainIds[i - 1]);
    const b = domainFirsts.get(domainIds[i]);
    if (a && b) links.push({ source: a, target: b });
  }
  // Also connect last to first for a ring topology
  if (domainIds.length > 2) {
    const first = domainFirsts.get(domainIds[0]);
    const last = domainFirsts.get(domainIds[domainIds.length - 1]);
    if (first && last) links.push({ source: first, target: last });
  }

  return links;
}

/* ==========================================================
   Component
   ========================================================== */

interface Props {
  concepts: ConceptRow[];
  height?: number;
  /** Hook for the "← Tree" back button when mounted in SkillSection. */
  onBackToTree?: () => void;
}

export function SkillConstellation({ concepts, height: propH, onBackToTree }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 340, h: propH ?? 480 });
  const [hovered, setHovered] = useState<SkillNode | null>(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const [search, setSearch] = useState("");
  const [domainFilter, setDomainFilter] = useState<string | null>(null);
  const [areaFilter, setAreaFilter] = useState<Area | null>(null);
  const [topicFilter, setTopicFilter] = useState<string | null>(null);
  const [levelFilter, setLevelFilter] = useState<LevelFilter>("all");
  const [mySkillsOnly, setMySkillsOnly] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [selectedNode, setSelectedNode] = useState<SkillNode | null>(null);

  const nodesRef = useRef<SkillNode[]>([]);
  const linksRef = useRef<SkillLink[]>([]);
  const transformRef = useRef<Transform>({ x: 0, y: 0, k: 1 });
  const dragRef = useRef<{ sx: number; sy: number; tx: number; ty: number } | null>(null);
  const simRef = useRef<ReturnType<typeof forceSimulation<SkillNode>> | null>(null);
  // Focused-node pulse (set by fly-to; rendered in draw()).
  const focusedIdRef = useRef<string | null>(null);
  const focusStartRef = useRef<number>(0);
  // Monotonic token so a new camera animation cancels any in-flight RAF loop.
  const animTokenRef = useRef(0);
  // Position cache — survives filter changes so nodes don't jump.
  const posCache = useRef(new Map<string, { x: number; y: number }>());
  // Grid-based spatial index for O(1) hover hit testing.
  const gridRef = useRef(new Map<string, SkillNode[]>());
  const GRID_CELL = 64;
  const filterRef = useRef<HTMLDivElement>(null);
  const [filterH, setFilterH] = useState(95);

  const domains = taxonomy.domains as TaxDomain[];

  // If user has no real concepts yet, show mock data so the constellation
  // looks alive for demos. Real data takes over as soon as they save a file.
  const effectiveConcepts = useMemo(
    () => (concepts.length > 0 ? concepts : generateMockConcepts(domains)),
    [concepts, domains]
  );

  // Escape exits fullscreen
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  // Measure container
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      if (width > 0) setSize({ w: width, h: propH ?? Math.max(420, height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [propH]);

  // Measure actual filter container height instead of hardcoding
  useEffect(() => {
    const el = filterRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const h = Math.ceil(entries[0].contentRect.height);
      if (h > 0) setFilterH(h);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Build + simulate
  useEffect(() => {
    if (simRef.current) simRef.current.stop();

    const nodes = buildNodes(domains, effectiveConcepts, {
      search,
      domainFilter,
      areaFilter,
      topicFilter,
      levelFilter,
      mySkillsOnly,
    });
    const links = buildLinks(nodes);
    nodesRef.current = nodes;
    linksRef.current = links;

    // Reuse cached positions so filter changes don't reset the whole layout.
    // Only nodes that have never been placed get circle-spread initial positions.
    const visibleDomains = [...new Set(nodes.map((n) => n.domain))];
    const domainAngle = new Map<string, number>();
    visibleDomains.forEach((d, i) => {
      domainAngle.set(d, (i / visibleDomains.length) * Math.PI * 2 - Math.PI / 2);
    });
    const spread = Math.min(size.w, size.h) * 0.38;
    const cache = posCache.current;

    for (const n of nodes) {
      const cached = cache.get(n.id);
      if (cached) {
        n.x = cached.x;
        n.y = cached.y;
      } else {
        const a = domainAngle.get(n.domain) ?? 0;
        n.x = size.w / 2 + Math.cos(a) * spread + (Math.random() - 0.5) * 40;
        n.y = size.h / 2 + Math.sin(a) * spread + (Math.random() - 0.5) * 40;
      }
    }

    const sim = forceSimulation(nodes)
      .force(
        "link",
        forceLink<SkillNode, SkillLink>(links)
          .id((d) => d.id)
          .distance((l) => {
            const s = l.source as SkillNode;
            const t = l.target as SkillNode;
            return s.topic === t.topic ? 56 : 110;
          })
          .strength((l) => {
            const s = l.source as SkillNode;
            const t = l.target as SkillNode;
            return s.topic === t.topic ? 0.5 : 0.08;
          })
      )
      .force("charge", forceManyBody().strength(-220))
      .force("center", forceCenter(size.w / 2, size.h / 2))
      .force("collide", forceCollide<SkillNode>().radius((d) => nodeRadius(d) + 10))
      .force(
        "domainX",
        forceX<SkillNode>()
          .x((d) => {
            const a = domainAngle.get(d.domain) ?? 0;
            return size.w / 2 + Math.cos(a) * spread;
          })
          .strength(0.09)
      )
      .force(
        "domainY",
        forceY<SkillNode>()
          .y((d) => {
            const a = domainAngle.get(d.domain) ?? 0;
            return size.h / 2 + Math.sin(a) * spread;
          })
          .strength(0.09)
      )
      .alphaDecay(0.03)
      .on("tick", () => {
        // Cache positions + rebuild spatial grid on every tick
        const grid = new Map<string, SkillNode[]>();
        for (const n of nodes) {
          if (n.x != null && n.y != null) {
            cache.set(n.id, { x: n.x!, y: n.y! });
            const key = `${Math.floor(n.x! / GRID_CELL)},${Math.floor(n.y! / GRID_CELL)}`;
            const cell = grid.get(key);
            if (cell) cell.push(n);
            else grid.set(key, [n]);
          }
        }
        gridRef.current = grid;
        draw();
      });

    simRef.current = sim;
    return () => { sim.stop(); };
  }, [effectiveConcepts, search, domainFilter, areaFilter, topicFilter, levelFilter, mySkillsOnly, size.w, size.h]);

  /** Node radius — AC-style medallions.
   *
   *  Undetected skills: small outlines (14–19px) that look like
   *  "unlocked future abilities". Detected skills: solid medallions
   *  sized by difficulty (22 base) + boosted by mastery (up to +8).
   *  Expert-tier (mastery ≥ 0.7) adds another +2 for a subtle pop. */
  function nodeRadius(n: SkillNode): number {
    if (!n.detected) return 14 + n.difficulty * 1;
    const base = 22 + n.difficulty * 2.5; // 24.5 → 34.5
    const masteryBoost = n.mastery * 8;
    const expertBoost = n.mastery >= 0.7 ? 2 : 0;
    return base + masteryBoost + expertBoost;
  }

  // Use a ref for hovered so draw() never has a stale closure.
  // The simulation tick calls draw() synchronously — if hovered were
  // captured by closure it'd be one render behind.
  const hoveredRef = useRef<SkillNode | null>(null);
  hoveredRef.current = hovered;

  /** Parse a hex color (#RRGGBB) to {r,g,b} for use in rgba(). */
  function hexToRgb(hex: string): { r: number; g: number; b: number } {
    const h = hex.replace("#", "");
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
    };
  }

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size.w * dpr;
    canvas.height = size.h * dpr;
    ctx.scale(dpr, dpr);
    const t = transformRef.current;
    ctx.clearRect(0, 0, size.w, size.h);
    ctx.save();
    ctx.translate(t.x, t.y);
    ctx.scale(t.k, t.k);

    const nodes = nodesRef.current;
    const links = linksRef.current;
    const hoveredNode = hoveredRef.current;

    // Build adjacency set for hover highlighting
    const hoveredAdj = new Set<string>();
    if (hoveredNode) {
      for (const link of links) {
        const s = link.source as SkillNode;
        const tgt = link.target as SkillNode;
        if (s.id === hoveredNode.id) hoveredAdj.add(tgt.id);
        if (tgt.id === hoveredNode.id) hoveredAdj.add(s.id);
      }
    }

    // === Level-of-detail watermark labels ===
    // Domain landmarks are handled by the ConstellationKeystones SVG
    // overlay (brand glyph + domain label at each centroid), so we only
    // paint topic watermarks here — they orient sub-clusters at mid zoom.
    // Font is inversely scaled so on-screen size stays ~constant.
    const topicFade =
      t.k >= 0.75 && t.k < 1.55 ? Math.min(1, (1.55 - t.k) / 0.6) * Math.min(1, (t.k - 0.75) / 0.25) : 0;

    if (topicFade > 0) {
      const topicCentroids = new Map<
        string,
        { sx: number; sy: number; count: number; label: string; color: string }
      >();
      for (const n of nodes) {
        if (n.x == null || n.y == null || !n.matchesFilter) continue;
        const c = topicCentroids.get(n.topic);
        const topicLabel =
          domains
            .find((d) => d.id === n.domain)
            ?.topics.find((t) => t.id === n.topic)?.label ?? n.topic;
        if (c) {
          c.sx += n.x;
          c.sy += n.y;
          c.count++;
        } else {
          topicCentroids.set(n.topic, {
            sx: n.x,
            sy: n.y,
            count: 1,
            label: topicLabel,
            color: n.color,
          });
        }
      }
      ctx.save();
      const fontPx = Math.max(10, 14 / t.k);
      ctx.font = `600 ${fontPx}px var(--font-mono), "SF Mono", ui-monospace, monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (const c of topicCentroids.values()) {
        if (c.count < 2) continue;
        const cx = c.sx / c.count;
        const cy = c.sy / c.count;
        const rgb = hexToRgb(c.color);
        const alpha = topicFade * 0.35;
        ctx.fillStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},${alpha})`;
        ctx.fillText(c.label, cx, cy);
      }
      ctx.restore();
    }

    // === Links ===
    for (const link of links) {
      const s = link.source as SkillNode;
      const tgt = link.target as SkillNode;
      if (s.x == null || tgt.x == null) continue;

      const dimmed = !s.matchesFilter && !tgt.matchesFilter;
      const bothDetected = s.detected && tgt.detected;
      const isHoverLink = hoveredNode && (s.id === hoveredNode.id || tgt.id === hoveredNode.id);

      if (isHoverLink) {
        // Highlighted connection
        const rgb = hexToRgb(s.color);
        ctx.strokeStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},0.7)`;
        ctx.lineWidth = 1.8;
        ctx.shadowColor = `rgba(${rgb.r},${rgb.g},${rgb.b},0.5)`;
        ctx.shadowBlur = 6;
      } else if (bothDetected && !dimmed) {
        // Active connection between detected nodes — subtle, so the
        // eye lands on the medallions, not the web.
        const rgb = hexToRgb(s.color);
        ctx.strokeStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},0.08)`;
        ctx.lineWidth = 0.6;
        ctx.shadowBlur = 0;
      } else if (dimmed) {
        ctx.strokeStyle = "rgba(255,255,255,0.01)";
        ctx.lineWidth = 0.25;
        ctx.shadowBlur = 0;
      } else {
        ctx.strokeStyle = "rgba(255,255,255,0.025)";
        ctx.lineWidth = 0.3;
        ctx.shadowBlur = 0;
      }

      ctx.beginPath();
      ctx.moveTo(s.x!, s.y!);
      ctx.lineTo(tgt.x!, tgt.y!);
      ctx.stroke();
    }
    ctx.shadowBlur = 0;

    // === Landmark Orbit rendering ===
    //
    // PASS 1 — passives: 2.5px detected dot, or 1px undetected "dust"
    //          (skipped entirely when the user has "Mine" mode on).
    // PASS 2 — notables: labeled rings with mastery arc + soft glow.
    //          One notable per topic, picked in buildNodes.
    //
    // Keystones (one big brand glyph per domain) live in the
    // ConstellationKeystones SVG overlay, NOT here — they're drawn by
    // the DOM layer so they stay crisp at any zoom.
    const hoveredTopic = hoveredNode?.topic;
    const showPassiveDust = !mySkillsOnly;
    const showNotableLabels = t.k >= 1.1;

    // --- PASS 1: passives ---
    for (const n of nodes) {
      if (n.tier !== "passive" || n.x == null || n.y == null) continue;
      const dimmed = !n.matchesFilter;
      const rgb = hexToRgb(n.color);
      const inHoverTopic = hoveredTopic && n.topic === hoveredTopic;

      if (!n.detected) {
        // Dust layer — hidden entirely in "Mine" mode
        if (!showPassiveDust) continue;
        ctx.beginPath();
        ctx.arc(n.x, n.y, 0.9, 0, Math.PI * 2);
        ctx.fillStyle = dimmed
          ? "rgba(200,215,245,0.02)"
          : inHoverTopic
            ? `rgba(${rgb.r},${rgb.g},${rgb.b},0.18)`
            : "rgba(200,215,245,0.07)";
        ctx.fill();
        continue;
      }

      // Detected passive — bright domain-color dot
      const dotR = inHoverTopic ? 3 : 2.4;
      const baseAlpha = dimmed
        ? 0.12
        : 0.55 + n.mastery * 0.3 + (inHoverTopic ? 0.1 : 0);
      ctx.beginPath();
      ctx.arc(n.x, n.y, dotR, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},${Math.min(1, baseAlpha)})`;
      ctx.fill();
      if (inHoverTopic) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, dotR + 2, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},0.4)`;
        ctx.lineWidth = 0.6;
        ctx.stroke();
      }
    }

    // --- PASS 2: notables (labeled rings with mastery arc) ---
    for (const n of nodes) {
      if (n.tier !== "notable" || n.x == null || n.y == null) continue;
      const dimmed = !n.matchesFilter;
      const rgb = hexToRgb(n.color);
      const isHovered = n === hoveredNode;
      const isHoverNeighbor = hoveredAdj.has(n.id);
      const hoverDim =
        hoveredNode && !isHovered && !isHoverNeighbor && n.topic !== hoveredTopic;

      const outerR = 9;
      const innerR = 4;

      if (dimmed || hoverDim) {
        // Faded notable — just a thin ring so position is still legible
        ctx.beginPath();
        ctx.arc(n.x, n.y, outerR, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},${hoverDim ? 0.15 : 0.1})`;
        ctx.lineWidth = 0.8;
        ctx.stroke();
        continue;
      }

      // Soft glow halo for mastered notables — makes them feel "lit"
      if (n.detected && n.mastery > 0.05) {
        const glowR = outerR + 8 + n.mastery * 10;
        const grad = ctx.createRadialGradient(n.x, n.y, innerR, n.x, n.y, glowR);
        grad.addColorStop(0, `rgba(${rgb.r},${rgb.g},${rgb.b},${0.14 + n.mastery * 0.18})`);
        grad.addColorStop(1, "transparent");
        ctx.beginPath();
        ctx.arc(n.x, n.y, glowR, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.fill();
      }

      // Outer ring (base tint)
      const ringAlpha = n.detected ? 0.55 + n.mastery * 0.3 : 0.32;
      ctx.beginPath();
      ctx.arc(n.x, n.y, outerR, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},${ringAlpha})`;
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Mastery arc — bright segment sweeping the ring
      if (n.mastery > 0.02) {
        const arcAngle = n.mastery * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(n.x, n.y, outerR, -Math.PI / 2, -Math.PI / 2 + arcAngle);
        ctx.strokeStyle = `rgba(${Math.min(255, rgb.r + 40)},${Math.min(255, rgb.g + 40)},${Math.min(255, rgb.b + 40)},1)`;
        ctx.lineWidth = 2;
        ctx.lineCap = "round";
        ctx.stroke();
        ctx.lineCap = "butt";
      }

      // Inner core — filled dot
      const coreAlpha = n.detected ? 0.72 + n.mastery * 0.25 : 0.22;
      ctx.beginPath();
      ctx.arc(n.x, n.y, innerR, 0, Math.PI * 2);
      ctx.fillStyle = n.detected
        ? `rgba(${rgb.r},${rgb.g},${rgb.b},${coreAlpha})`
        : "rgba(200,215,245,0.18)";
      ctx.fill();

      // Label — always shown past mid zoom; also when hovered/neighbor
      if (isHovered || isHoverNeighbor || showNotableLabels) {
        ctx.font = isHovered
          ? "600 11px 'Space Grotesk', sans-serif"
          : "500 10px 'Space Grotesk', sans-serif";
        ctx.fillStyle = isHovered
          ? "rgba(255,255,255,0.98)"
          : `rgba(255,255,255,${n.detected ? 0.82 : 0.5})`;
        ctx.textAlign = "center";
        ctx.fillText(n.name, n.x, n.y + outerR + 14);
      }
    }

    // Hover: an offset outer ring that feels "selected" without covering the node
    if (hoveredNode?.x != null) {
      const hr = nodeRadius(hoveredNode);
      const hrgb = hexToRgb(hoveredNode.color);
      const hcx = hoveredNode.x!;
      const hcy = hoveredNode.y!;
      // Outer electric halo
      ctx.beginPath();
      ctx.arc(hcx, hcy, hr + 6, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${hrgb.r},${hrgb.g},${hrgb.b},0.85)`;
      ctx.lineWidth = 2;
      ctx.shadowColor = `rgba(${hrgb.r},${hrgb.g},${hrgb.b},0.5)`;
      ctx.shadowBlur = 10;
      ctx.stroke();
      ctx.shadowBlur = 0;
      // Second ring for a beacon feel
      ctx.beginPath();
      ctx.arc(hcx, hcy, hr + 11, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${hrgb.r},${hrgb.g},${hrgb.b},0.22)`;
      ctx.lineWidth = 0.8;
      ctx.stroke();
      // Reticle ticks at N/S/E/W — signals "aim here, click to inspect."
      // The four ticks together read as a telescope crosshair, not a
      // generic ring, so users intuit this dot is a door not decoration.
      const tickInner = hr + 4;
      const tickOuter = hr + 10;
      ctx.strokeStyle = `rgba(${hrgb.r},${hrgb.g},${hrgb.b},0.95)`;
      ctx.lineWidth = 1.4;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(hcx, hcy - tickInner);
      ctx.lineTo(hcx, hcy - tickOuter);
      ctx.moveTo(hcx, hcy + tickInner);
      ctx.lineTo(hcx, hcy + tickOuter);
      ctx.moveTo(hcx - tickInner, hcy);
      ctx.lineTo(hcx - tickOuter, hcy);
      ctx.moveTo(hcx + tickInner, hcy);
      ctx.lineTo(hcx + tickOuter, hcy);
      ctx.stroke();
      ctx.lineCap = "butt";
    }

    // Focus pulse — after fly-to, a ring expands outward from the node
    // and fades. Lives ~1.6s; the flyToNode RAF loop clears focusedIdRef
    // when the window ends. Two overlapping rings at different phases
    // make it feel like a locked-on reticle instead of a single ripple.
    const focusedId = focusedIdRef.current;
    if (focusedId) {
      const fn = nodes.find((n) => n.id === focusedId);
      if (fn?.x != null) {
        const elapsed = performance.now() - focusStartRef.current;
        const baseR = nodeRadius(fn);
        const rgb = hexToRgb(fn.color);
        const phases = [0, 560]; // two staggered ripples
        for (const offset of phases) {
          const phaseT = elapsed - offset;
          if (phaseT < 0 || phaseT > 1100) continue;
          const u = phaseT / 1100;
          const radius = baseR + 4 + u * 30;
          const alpha = (1 - u) * 0.85;
          ctx.beginPath();
          ctx.arc(fn.x!, fn.y!, radius, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},${alpha})`;
          ctx.lineWidth = 1.6;
          ctx.stroke();
        }
        // Solid locked-on ring that sits for the whole focus window
        const lockAlpha = Math.max(0, 1 - elapsed / 1600);
        ctx.beginPath();
        ctx.arc(fn.x!, fn.y!, baseR + 3, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},${lockAlpha})`;
        ctx.lineWidth = 2;
        ctx.shadowColor = `rgba(${rgb.r},${rgb.g},${rgb.b},${lockAlpha * 0.8})`;
        ctx.shadowBlur = 14;
        ctx.stroke();
        ctx.shadowBlur = 0;
      }
    }

    ctx.restore();
  }, [size.w, size.h]);

  // Redraw on hover change — draw() reads hoveredRef.current (always fresh)
  useEffect(() => {
    draw();
  }, [hovered, draw]);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const t = transformRef.current;
      const mx = (e.clientX - rect.left - t.x) / t.k;
      const my = (e.clientY - rect.top - t.y) / t.k;
      setMousePos({ x: e.clientX - rect.left, y: e.clientY - rect.top });

      // Drag
      const d = dragRef.current;
      if (d) {
        transformRef.current.x = d.tx + (e.clientX - d.sx);
        transformRef.current.y = d.ty + (e.clientY - d.sy);
        draw();
        return;
      }

      // Grid-based spatial lookup — check only the 9 cells around the cursor
      // instead of all 1,395 nodes. O(~20) instead of O(1395).
      let nearest: SkillNode | null = null;
      let nearDist = 40;
      const gx = Math.floor(mx / GRID_CELL);
      const gy = Math.floor(my / GRID_CELL);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const cell = gridRef.current.get(`${gx + dx},${gy + dy}`);
          if (!cell) continue;
          for (const n of cell) {
            if (!n.matchesFilter) continue;
            const ddx = n.x! - mx;
            const ddy = n.y! - my;
            const dist = Math.sqrt(ddx * ddx + ddy * ddy);
            // Heroes capture within their full medallion + a tolerance;
            // stars only capture within a small pin radius so the user
            // doesn't grab random stars while panning through dense regions.
            const hitR = n.tier === "hero" ? 40 : 6;
            if (dist < Math.min(hitR, nearDist)) {
              nearDist = dist;
              nearest = n;
            }
          }
        }
      }
      setHovered(nearest);
    },
    [draw]
  );

  const handleClick = useCallback(() => {
    if (!hovered) return;
    setSelectedNode(hovered);
  }, [hovered]);

  const handleTeach = useCallback((n: DrawerNode) => {
    vscode.postMessage({
      type: "chat/send",
      message: `Teach me about ${n.name}. Show me a real example from my code if you can find one.`,
      mode: "text",
    });
    setSelectedNode(null);
  }, []);

  const handlePractice = useCallback((n: DrawerNode) => {
    vscode.postMessage({
      type: "chat/send",
      message: `Create a short, focused exercise to practice ${n.name}. Keep it under 25 lines of code. Set it up with a clear starter and checkpoints so I can self-check.`,
      mode: "text",
    });
    setSelectedNode(null);
  }, []);

  // Neighbors + concept for the selected node — computed from the current
  // simulation's links so it reflects what the user actually sees.
  const { drawerNode, drawerConcept, drawerConnected } = useMemo(() => {
    if (!selectedNode) {
      return {
        drawerNode: null as DrawerNode | null,
        drawerConcept: undefined,
        drawerConnected: [] as ConnectedSkill[],
      };
    }
    const neighborIds = new Set<string>();
    for (const link of linksRef.current) {
      const s = link.source as SkillNode;
      const tgt = link.target as SkillNode;
      if (s.id === selectedNode.id) neighborIds.add(tgt.id);
      else if (tgt.id === selectedNode.id) neighborIds.add(s.id);
    }
    const connected: ConnectedSkill[] = nodesRef.current
      .filter((n) => neighborIds.has(n.id))
      .sort((a, b) => b.mastery - a.mastery)
      .map((n) => ({
        id: n.id,
        name: n.name,
        color: n.color,
        mastery: n.mastery,
        detected: n.detected,
      }));
    const concept = effectiveConcepts.find((c) =>
      fuzzyMatch(c, selectedNode.name)
    );
    return {
      drawerNode: {
        id: selectedNode.id,
        name: selectedNode.name,
        color: selectedNode.color,
        domainLabel: selectedNode.domainLabel,
        difficulty: selectedNode.difficulty,
        mastery: selectedNode.mastery,
        timesUsed: selectedNode.timesUsed,
        detected: selectedNode.detected,
      },
      drawerConcept: concept
        ? {
            lastUsedAt: concept.lastUsedAt,
            daysSinceUsed: concept.daysSinceUsed,
            distinctFiles: concept.distinctFiles,
            iqContribution: concept.iqContribution,
          }
        : undefined,
      drawerConnected: connected,
    };
  }, [selectedNode, effectiveConcepts]);

  /**
   * Smoothly animate transformRef toward `target` using easeOutCubic.
   * A monotonic token supersedes any in-flight animation so a second
   * fly/home call immediately retargets instead of fighting for the ref.
   */
  const animateCameraTo = useCallback(
    (target: Transform, duration = 480) => {
      const start = { ...transformRef.current };
      const t0 = performance.now();
      const token = ++animTokenRef.current;
      const step = () => {
        if (token !== animTokenRef.current) return;
        const u = Math.min(1, (performance.now() - t0) / duration);
        transformRef.current = lerpTransform(start, target, easeOutCubic(u));
        draw();
        if (u < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    },
    [draw]
  );

  /** Frame every currently-matching node in the viewport with padding. */
  const handleHome = useCallback(() => {
    const visible = nodesRef.current.filter((n) => n.matchesFilter);
    const target = computeFitAll(visible, size, { padding: 70, minK: 0.5, maxK: 1.4 });
    animateCameraTo(target, 520);
  }, [animateCameraTo, size]);

  /**
   * Frame a specific set of domains. Deferred one paint so the filter-
   * driven simulation has a moment to move nodes before we target them.
   */
  const fitToDomains = useCallback(
    (domainIds: string[]) => {
      window.setTimeout(() => {
        const subset = nodesRef.current.filter((n) => domainIds.includes(n.domain));
        if (subset.length === 0) return;
        const target = computeFitAll(subset, size, {
          padding: 80,
          minK: 0.5,
          maxK: 1.5,
        });
        animateCameraTo(target, 520);
      }, 240);
    },
    [animateCameraTo, size]
  );

  /**
   * Center a node in the viewport and trigger its focus-pulse. The pulse
   * is drawn by draw() reading focusedIdRef; we kick a short RAF loop so
   * the pulse actually animates even when the simulation is cool.
   */
  const flyToNode = useCallback(
    (node: SkillNode) => {
      const target = computeFlyTo(node, size, 1.6);
      if (!target) return;
      animateCameraTo(target, 480);
      focusedIdRef.current = node.id;
      focusStartRef.current = performance.now();
      const pulseToken = ++animTokenRef.current;
      const pulseStep = () => {
        if (pulseToken !== animTokenRef.current) {
          // a newer animateCameraTo took over; let it handle draws.
          // Only clear focus when the pulse window has expired.
          const elapsed = performance.now() - focusStartRef.current;
          if (elapsed >= 1600 && focusedIdRef.current === node.id) {
            focusedIdRef.current = null;
            draw();
          }
          return;
        }
        const elapsed = performance.now() - focusStartRef.current;
        if (elapsed >= 1600) {
          focusedIdRef.current = null;
          draw();
          return;
        }
        draw();
        requestAnimationFrame(pulseStep);
      };
      requestAnimationFrame(pulseStep);
    },
    [animateCameraTo, draw, size]
  );

  /** Pan camera to a given world point, preserving current zoom. */
  const jumpToWorld = useCallback(
    (wx: number, wy: number) => {
      const k = transformRef.current.k;
      animateCameraTo({ x: size.w / 2 - wx * k, y: size.h / 2 - wy * k, k }, 360);
    },
    [animateCameraTo, size]
  );

  /** Enter in the search box flies to the top-importance matching node. */
  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key !== "Enter") return;
      const top = nodesRef.current
        .filter((n) => n.matchesFilter && n.x != null)
        .sort((a, b) => b.importance - a.importance)[0];
      if (top) flyToNode(top);
    },
    [flyToNode]
  );

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const t = transformRef.current;
      const factor = e.deltaY > 0 ? 0.93 : 1.07;
      const newK = Math.max(0.3, Math.min(4, t.k * factor));
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      transformRef.current = {
        x: mx - (mx - t.x) * (newK / t.k),
        y: my - (my - t.y) * (newK / t.k),
        k: newK,
      };
      draw();
    },
    [draw]
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (hovered) return;
      dragRef.current = {
        sx: e.clientX,
        sy: e.clientY,
        tx: transformRef.current.x,
        ty: transformRef.current.y,
      };
    },
    [hovered]
  );

  const detectedCount = useMemo(
    () => {
      const nameSet = new Set(effectiveConcepts.map((c: ConceptRow) => c.name.toLowerCase().replace(/[^a-z0-9]/g, "")));
      let count = 0;
      for (const d of domains) {
        for (const t of d.topics) {
          for (const s of t.skills) {
            const sn = s.name.toLowerCase().replace(/[^a-z0-9]/g, "");
            if (nameSet.has(sn)) count++;
          }
        }
      }
      return count;
    },
    [effectiveConcepts, domains]
  );

  const totalSkills = useMemo(
    () => domains.reduce((s, d) => s + d.topics.reduce((s2, t) => s2 + t.skills.length, 0), 0),
    [domains]
  );

  // Filtered counts — update live as the user applies filters
  const filteredTotal = nodesRef.current.length;
  const filteredDetected = nodesRef.current.filter((n) => n.detected).length;
  const heroCount = nodesRef.current.filter((n) => n.tier === "hero").length;

  const canvasH = fullscreen ? "100%" : Math.max(200, (propH ?? 480) - filterH - 24);

  const content = (
    <>
      {/* Filter container — measured by ResizeObserver to compute canvas height */}
      <div ref={filterRef} className="constellation-filter-group">
      <div className="constellation-filters">
        {onBackToTree && !fullscreen && (
          <button
            className="constellation-filter-btn constellation-back-btn"
            onClick={onBackToTree}
            title="Back to skill tree"
            aria-label="Back to tree"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 4L6 8l4 4" />
            </svg>
            <span>Tree</span>
          </button>
        )}
        <input
          type="text"
          className="constellation-search"
          placeholder={`Search ${totalSkills} skills... (Enter to fly)`}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={handleSearchKeyDown}
        />
        <button
          className={`constellation-filter-btn ${mySkillsOnly ? "active" : ""}`}
          onClick={() => setMySkillsOnly(!mySkillsOnly)}
        >
          {mySkillsOnly ? "Mine" : "All"}
        </button>
        <button
          className="constellation-filter-btn constellation-home-btn"
          onClick={handleHome}
          title="Fit all matching skills in view"
          aria-label="Fit all"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 6V3h3" />
            <path d="M13 6V3h-3" />
            <path d="M3 10v3h3" />
            <path d="M13 10v3h-3" />
          </svg>
        </button>
        <button
          className="constellation-filter-btn"
          onClick={() => setFullscreen(!fullscreen)}
          title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
        >
          {fullscreen ? "✕" : "⛶"}
        </button>
      </div>

      {/* Area meta-filter — single compact row */}
      <div className="constellation-domains">
        {AREAS.map((a) => (
          <button
            key={a.id}
            className={`constellation-domain-btn area-btn ${areaFilter === a.id ? "active" : ""}`}
            onClick={() => {
              const next = areaFilter === a.id ? null : a.id;
              setAreaFilter(next);
              setDomainFilter(null);
              setTopicFilter(null);
              if (next === null) {
                window.setTimeout(handleHome, 240);
              } else {
                fitToDomains(a.domains);
              }
            }}
          >
            {a.label}
          </button>
        ))}
      </div>

      {/* Domain drill-down chips — only visible when an area is selected.
          Shows each domain in that area with detected/total count.
          Click a chip → set domainFilter + fly-fit to just that cluster. */}
      {areaFilter && (() => {
        const area = AREAS.find((a) => a.id === areaFilter);
        if (!area) return null;
        return (
          <div className="constellation-chip-row">
            {area.domains
              .map((id) => domains.find((d) => d.id === id))
              .filter((d): d is TaxDomain => !!d)
              .map((d) => {
                const total = d.topics.reduce((s, t) => s + t.skills.length, 0);
                const detected = nodesRef.current.filter(
                  (n) => n.domain === d.id && n.detected
                ).length;
                const active = domainFilter === d.id;
                return (
                  <button
                    key={d.id}
                    className={`constellation-chip ${active ? "active" : ""}`}
                    style={
                      active
                        ? {
                            borderColor: d.color,
                            boxShadow: `inset 0 0 0 1px ${d.color}66`,
                          }
                        : undefined
                    }
                    onClick={() => {
                      const next = active ? null : d.id;
                      setDomainFilter(next);
                      setTopicFilter(null);
                      if (next === null) {
                        fitToDomains(area.domains);
                      } else {
                        fitToDomains([d.id]);
                      }
                    }}
                  >
                    <span
                      className="chip-dot"
                      style={{ background: d.color }}
                    />
                    <span className="chip-label">{d.label}</span>
                    <span className="chip-count">
                      {detected}/{total}
                    </span>
                  </button>
                );
              })}
          </div>
        );
      })()}
      </div>{/* end constellation-filter-group */}

      <canvas
        ref={canvasRef}
        className="constellation-canvas"
        style={{
          width: size.w,
          height: canvasH,
          cursor: hovered ? "pointer" : "grab",
        }}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => {
          setHovered(null);
          dragRef.current = null;
        }}
        onMouseDown={handleMouseDown}
        onMouseUp={() => (dragRef.current = null)}
        onClick={handleClick}
        onWheel={handleWheel}
      />

      <ConstellationMinimap
        nodesRef={nodesRef}
        transformRef={transformRef}
        mainSize={size}
        onJumpTo={jumpToWorld}
      />

      <ConstellationNodeDrawer
        node={drawerNode}
        concept={drawerConcept}
        connected={drawerConnected}
        onClose={() => setSelectedNode(null)}
        onTeach={handleTeach}
        onPractice={handlePractice}
      />

      {hovered && (
        <div
          className="constellation-tooltip"
          style={{
            left: Math.min(mousePos.x + 12, size.w - 170),
            top: Math.max(mousePos.y - 50, 80),
          }}
        >
          <div className="ct-name">{hovered.name}</div>
          <div className="ct-cluster microcaps">
            {hovered.domainLabel} · difficulty {hovered.difficulty}/5
          </div>
          {hovered.detected ? (
            <>
              <div className="ct-bar">
                <div
                  className="ct-bar-fill"
                  style={{ width: `${Math.round(hovered.mastery * 100)}%` }}
                />
              </div>
              <div className="ct-meta microcaps">
                {Math.round(hovered.mastery * 100)}% mastery · {hovered.timesUsed} uses
              </div>
            </>
          ) : (
            <div className="ct-undiscovered microcaps">Not yet detected in your code</div>
          )}
          <div className="ct-hint microcaps">Click to learn</div>
        </div>
      )}

      <div className="constellation-legend microcaps">
        {heroCount} heroes · {filteredTotal - heroCount} stars ·{" "}
        {filteredDetected} detected · zoom in to reveal names
        {fullscreen && " · ESC exits"}
      </div>
    </>
  );

  if (fullscreen) {
    return (
      <div className="constellation-fullscreen">
        <div ref={wrapRef} className="constellation-wrap constellation-fs-inner">
          {content}
        </div>
      </div>
    );
  }

  return (
    <div ref={wrapRef} className="constellation-wrap" style={{ height: propH ?? 480 }}>
      {content}
    </div>
  );
}
