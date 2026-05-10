import type { Iq3UserState } from "@protege/types";

/**
 * Process-wide singleton for the iq3 user-state repo.
 *
 * Both `routes/iq.ts` (read path) and `ingest/iq3Hook.ts` (write path)
 * MUST read from the same repo instance. With the local JSON fallback
 * two `autoRepo()` calls produce two file-handle wrappers and the
 * read/write paths diverge silently. `index.ts` is the single
 * configuration point: `setIq3UserStateRepo(autoRepo())`.
 */
export interface Iq3UserStateRepo {
  load(userId: string): Promise<Iq3UserState | null>;
  save(state: Iq3UserState): Promise<void>;
}

let _repo: Iq3UserStateRepo | null = null;

export function setIq3UserStateRepo(repo: Iq3UserStateRepo): void {
  _repo = repo;
}

export function getIq3UserStateRepo(): Iq3UserStateRepo {
  if (!_repo) throw new Error("iq3 user-state repo not initialized");
  return _repo;
}
