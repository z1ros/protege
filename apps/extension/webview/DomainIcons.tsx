import React from "react";
import {
  siJavascript,
  siTypescript,
  siReact,
  siNextdotjs,
  siCss,
  siNodedotjs,
  siPython,
  siGo,
  siRust,
  siOpenjdk,
  siSharp,
  siKotlin,
  siSwift,
  siPhp,
  siRuby,
  type SimpleIcon,
} from "simple-icons";
import {
  Shield,
  FlaskConical,
  Infinity as InfinityIcon,
  BrainCircuit,
  Gauge,
  Accessibility,
  Smartphone,
  Network,
  Cloud,
  Wrench,
  Database,
  Layers,
  GitBranch,
} from "lucide-react";

/**
 * Domain icons — real brand logos via simple-icons (JS, TS, React, Next.js,
 * Python, Go, Rust, etc.) and Feather-style line icons via lucide-react for
 * categorical domains (Security, Testing, DevOps, Cloud, etc.).
 *
 * Brand icons render in the brand's official hex color; categorical icons
 * inherit the taxonomy color passed in via `color`.
 */

const S = 18;

function BrandIcon({ icon }: { icon: SimpleIcon }) {
  return (
    <svg
      width={S}
      height={S}
      viewBox="0 0 24 24"
      fill={`#${icon.hex}`}
      aria-label={icon.title}
      role="img"
    >
      <path d={icon.path} />
    </svg>
  );
}

// Brand domains — use the official simple-icons SVG path + brand color.
const BRAND: Record<string, SimpleIcon> = {
  javascript: siJavascript,
  typescript: siTypescript,
  react: siReact,
  nextjs: siNextdotjs,
  css: siCss,
  node: siNodedotjs,
  nodejs: siNodedotjs,
  python: siPython,
  go: siGo,
  rust: siRust,
  java: siOpenjdk,
  csharp: siSharp,
  kotlin: siKotlin,
  swift: siSwift,
  php: siPhp,
  ruby: siRuby,
};

// Categorical domains — use lucide line icons, tinted by taxonomy color.
const LUCIDE: Record<string, React.ComponentType<{ size?: number; strokeWidth?: number }>> = {
  sql: Database,
  "system-design": Layers,
  security: Shield,
  testing: FlaskConical,
  devops: InfinityIcon,
  "ai-ml": BrainCircuit,
  "web-performance": Gauge,
  accessibility: Accessibility,
  mobile: Smartphone,
  protocols: Network,
  cloud: Cloud,
  "dev-tools": Wrench,
  dsa: GitBranch,
};

export function DomainIcon({ domainId, color }: { domainId: string; color: string }) {
  const brand = BRAND[domainId];
  if (brand) {
    return (
      <span className="domain-icon">
        <BrandIcon icon={brand} />
      </span>
    );
  }
  const LucideGlyph = LUCIDE[domainId];
  if (LucideGlyph) {
    return (
      <span className="domain-icon" style={{ color, display: "inline-flex" }}>
        <LucideGlyph size={S} strokeWidth={1.6} />
      </span>
    );
  }
  // Unknown domain — minimal colored dot so layout doesn't break.
  return (
    <span className="domain-icon" style={{ color }}>
      <svg width={S} height={S} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
        <circle cx="8" cy="8" r="5" />
      </svg>
    </span>
  );
}
