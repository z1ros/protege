import { openai } from "./openai.js";

const EMBEDDING_MODEL =
  process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small";

/** Cosine similarity for two equal-length unit-or-arbitrary vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / Math.sqrt(normA * normB);
}

/** Embed a single text. Returns null on failure or empty input so callers
 *  can fall back to non-semantic scoring without crashing the whole route. */
export async function embed(text: string): Promise<number[] | null> {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (!process.env.OPENAI_API_KEY) return null;
  try {
    const res = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: trimmed.slice(0, 8000),
    });
    return res.data[0]?.embedding ?? null;
  } catch (err) {
    console.warn("[embeddings] embed failed:", (err as Error).message);
    return null;
  }
}

/** Batch variant — single API call, lower per-item cost. Order preserved. */
export async function embedMany(
  texts: string[]
): Promise<(number[] | null)[]> {
  const inputs = texts.map((t) => t.trim()).filter((t) => t.length > 0);
  if (inputs.length === 0) return texts.map(() => null);
  if (!process.env.OPENAI_API_KEY) return texts.map(() => null);
  try {
    const res = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: inputs.map((t) => t.slice(0, 8000)),
    });
    const out: (number[] | null)[] = [];
    let idx = 0;
    for (const raw of texts) {
      if (!raw.trim()) {
        out.push(null);
      } else {
        out.push(res.data[idx]?.embedding ?? null);
        idx++;
      }
    }
    return out;
  } catch (err) {
    console.warn("[embeddings] embedMany failed:", (err as Error).message);
    return texts.map(() => null);
  }
}
