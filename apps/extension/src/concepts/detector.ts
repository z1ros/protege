import { RULES } from "./rules.js";

/**
 * Detect which concepts appear in a file. Returns unique concept names.
 * Each concept counted once per file save — not per occurrence — so a
 * user using `.map` 5 times in one file doesn't get 5x mastery in one save.
 */
export function detectConcepts(language: string, content: string): string[] {
  const hits = new Set<string>();
  for (const rule of RULES) {
    if (!rule.languages.includes(language)) continue;
    for (const pattern of rule.patterns) {
      if (pattern.test(content)) {
        hits.add(rule.name);
        break;
      }
    }
  }
  return [...hits];
}
