import type { RepoConceptIndexRow } from "../../../src/store.js";
import type { Rng } from "../random.js";
import { CONCEPTS_BY_LANGUAGE, LANGUAGES } from "../fixtures.js";

const DAY_MS = 24 * 60 * 60 * 1000;

interface Options {
  userId: string;
  workspaceRoot: string;
  nowMs: number;
  rng: Rng;
}

/**
 * ~60 RepoConceptIndex rows across the 3 seeded languages. Many will
 * overlap with user-authored concepts in `conceptStates` — those are the
 * "known" rows in W17 once `conceptStatuses` is cross-referenced — while a
 * handful remain purely repo-side (concepts in the workspace the user
 * hasn't touched).
 */
export function generateRepoConceptIndex(
  opts: Options
): RepoConceptIndexRow[] {
  const { userId, workspaceRoot, nowMs, rng } = opts;
  const rows: RepoConceptIndexRow[] = [];

  for (const lang of LANGUAGES) {
    const names = CONCEPTS_BY_LANGUAGE[lang];
    // Take the whole pool — 10-12 per lang × 3 = ~30-36 — and round up by
    // inventing lang-specific tail concepts to reach ~60 total.
    for (const name of names) {
      rows.push({
        userId,
        workspaceRoot,
        concept: name,
        language: lang,
        fileCount: rng.int(1, 12),
        firstSeenAt: new Date(nowMs - rng.int(7, 30) * DAY_MS).toISOString(),
        lastSeenAt: new Date(nowMs - rng.int(0, 6) * DAY_MS).toISOString(),
      });
    }
  }

  // Pad to ~60 by inventing a few unique "codebase-only" concepts.
  const extraTail = [
    { concept: "Zod schema", language: "typescript" as const },
    { concept: "RxJS observable", language: "typescript" as const },
    { concept: "Redux reducer", language: "typescript" as const },
    { concept: "React.memo", language: "typescript" as const },
    { concept: "tRPC router", language: "typescript" as const },
    { concept: "Suspense boundary", language: "typescript" as const },
    { concept: "Fragment", language: "typescript" as const },
    { concept: "ErrorBoundary", language: "typescript" as const },
    { concept: "pytest fixture", language: "python" as const },
    { concept: "FastAPI router", language: "python" as const },
    { concept: "SQLAlchemy Session", language: "python" as const },
    { concept: "pydantic BaseModel", language: "python" as const },
    { concept: "ABC metaclass", language: "python" as const },
    { concept: "Arc<T>", language: "rust" as const },
    { concept: "thiserror derive", language: "rust" as const },
    { concept: "serde::Serialize", language: "rust" as const },
    { concept: "PyO3 binding", language: "rust" as const },
    { concept: "Cow<str>", language: "rust" as const },
    { concept: "async-trait", language: "rust" as const },
    { concept: "tokio::spawn", language: "rust" as const },
    { concept: "Mutex<T>", language: "rust" as const },
    { concept: "From<T> impl", language: "rust" as const },
    { concept: "Vec::drain", language: "rust" as const },
    { concept: "tower::Service", language: "rust" as const },
    { concept: "axum handler", language: "rust" as const },
    { concept: "bincode encode", language: "rust" as const },
    { concept: "dyn Trait", language: "rust" as const },
    { concept: "Cell<T>", language: "rust" as const },
    { concept: "RefCell<T>", language: "rust" as const },
    { concept: "Rc<T>", language: "rust" as const },
  ];
  for (const item of extraTail) {
    if (rows.length >= 60) break;
    rows.push({
      userId,
      workspaceRoot,
      concept: item.concept,
      language: item.language,
      fileCount: rng.int(1, 6),
      firstSeenAt: new Date(nowMs - rng.int(7, 30) * DAY_MS).toISOString(),
      lastSeenAt: new Date(nowMs - rng.int(0, 6) * DAY_MS).toISOString(),
    });
  }

  return rows.slice(0, 60);
}
