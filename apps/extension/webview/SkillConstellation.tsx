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
        });
      }
    }
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
}

export function SkillConstellation({ concepts, height: propH }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 340, h: propH ?? 380 });
  const [hovered, setHovered] = useState<SkillNode | null>(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const [search, setSearch] = useState("");
  const [domainFilter, setDomainFilter] = useState<string | null>(null);
  const [areaFilter, setAreaFilter] = useState<Area | null>(null);
  const [topicFilter, setTopicFilter] = useState<string | null>(null);
  const [levelFilter, setLevelFilter] = useState<LevelFilter>("all");
  const [mySkillsOnly, setMySkillsOnly] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  const nodesRef = useRef<SkillNode[]>([]);
  const linksRef = useRef<SkillLink[]>([]);
  const transformRef = useRef({ x: 0, y: 0, k: 1 });
  const dragRef = useRef<{ sx: number; sy: number; tx: number; ty: number } | null>(null);
  const simRef = useRef<ReturnType<typeof forceSimulation<SkillNode>> | null>(null);
  // Position cache — survives filter changes so nodes don't jump.
  const posCache = useRef(new Map<string, { x: number; y: number }>());
  // Grid-based spatial index for O(1) hover hit testing.
  const gridRef = useRef(new Map<string, SkillNode[]>());
  const GRID_CELL = 40;
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
      if (width > 0) setSize({ w: width, h: propH ?? Math.max(320, height) });
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
    const spread = Math.min(size.w, size.h) * 0.3;
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
            return s.topic === t.topic ? 22 : 55;
          })
          .strength((l) => {
            const s = l.source as SkillNode;
            const t = l.target as SkillNode;
            return s.topic === t.topic ? 0.7 : 0.12;
          })
      )
      .force("charge", forceManyBody().strength(-70))
      .force("center", forceCenter(size.w / 2, size.h / 2))
      .force("collide", forceCollide<SkillNode>().radius((d) => nodeRadius(d) + 6))
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

  function nodeRadius(n: SkillNode): number {
    if (!n.detected) return 3.5;
    return 5 + n.mastery * 6 + n.difficulty * 0.8;
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
        ctx.strokeStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},0.6)`;
        ctx.lineWidth = 1.5;
        ctx.shadowColor = `rgba(${rgb.r},${rgb.g},${rgb.b},0.3)`;
        ctx.shadowBlur = 4;
      } else if (bothDetected && !dimmed) {
        // Active connection between detected nodes
        const rgb = hexToRgb(s.color);
        ctx.strokeStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},0.12)`;
        ctx.lineWidth = 0.8;
        ctx.shadowBlur = 0;
      } else if (dimmed) {
        ctx.strokeStyle = "rgba(255,255,255,0.015)";
        ctx.lineWidth = 0.3;
        ctx.shadowBlur = 0;
      } else {
        ctx.strokeStyle = "rgba(255,255,255,0.04)";
        ctx.lineWidth = 0.4;
        ctx.shadowBlur = 0;
      }

      ctx.beginPath();
      ctx.moveTo(s.x!, s.y!);
      ctx.lineTo(tgt.x!, tgt.y!);
      ctx.stroke();
    }
    ctx.shadowBlur = 0;

    // === Nodes ===
    for (const n of nodes) {
      if (n.x == null || n.y == null) continue;
      const r = nodeRadius(n);
      const dimmed = !n.matchesFilter;
      const rgb = hexToRgb(n.color);
      const isHoverNeighbor = hoveredAdj.has(n.id);
      const isHovered = n === hoveredNode;

      // Dim everything except hovered cluster when hovering
      const hoverDim = hoveredNode && !isHovered && !isHoverNeighbor;

      if (dimmed || hoverDim) {
        // Ghost node
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fillStyle = n.detected
          ? `rgba(${rgb.r},${rgb.g},${rgb.b},${hoverDim ? 0.08 : 0.05})`
          : `rgba(255,255,255,${hoverDim ? 0.03 : 0.04})`;
        ctx.fill();
        continue;
      }

      if (n.detected) {
        // === Detected node: color + glow based on mastery ===
        const alpha = 0.4 + n.mastery * 0.6;

        // Outer glow
        if (n.mastery > 0.1) {
          const glowR = r + 6 + n.mastery * 6;
          const grad = ctx.createRadialGradient(n.x, n.y, r * 0.5, n.x, n.y, glowR);
          grad.addColorStop(0, `rgba(${rgb.r},${rgb.g},${rgb.b},${n.mastery * 0.25})`);
          grad.addColorStop(1, "transparent");
          ctx.beginPath();
          ctx.arc(n.x, n.y, glowR, 0, Math.PI * 2);
          ctx.fillStyle = grad;
          ctx.fill();
        }

        // Node body
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},${alpha})`;
        ctx.fill();

        // Border ring
        ctx.strokeStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},${0.3 + n.mastery * 0.5})`;
        ctx.lineWidth = n.mastery > 0.7 ? 1.5 : 0.8;
        ctx.stroke();

        // Inner highlight dot for mastered nodes
        if (n.mastery > 0.7) {
          ctx.beginPath();
          ctx.arc(n.x, n.y, r * 0.35, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(255,255,255,0.4)`;
          ctx.fill();
        }
      } else {
        // === Undetected node: hollow circle ===
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255,255,255,0.03)";
        ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.08)";
        ctx.lineWidth = 0.5;
        ctx.stroke();
      }

      // Labels
      const showLabel = isHovered || isHoverNeighbor || (n.detected && r >= 6);
      if (showLabel) {
        ctx.font = isHovered
          ? "600 10px 'Space Grotesk', sans-serif"
          : "500 8px 'Space Grotesk', sans-serif";
        ctx.fillStyle = isHovered
          ? "rgba(255,255,255,0.95)"
          : `rgba(255,255,255,${n.detected ? 0.7 : 0.4})`;
        ctx.textAlign = "center";
        ctx.fillText(n.name, n.x, n.y + r + (isHovered ? 14 : 11));
      }
    }

    // === Domain cluster labels ===
    const domainCenters = new Map<string, { x: number; y: number; c: number; label: string; rgb: { r: number; g: number; b: number } }>();
    for (const n of nodes) {
      if (n.x == null || !n.matchesFilter) continue;
      const d = domainCenters.get(n.domain) ?? { x: 0, y: 0, c: 0, label: n.domainLabel, rgb: hexToRgb(n.color) };
      d.x += n.x!;
      d.y += n.y!;
      d.c++;
      domainCenters.set(n.domain, d);
    }
    ctx.textAlign = "center";
    for (const d of domainCenters.values()) {
      if (d.c < 3) continue;
      const cx = d.x / d.c;
      const cy = d.y / d.c;
      ctx.font = "700 11px 'Geist Mono', monospace";
      ctx.fillStyle = `rgba(${d.rgb.r},${d.rgb.g},${d.rgb.b},0.3)`;
      ctx.fillText(d.label.toUpperCase(), cx, cy - 26);
    }

    // Hover ring + label
    if (hoveredNode?.x != null) {
      const hr = nodeRadius(hoveredNode);
      const hrgb = hexToRgb(hoveredNode.color);
      ctx.beginPath();
      ctx.arc(hoveredNode.x!, hoveredNode.y!, hr + 3, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${hrgb.r},${hrgb.g},${hrgb.b},0.8)`;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // Always draw hovered label even if normally hidden
      ctx.font = "600 9px 'Space Grotesk', sans-serif";
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.textAlign = "center";
      ctx.fillText(hoveredNode.name, hoveredNode.x!, hoveredNode.y! + hr + 12);
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
      let nearDist = 18;
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
            if (dist < nearDist) {
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
    vscode.postMessage({
      type: "chat/send",
      message: `Teach me about ${hovered.name}. Show me a real example from my code if you can find one.`,
      mode: "text",
    });
  }, [hovered]);

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

  const canvasH = fullscreen ? "100%" : Math.max(200, (propH ?? 380) - filterH - 24);

  const content = (
    <>
      {/* Filter container — measured by ResizeObserver to compute canvas height */}
      <div ref={filterRef} className="constellation-filter-group">
      <div className="constellation-filters">
        <input
          type="text"
          className="constellation-search"
          placeholder={`Search ${totalSkills} skills...`}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button
          className={`constellation-filter-btn ${mySkillsOnly ? "active" : ""}`}
          onClick={() => setMySkillsOnly(!mySkillsOnly)}
        >
          {mySkillsOnly ? "Mine" : "All"}
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
              setAreaFilter(areaFilter === a.id ? null : a.id);
              setDomainFilter(null);
              setTopicFilter(null);
            }}
          >
            {a.label}
          </button>
        ))}
      </div>
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
        {filteredDetected} / {filteredTotal} shown · {detectedCount} / {totalSkills} total · scroll zoom · drag pan
        {fullscreen && " · ESC to exit"}
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
    <div ref={wrapRef} className="constellation-wrap" style={{ height: propH ?? 380 }}>
      {content}
    </div>
  );
}
