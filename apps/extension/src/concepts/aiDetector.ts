import { generateLocal } from "../ai/onDeviceModel.js";

/**
 * AI-based concept detection — uses the on-device model (Qwen2.5-Coder)
 * to detect high-level concepts that AST analysis can't catch:
 *
 *   - Design patterns (Observer, Factory, Singleton, Strategy)
 *   - Architecture patterns (MVC, Clean Architecture, Repository)
 *   - Code quality patterns (DRY, SOLID principles in action)
 *   - Framework-specific idioms (Next.js App Router, Redux patterns)
 *   - Soft skills (proper naming, documentation, modular structure)
 *
 * Falls back to Claude (via backend) if on-device model isn't available.
 * Runs AFTER AST detection, only for concepts the AST didn't catch.
 *
 * IMPORTANT: This is debounced + cached. We don't call AI on every save.
 * Only when the file hash changes AND the file is >20 lines (skip tiny files).
 */

export interface AiDetectedConcept {
  name: string;
  confidence: number; // 0..1
  contextScore: number; // 1.0–3.0
  reasoning: string; // one-line explanation
}

const DETECTION_PROMPT = `You are a code intelligence system. Analyze this code and detect which advanced programming concepts, patterns, and practices are demonstrated.

For each concept you detect, output ONE LINE in this exact format:
CONCEPT: <name> | CONFIDENCE: <0.0-1.0> | SCORE: <1.0-3.0> | REASON: <one sentence>

Score guide:
- 1.0 = basic usage
- 2.0 = intermediate (typed, error-handled, well-structured)
- 3.0 = expert (composing multiple patterns, tested, production-quality)

Detect ONLY concepts you're confident about (confidence > 0.6). Focus on:
- Design patterns (Observer, Factory, Singleton, Strategy, Adapter, Decorator)
- Architecture (MVC, Clean Architecture, Repository, Service Layer, Dependency Injection)
- SOLID principles (Single Responsibility, Open/Closed, Liskov, Interface Segregation, Dependency Inversion)
- Code quality (DRY, proper error handling, defensive programming, immutability)
- Testing patterns (Arrange-Act-Assert, Given-When-Then, mock/stub/spy usage)
- Framework idioms specific to the code's framework
- Performance patterns (memoization, lazy loading, caching, debouncing)

Code to analyze:
\`\`\`
{{CODE}}
\`\`\`

Output ONLY the CONCEPT lines, nothing else. If no advanced concepts are found, output: NONE`;

const cache = new Map<string, { result: AiDetectedConcept[]; ts: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

/**
 * Run AI detection on a code file. Uses on-device model first,
 * falls back to returning empty (Claude is too expensive for every save).
 *
 * @param content File content (will be truncated to 3000 chars)
 * @param fileHash Content hash for caching
 * @param minLines Skip files shorter than this (default 20)
 */
export async function detectFromAi(
  content: string,
  fileHash: string,
  minLines = 20
): Promise<AiDetectedConcept[]> {
  // Skip tiny files
  if (content.split("\n").length < minLines) return [];

  // Check cache
  const cached = cache.get(fileHash);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.result;
  }

  // Truncate for model context
  const truncated = content.slice(0, 3000);
  const prompt = DETECTION_PROMPT.replace("{{CODE}}", truncated);

  try {
    // Try on-device model first (free, fast, private)
    const response = await generateLocal(prompt, 512);
    if (response) {
      const result = parseDetectionResponse(response);
      cache.set(fileHash, { result, ts: Date.now() });
      return result;
    }
  } catch {
    // On-device model not available or failed — skip silently
  }

  // No fallback to Claude for now — too expensive per save.
  // AI detection is a bonus layer, not a requirement.
  return [];
}

function parseDetectionResponse(response: string): AiDetectedConcept[] {
  const results: AiDetectedConcept[] = [];

  if (response.trim() === "NONE") return [];

  for (const line of response.split("\n")) {
    const match = line.match(
      /CONCEPT:\s*(.+?)\s*\|\s*CONFIDENCE:\s*([\d.]+)\s*\|\s*SCORE:\s*([\d.]+)\s*\|\s*REASON:\s*(.+)/i
    );
    if (!match) continue;

    const name = match[1].trim();
    const confidence = parseFloat(match[2]);
    const contextScore = parseFloat(match[3]);
    const reasoning = match[4].trim();

    if (confidence >= 0.6 && name.length > 2 && name.length < 50) {
      results.push({
        name,
        confidence: Math.min(1, confidence),
        contextScore: Math.min(3, Math.max(1, contextScore)),
        reasoning,
      });
    }
  }

  return results;
}

/** Clear the detection cache (called when on-device model loads/changes) */
export function clearAiDetectionCache(): void {
  cache.clear();
}
