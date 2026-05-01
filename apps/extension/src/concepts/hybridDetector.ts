import { detectFromAst } from "./astDetector.js";
import { detectConceptsWithContext, type DetectedConcept } from "./detector.js";

/**
 * Hybrid concept detection — two layers:
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
 * Layer 3 (on-device AI concept detection) was retired 2026-05-01 along
 * with the rest of the on-device LLM path.
 */

export interface HybridDetectionResult {
  /** All detected concepts with their best scores */
  concepts: DetectedConcept[];
  /** Breakdown of where each detection came from */
  sources: {
    ast: number;     // concepts found by AST
    regex: number;   // concepts found by regex (not already in AST)
    ai: number;      // always 0 since on-device retired; field kept for telemetry shape
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
 * @param _fileHash Content hash (unused since on-device AI retired)
 * @param _enableAi Vestigial; on-device AI retired
 */
export async function detectHybrid(
  content: string,
  filePath: string,
  languageId: string,
  _fileHash: string,
  _enableAi = false
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

  const durationMs = Math.round(performance.now() - startMs);

  return {
    concepts: [...merged.values()],
    sources: {
      ast: astCount,
      regex: Math.max(0, regexCount),
      ai: 0,
      total: merged.size,
    },
    durationMs,
  };
}
