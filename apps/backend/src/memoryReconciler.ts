import { anthropic } from "./anthropic.js";
import { embed } from "./embeddings.js";
import {
  addMemory,
  applyMemoryUpdate,
  findSimilarMemories,
  removeMemory,
  type MemoryRow,
  type MemoryType,
} from "./store.js";

const RECONCILER_MODEL =
  process.env.ANTHROPIC_HAIKU_MODEL ?? "claude-haiku-4-5";

export type ReconcileAction = "ADD" | "UPDATE" | "DELETE" | "NOOP";

export interface ReconcileDecision {
  action: ReconcileAction;
  /** UPDATE: id of existing row to overwrite. DELETE: id to remove. */
  targetId?: string;
  /** UPDATE/ADD: the merged content. */
  content?: string;
  /** Free-text rationale (logged, not user-visible). */
  reason?: string;
}

export interface ReconcileResult {
  decision: ReconcileDecision;
  row: MemoryRow | null;
}

const SYSTEM = `You reconcile a user's mentor-memory store. Given an INCOMING fact and the SIMILAR existing memories, output one decision as JSON only:

{"action":"ADD","content":"<text>"}                       — incoming is genuinely new
{"action":"UPDATE","targetId":"<id>","content":"<text>"}  — incoming supersedes / refines an existing memory; merge into one row
{"action":"DELETE","targetId":"<id>"}                     — incoming explicitly negates an existing memory; remove it and add nothing new
{"action":"NOOP"}                                         — incoming is a duplicate or weaker restatement; keep the store as-is

Rules:
- Pick UPDATE when the same fact has changed value (job, language, opinion). Keep the merged content terse and self-contained.
- Pick DELETE only when the incoming explicitly retracts the existing one ("I no longer use X", "scratch that").
- Pick NOOP when incoming says nothing new.
- Pick ADD when the topic is genuinely new.
- Never invent fields. JSON only, no prose.`;

function safeParse(text: string): ReconcileDecision | null {
  const trimmed = text.trim();
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]) as ReconcileDecision;
    if (
      obj.action === "ADD" ||
      obj.action === "UPDATE" ||
      obj.action === "DELETE" ||
      obj.action === "NOOP"
    ) {
      return obj;
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** Reconcile an incoming `remember(type, content)` against the user's
 *  existing memory store. Returns the resulting row (or null when the
 *  decision was DELETE/NOOP and nothing new was written). On any failure
 *  in the LLM step, falls back to a plain ADD so memory is never lost. */
export async function reconcileAndStore(
  userId: string,
  type: MemoryType,
  content: string
): Promise<ReconcileResult> {
  const trimmed = content.trim().slice(0, 500);
  if (!trimmed) {
    return {
      decision: { action: "NOOP", reason: "empty content" },
      row: null,
    };
  }

  const incomingEmbedding = await embed(trimmed);
  if (!incomingEmbedding) {
    const row = await addMemory(userId, type, trimmed);
    return {
      decision: { action: "ADD", content: trimmed, reason: "no embedding" },
      row,
    };
  }

  const candidates = await findSimilarMemories(
    userId,
    incomingEmbedding,
    3,
    0.78
  );

  if (candidates.length === 0) {
    const row = await addMemory(userId, type, trimmed);
    return {
      decision: { action: "ADD", content: trimmed, reason: "no neighbors" },
      row,
    };
  }

  const candidateBlock = candidates
    .map(
      (c, i) =>
        `[${i + 1}] id=${c.row.id} type=${c.row.type} sim=${c.similarity.toFixed(3)}\n    ${c.row.content}`
    )
    .join("\n");

  const userMsg = `INCOMING (type=${type}): ${trimmed}\n\nSIMILAR EXISTING:\n${candidateBlock}`;

  let decision: ReconcileDecision | null = null;
  try {
    const resp = await anthropic.messages.create({
      model: RECONCILER_MODEL,
      max_tokens: 200,
      system: SYSTEM,
      messages: [{ role: "user", content: userMsg }],
    });
    const text = resp.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("\n");
    decision = safeParse(text);
  } catch (err) {
    console.warn(
      "[memoryReconciler] LLM call failed, falling back to ADD:",
      (err as Error).message
    );
  }

  if (!decision) {
    const row = await addMemory(userId, type, trimmed);
    return {
      decision: { action: "ADD", content: trimmed, reason: "parse failed" },
      row,
    };
  }

  switch (decision.action) {
    case "ADD": {
      const row = await addMemory(userId, type, decision.content ?? trimmed);
      return { decision, row };
    }
    case "UPDATE": {
      if (!decision.targetId || !decision.content) {
        const row = await addMemory(userId, type, trimmed);
        return {
          decision: { action: "ADD", content: trimmed, reason: "malformed UPDATE" },
          row,
        };
      }
      const row = await applyMemoryUpdate(
        userId,
        decision.targetId,
        decision.content
      );
      if (!row) {
        const fallback = await addMemory(userId, type, trimmed);
        return {
          decision: { action: "ADD", content: trimmed, reason: "UPDATE target missing" },
          row: fallback,
        };
      }
      return { decision, row };
    }
    case "DELETE": {
      if (decision.targetId) {
        await removeMemory(userId, decision.targetId);
      }
      return { decision, row: null };
    }
    case "NOOP":
    default:
      return { decision, row: null };
  }
}
