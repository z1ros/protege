import { RULES } from "./rules.js";

/**
 * A detected concept with a context score indicating usage sophistication.
 *
 * contextScore multipliers:
 *   1.0 = simple usage (keyword exists in isolation)
 *   1.5 = standard usage (typed, or combined with one related concept)
 *   2.0 = advanced usage (multiple related concepts nearby, good patterns)
 *   2.5 = sophisticated usage (inside a custom abstraction, tested, typed)
 *   3.0 = expert usage (composing 3+ concepts with types + error handling + tests)
 */
export interface DetectedConcept {
  name: string;
  contextScore: number; // 1.0 – 3.0
}

/**
 * Detect which concepts appear in a file with context-aware scoring.
 *
 * Phase 1: regex pattern matching (same as before — finds WHAT was used).
 * Phase 2: context analysis around each match (NEW — scores HOW it was used).
 *
 * Each concept is counted once per file save with its max context score.
 */
export function detectConceptsWithContext(
  language: string,
  content: string,
  filePath: string
): DetectedConcept[] {
  const lines = content.split("\n");
  const results = new Map<string, number>(); // name → max context score

  for (const rule of RULES) {
    if (!rule.languages.includes(language)) continue;

    for (const pattern of rule.patterns) {
      // Find ALL match positions (not just boolean test)
      const globalPattern = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
      let match: RegExpExecArray | null;

      // Reset lastIndex for safety
      globalPattern.lastIndex = 0;
      let matched = false;

      while ((match = globalPattern.exec(content)) !== null) {
        matched = true;
        // Find the line number of this match
        const matchLine = content.slice(0, match.index).split("\n").length - 1;

        // Score the context around this match
        const score = scoreContext(lines, matchLine, rule.name, filePath);

        // Keep the highest score for this concept
        const existing = results.get(rule.name) ?? 0;
        if (score > existing) {
          results.set(rule.name, score);
        }

        // Don't need to find ALL occurrences — just enough to get the best score
        if (score >= 2.5) break;

        // Prevent infinite loops on zero-width matches
        if (match[0].length === 0) globalPattern.lastIndex++;
      }

      if (matched) break; // Don't check other patterns for the same rule
    }
  }

  return [...results.entries()].map(([name, contextScore]) => ({
    name,
    contextScore,
  }));
}

/**
 * Legacy function — returns just concept names (backward compatible).
 * Used by callers that don't need context scores.
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

/* ==========================================================
   Context Analyzer — scores HOW a concept is used, not just IF.

   Reads ±20 lines around each match and checks:
   1. Related concepts nearby (composing skills)
   2. TypeScript type annotations present
   3. Error handling (try/catch) wrapping the usage
   4. Nesting depth (inside a function/class/module)
   5. Test file bonus (file is a test OR imports are tested)
   ========================================================== */

// Patterns that indicate sophistication in surrounding context
const TYPE_ANNOTATION_PATTERNS = [
  /:\s*\w+(\[\])?(<[^>]+>)?(\s*\||\s*&)?/,  // : Type, : Type[], : Type<T>
  /\binterface\s+\w+/,
  /\btype\s+\w+\s*=/,
  /<[A-Z]\w*>/,                               // <T> generic
  /as\s+\w+/,                                  // type assertion
];

