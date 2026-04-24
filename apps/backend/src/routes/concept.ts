import { Hono } from "hono";
import {
  ensureUser,
  getAuthorshipRatio,
  recordConcepts,
  setConceptAuthoredFlag,
  setConceptAuthorshipRatio,
  setConceptLanguage,
} from "../store.js";
import { sanitizeLanguage } from "./echo.js";

export const conceptRoute = new Hono();

/** Ratio threshold above which a concept is considered "authored" by the
 *  user in a given file. Rv5.A: shared constant — keep in one place. */
const MANUAL_AUTHORSHIP_THRESHOLD = 0.5;

interface Body {
  userId?: string;
  concepts: string[];
  contextScores?: Record<string, number>;
  filePath: string;
  fileHash: string;
  hasErrors?: boolean;
  errorCount?: number;
  language?: string | null;
}

conceptRoute.post("/", async (c) => {
  const body = (await c.req.json()) as Body;
  const userId = body.userId ?? c.req.header("x-user-id") ?? "local-dev";
  await ensureUser(userId);

  const result = await recordConcepts(userId, {
    filePath: body.filePath,
    fileHash: body.fileHash,
    concepts: body.concepts ?? [],
    contextScores: body.contextScores ?? {},
    hasErrors: !!body.hasErrors,
    errorCount: body.errorCount ?? 0,
  });

  // R1: stamp the file's current authorship ratio onto every ConceptState
  // row we just touched. Even on a "skipped" save (same hash as before) we
  // refresh the ratio so a subsequent AI-accept batch followed by no-op
  // save still nudges the concept's bucket. Cheap: one read + up to N
  // in-place writes.
  if (body.filePath && (body.concepts?.length ?? 0) > 0) {
    try {
      const language = sanitizeLanguage(body.language);
      const ratio = await getAuthorshipRatio(userId, body.filePath);
      const authoredAt = new Date().toISOString();
      const crossesThreshold =
        ratio !== null && ratio >= MANUAL_AUTHORSHIP_THRESHOLD;
      for (const name of body.concepts) {
        await setConceptAuthorshipRatio(userId, name, ratio);
        if (language) {
          await setConceptLanguage(userId, name, language);
        }
        if (crossesThreshold) {
          // Monotonic — setConceptAuthoredFlag is a no-op once true.
          await setConceptAuthoredFlag(userId, name, authoredAt);
        }
      }
    } catch (err) {
      console.warn("[protege] authorship stamp failed:", err);
    }
  }

  return c.json({
    ok: true,
    skipped: result.skipped,
    received: body.concepts?.length ?? 0,
    codeIq: result.codeIq,
    totalConcepts: result.totalConcepts,
    gains: result.gains,
  });
});
