import React from "react";
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
  type LucideIcon,
} from "lucide-react";

// Per-icon imports via unplugin-icons. Each `~icons/...` path is resolved
// by the Vite plugin into a tiny React component containing only that
// SVG's path data — so tree-shaking works per-icon and our bundle ships
// just the ~16 glyphs we reference instead of the full icon set.
//
// Devicon Plain is the primary source (monochrome-first, purpose-built
// to read white on dark). Simple Icons covers the gaps — notably React,
// which Devicon Plain omits.
import IconJavaScript from "~icons/devicon-plain/javascript";
import IconTypeScript from "~icons/devicon-plain/typescript";
import IconReact from "~icons/simple-icons/react";
import IconNextjs from "~icons/devicon-plain/nextjs";
import IconCss from "~icons/devicon-plain/css3";
import IconNodejs from "~icons/devicon-plain/nodejs";
import IconPython from "~icons/devicon-plain/python";
import IconGo from "~icons/devicon-plain/go";
import IconRust from "~icons/devicon-plain/rust";
import IconJava from "~icons/devicon-plain/java";
import IconCsharp from "~icons/devicon-plain/csharp";
import IconKotlin from "~icons/devicon-plain/kotlin";
import IconSwift from "~icons/devicon-plain/swift";
import IconPhp from "~icons/devicon-plain/php";
import IconRuby from "~icons/devicon-plain/ruby";

/**
 * Domain icons — Devicon Plain (monoline) for language brands, Lucide
 * for categorical domains. All rendered uniform white via currentColor
 * so the UI reads as an app, not a logo wall.
 */

const DEFAULT_SIZE = 18;

type BrandGlyph = React.ComponentType<React.SVGProps<SVGSVGElement>>;

const BRAND: Record<string, BrandGlyph> = {
  javascript: IconJavaScript,
  typescript: IconTypeScript,
  react: IconReact,
  nextjs: IconNextjs,
  css: IconCss,
  node: IconNodejs,
  nodejs: IconNodejs,
  python: IconPython,
  go: IconGo,
  rust: IconRust,
  java: IconJava,
  csharp: IconCsharp,
  kotlin: IconKotlin,
  swift: IconSwift,
  php: IconPhp,
  ruby: IconRuby,
};

/** Categorical domains — Lucide line icons, already clean monoline. */
const LUCIDE: Record<string, LucideIcon> = {
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

export function DomainIcon({
  domainId,
  color: _color,
  size = DEFAULT_SIZE,
}: {
  domainId: string;
  /** Kept for API compatibility; ignored — icons are uniform white. */
  color?: string;
  size?: number;
}) {
  const style = { color: "#fff", display: "inline-flex", lineHeight: 0 };

  const Brand = BRAND[domainId];
  if (Brand) {
    return (
      <span className="domain-icon" style={style}>
        <Brand width={size} height={size} fill="currentColor" />
      </span>
    );
  }

  const LucideGlyph = LUCIDE[domainId];
  if (LucideGlyph) {
    return (
      <span className="domain-icon" style={style}>
        <LucideGlyph size={size} strokeWidth={1.6} />
      </span>
    );
  }

  // Unknown domain — minimal circle glyph so layout never breaks.
  return (
    <span className="domain-icon" style={style}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      >
        <circle cx="8" cy="8" r="5" />
      </svg>
    </span>
  );
}
