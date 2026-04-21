import { detectFromAst, type AstDetectedConcept } from "./astDetector.js";
import { detectFromAi, type AiDetectedConcept } from "./aiDetector.js";
import { detectConceptsWithContext, type DetectedConcept } from "./detector.js";

/**
 * Hybrid concept detection — three layers, each catching what the others miss:
 *
 *   Layer 1: TypeScript AST (instant, 200+ concepts, accurate)
 *            Detects: hooks, array methods, async patterns, TS types,
 *            classes, modules, error handling, JSX, generics, etc.
 *
 *   Layer 2: Regex runner (instant, 7 Python patterns)
 *            Python is the only language here — AST handles JS/TS
 *            entirely. The detector.ts entry point delegates JS/TS to
 *            the AST layer, so this call is a no-op for those files.
 *
 *   Layer 3: On-device AI (fast, free, catches design patterns + soft concepts)
 *            Detects: SOLID principles, design patterns, architecture,
 *            code quality signals, framework idioms.
 *            Only runs if the on-device model (Qwen2.5-Coder) is loaded.
 *
 * The hybrid detector merges results from all three layers, taking the
 * highest context score when the same concept is detected by multiple layers.
 */

export interface HybridDetectionResult {
  /** All detected concepts with their best scores */
  concepts: DetectedConcept[];
  /** Breakdown of where each detection came from */
  sources: {
    ast: number;     // concepts found by AST
    regex: number;   // concepts found by regex (not already in AST)
    ai: number;      // concepts found by AI (not already in AST or regex)
    total: number;   // deduplicated total
  };
  /** Time taken in ms */
  durationMs: number;
}

/**
 * Run hybrid detection on a file.
 *
 * @param content File content
 * @param filePath Absolute or relative path (used for test-file detection)
 * @param languageId VS Code language identifier
 * @param fileHash Content hash for AI cache
 * @param enableAi Whether to run the AI layer (disabled by default for speed)
 */
export async function detectHybrid(
  content: string,
  filePath: string,
  languageId: string,
  fileHash: string,
  enableAi = false
): Promise<HybridDetectionResult> {
  const startMs = performance.now();
  const merged = new Map<string, DetectedConcept>();

  // Layer 1: AST (instant, most accurate for JS/TS)
  const astResults = detectFromAst(content, filePath, languageId);
  for (const r of astResults) {
    const existing = merged.get(r.name);
    if (!existing || r.contextScore > existing.contextScore) {
      merged.set(r.name, { name: r.name, contextScore: r.contextScore });
    }
  }
  const astCount = merged.size;

  // Layer 2: Regex (catches Python, CSS, and anything AST missed)
  const regexResults = detectConceptsWithContext(languageId, content, filePath);
  for (const r of regexResults) {
    const existing = merged.get(r.name);
    if (!existing || r.contextScore > existing.contextScore) {
      merged.set(r.name, { name: r.name, contextScore: r.contextScore });
    }
  }
  const regexCount = merged.size - astCount;

  // Layer 3: AI (only if enabled + file is long enough)
  let aiCount = 0;
  if (enableAi) {
    try {
      const aiResults = await detectFromAi(content, fileHash);
      for (const r of aiResults) {
        const existing = merged.get(r.name);
        if (!existing || r.contextScore > existing.contextScore) {
          merged.set(r.name, { name: r.name, contextScore: r.contextScore });
        }
      }
      aiCount = merged.size - astCount - regexCount;
    } catch {
      // AI layer is optional — never block on it
    }
  }

  const durationMs = Math.round(performance.now() - startMs);

  return {
    concepts: [...merged.values()],
    sources: {
      ast: astCount,
      regex: Math.max(0, regexCount),
      ai: Math.max(0, aiCount),
      total: merged.size,
    },
    durationMs,
  };
}
