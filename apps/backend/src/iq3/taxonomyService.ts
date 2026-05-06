import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Iq3FieldId, Iq3FieldVector } from "@protege/types";
import { FIELD_IDS } from "@protege/types";

interface FieldTagsFile {
  version: number;
  generated: string;
  tags: Record<string, Iq3FieldId[]>;
}

let cache: FieldTagsFile | null = null;

function loadTags(): FieldTagsFile {
  if (cache) return cache;
  // Path resolution: backend reads the file shipped with the extension
  // webview. In dev/tests, vitest runs with cwd=apps/backend, so the
  // relative path reaches the extension's webview folder. When invoked
  // from the workspace root (rare), fall back to the workspace path.
  // In production, ship a server copy via a build step (TODO once
  // deploy pipeline is formalized — Phase A keeps it simple).
  const cwd = process.cwd();
  const path = cwd.endsWith("backend")
    ? resolve(cwd, "../extension/webview/skills-taxonomy.field-tags.json")
    : resolve(cwd, "apps/extension/webview/skills-taxonomy.field-tags.json");
  cache = JSON.parse(readFileSync(path, "utf-8"));
  return cache!;
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

/** Cache reset (test helper). */
export function _resetTagsCache() {
  cache = null;
}