const ERROR_HANDLING_PATTERNS = [
  /\btry\s*\{/,
  /\.catch\s*\(/,
  /\.finally\s*\(/,
  /\bthrow\s+new\s+/,
];

const CUSTOM_ABSTRACTION_PATTERNS = [
  /function\s+use[A-Z]\w*/,     // custom hook definition
  /const\s+use[A-Z]\w*\s*=/,   // custom hook as arrow
  /export\s+(default\s+)?function/,
  /export\s+const\s+\w+\s*=/,
  /class\s+\w+/,
];

const TEST_FILE_INDICATORS = [
  /\.(test|spec)\.(ts|tsx|js|jsx)$/,
  /__(tests|test)__\//,
  /\bdescribe\s*\(/,
  /\bit\s*\(/,
  /\btest\s*\(/,
  /\bexpect\s*\(/,
];

// Map of concept names to related concepts (for composability scoring)
const RELATED_CONCEPTS: Record<string, string[]> = {
  "React useState": ["React useEffect", "React useCallback", "React useMemo", "React useRef"],
  "React useEffect": ["React useState", "React useRef", "React useCallback", "React useEffect cleanup"],
  "React useEffect cleanup": ["React useEffect", "React useRef"],
  "React useMemo": ["React useCallback", "React useState"],
  "React useCallback": ["React useMemo", "React useRef"],
  "React useRef": ["React useEffect", "React useState"],
  "React useReducer": ["React useState", "React useContext"],
  "React custom hook": ["React useState", "React useEffect", "React useRef", "React useCallback"],
  "async/await": ["Promises", "Error handling", "Fetch API"],
  "Promises": ["async/await", "Error handling"],
  "Array reduce": ["Array map", "Array filter", "Destructuring"],
  "Array map": ["Array filter", "Array reduce", "Arrow functions"],
  "TypeScript generics": ["TypeScript interface", "TypeScript type alias", "Generic constraints"],
  "Generic constraints": ["TypeScript generics", "Conditional types"],
  "Conditional types": ["TypeScript generics", "Generic constraints", "TypeScript type alias"],
  "Destructuring": ["Spread / rest", "Arrow functions"],
  "Error handling": ["async/await", "Promises"],
};

function scoreContext(
  lines: string[],
  matchLine: number,
  conceptName: string,
  filePath: string
): number {
  let score = 1.0;

  // Extract ±20 lines of context
  const start = Math.max(0, matchLine - 20);
  const end = Math.min(lines.length, matchLine + 21);
  const contextWindow = lines.slice(start, end).join("\n");
  const matchLineContent = lines[matchLine] ?? "";

  // 1. Related concepts nearby (+0.15 per related concept found, max +0.6)
  const related = RELATED_CONCEPTS[conceptName] ?? [];
  let relatedCount = 0;
  for (const rel of related) {
    const relRule = RULES.find((r) => r.name === rel);
    if (relRule) {
      for (const p of relRule.patterns) {
        if (p.test(contextWindow)) {
          relatedCount++;
          break;
        }
      }
    }
  }
  score += Math.min(0.6, relatedCount * 0.15);

  // 2. Type annotations in context (+0.3 if present)
  const hasTypes = TYPE_ANNOTATION_PATTERNS.some((p) => p.test(contextWindow));
  if (hasTypes) score += 0.3;

  // 3. Error handling around the usage (+0.25 if wrapped in try/catch)
  const hasErrorHandling = ERROR_HANDLING_PATTERNS.some((p) => p.test(contextWindow));
  if (hasErrorHandling) score += 0.25;

  // 4. Inside a custom abstraction (+0.2 if inside a named function/class)
  const insideAbstraction = CUSTOM_ABSTRACTION_PATTERNS.some((p) => {
    // Check lines ABOVE the match to see if we're inside a function/class
    const above = lines.slice(Math.max(0, matchLine - 15), matchLine).join("\n");
    return p.test(above);
  });
  if (insideAbstraction) score += 0.2;

  // 5. Nesting depth: count { before this line - count } before this line
  const beforeMatch = lines.slice(0, matchLine).join("\n");
  const openBraces = (beforeMatch.match(/\{/g) ?? []).length;
  const closeBraces = (beforeMatch.match(/\}/g) ?? []).length;
  const depth = openBraces - closeBraces;
  if (depth >= 3) score += 0.15; // deeply nested = more complex usage

  // 6. Test file bonus (+0.3 if this file is a test file)
  const isTestFile = TEST_FILE_INDICATORS.some((p) =>
    typeof p === "object" ? p.test(filePath) || p.test(contextWindow) : false
  );
  if (isTestFile) score += 0.3;

  // Cap at 3.0
  return Math.min(3.0, Math.round(score * 100) / 100);
}
