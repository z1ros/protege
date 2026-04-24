import { RULES, getWeight } from "./rules.js";
import { detectFromAst } from "./astDetector.js";

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

const JS_TS_LANGS = new Set([
  "javascript",
  "typescript",
  "javascriptreact",
  "typescriptreact",
]);

/**
 * Regex-only concept detection with context scoring.
 *
 * Intentionally does NOT delegate to AST — this is called exclusively by
 * hybridDetector, which already runs the AST layer separately and would
 * double-work every JS/TS file if we delegated here. For JS/TS files the
 * rules in rules.ts carry empty `languages`, so this returns `[]` — AST
 * covers them via Layer 1 in the hybrid pipeline.
 *
 * Direct external callers that need JS/TS coverage should use
 * `detectConcepts()` (which delegates to AST) or `detectHybrid()`.
 */
export function detectConceptsWithContext(
  language: string,
  content: string,
  filePath: string
): DetectedConcept[] {
  return detectFromRegex(language, content, filePath);
}

/**
 * Legacy name-only variant. Same routing as `detectConceptsWithContext`.
 * Used by callers that only need concept names (status bar, save recap,
 * quizMe, weak spots, concept trail).
 */
export function detectConcepts(language: string, content: string): string[] {
  if (JS_TS_LANGS.has(language)) {
    // filePath is only used by AST for test-file detection; an empty path
    // just means no test-file bonus, which is fine for name-only callers.
    // Sort by rule weight descending so callers that only read concepts[0]
    // (e.g. statusBarLive's concept-at-cursor) see the most teachable
    // concept first rather than whichever node AST visited first.
    return detectFromAst(content, "", language)
      .map((c) => c.name)
      .sort((a, b) => getWeight(b) - getWeight(a));
  }

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
   Regex path — used for Python (and any future non-AST language).

   Scoring is deliberately simple: base 1.0 + test-file bonus.
   Fine-grained context scoring (related concepts, type annotations,
   try/catch nesting, custom abstractions) is handled by the AST layer
   for JS/TS. Python code is short-form idiomatic enough that the base
   score carries the signal.
   ========================================================== */

const TEST_FILE_PATH_PATTERNS = [
  /\.(test|spec)\.(ts|tsx|js|jsx|py)$/,
  /__(tests|test)__\//,
  /\btest_[\w_]+\.py$/,
  /\b[\w_]+_test\.py$/,
];

function detectFromRegex(
  language: string,
  content: string,
  filePath: string
): DetectedConcept[] {
  const results = new Map<string, number>();
  const isTestFile = TEST_FILE_PATH_PATTERNS.some((p) => p.test(filePath));
  const bonus = isTestFile ? 0.3 : 0;

  for (const rule of RULES) {
    if (!rule.languages.includes(language)) continue;

    let matched = false;
    for (const pattern of rule.patterns) {
      if (pattern.test(content)) {
        matched = true;
        break;
      }
    }
    if (matched) {
      const score = Math.min(3.0, 1.0 + bonus);
      const prev = results.get(rule.name) ?? 0;
      if (score > prev) results.set(rule.name, score);
    }
  }

  return [...results.entries()].map(([name, contextScore]) => ({
    name,
    contextScore,
  }));
}
