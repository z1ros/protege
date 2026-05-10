import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Iq3FieldId, Iq3FieldVector } from "@protege/types";
import { FIELD_IDS } from "@protege/types";

interface FieldTagsFile {
  version: number;
  generated: string;
  tags: Record<string, Iq3FieldId[]>;
}

const EMPTY_TAGS: FieldTagsFile = { version: 0, generated: "", tags: {} };

let cache: FieldTagsFile | null = null;
let loadFailed = false;

function loadTags(): FieldTagsFile {
  if (cache) return cache;
  if (loadFailed) return EMPTY_TAGS;
  // Path resolution: backend reads the file shipped with the extension
  // webview. In dev/tests, vitest runs with cwd=apps/backend, so the
  // relative path reaches the extension's webview folder. When invoked
  // from the workspace root, the alternate path catches it.
  //
  // In production deploys (Railway, etc.) the working dir won't be
  // `apps/backend` and the extension folder won't be a sibling. Try a
  // few candidate paths; if none resolve, log once and fall back to an
  // empty tag map. With empty tags, every concept resolves to
  // ["generalist"] — `fieldVectorFromConceptCounts` still returns a
  // valid vector (heavily generalist-weighted) so the route doesn't
  // 500.
  const cwd = process.cwd();
  const candidates = [
    resolve(cwd, "../extension/webview/skills-taxonomy.field-tags.json"),
    resolve(cwd, "apps/extension/webview/skills-taxonomy.field-tags.json"),
    resolve(cwd, "skills-taxonomy.field-tags.json"),
    resolve(cwd, "data/skills-taxonomy.field-tags.json"),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      cache = JSON.parse(readFileSync(path, "utf-8"));
      return cache!;
    } catch (err) {
      console.warn(
        `[iq3] taxonomy: parse failed at ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  console.warn(
    `[iq3] taxonomy: no skills-taxonomy.field-tags.json found in any of: ${candidates.join(
      ", ",
    )} (cwd=${cwd}). Falling back to empty tag map — every concept will resolve to "generalist".`,
  );
  loadFailed = true;
  return EMPTY_TAGS;
}

/** Return the field tags for a concept ID; default ["generalist"]. */
export function fieldsForConcept(conceptId: string): Iq3FieldId[] {
  const tags = loadTags().tags;
  return tags[conceptId] ?? ["generalist"];
}

/** Build a field vector by tallying field tags across concept counts. */
export function fieldVectorFromConceptCounts(
  counts: Record<string, number>,
): Iq3FieldVector {
  const raw = Object.fromEntries(FIELD_IDS.map((f) => [f, 1])) as Record<Iq3FieldId, number>;
  for (const [concept, count] of Object.entries(counts)) {
    const fields = fieldsForConcept(concept);
    const share = count / fields.length;
    for (const f of fields) raw[f] += share;
  }
  const total = Object.values(raw).reduce((s, x) => s + x, 0);
  return Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [k, v / total]),
  ) as Iq3FieldVector;
}

/** Cache reset (test helper). Also clears the `loadFailed` flag so a
 *  test that swaps in a fresh fixture path can retry the load. */
export function _resetTagsCache() {
  cache = null;
  loadFailed = false;
}
