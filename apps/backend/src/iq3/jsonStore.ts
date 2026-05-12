import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Per-file serialized read-modify-write helper for the iq3 local-JSON
 * fallback stores (`feedback`, `selfRating`, `persistence.localJsonRepo`).
 *
 * Without serialization, two concurrent `save` calls observed the same
 * pre-state, mutated their own copies, and the second `writeFileSync`
 * silently overwrote the first — losing data and (worse) sometimes
 * corrupting the file when one writer was mid-flush.
 *
 * A single in-process Promise queue per path is enough because the dev
 * fallback is only ever exercised in single-process dev mode. Production
 * uses Supabase.
 */
const queues = new Map<string, Promise<void>>();

export function withJsonStoreLock<T>(
  path: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const prev = queues.get(path) ?? Promise.resolve();
  const next = (async () => {
    try {
      await prev;
    } catch {
      /* prior caller's error is its own concern */
    }
    return fn();
  })();
  queues.set(
    path,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

/** Append one record to a JSON-array file under the queue lock. Creates
 *  the file (and parent dirs) on first write. */
export function appendJsonRecord<T>(path: string, record: T): Promise<void> {
  return withJsonStoreLock(path, () => {
    const arr = existsSync(path)
      ? (JSON.parse(readFileSync(path, "utf-8")) as T[])
      : [];
    arr.push(record);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(arr, null, 2));
  });
}

/** Upsert by key into a JSON-object file under the queue lock. */
export function upsertJsonRecord<T>(
  path: string,
  key: string,
  value: T,
): Promise<void> {
  return withJsonStoreLock(path, () => {
    const map = existsSync(path)
      ? (JSON.parse(readFileSync(path, "utf-8")) as Record<string, T>)
      : {};
    map[key] = value;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(map, null, 2));
  });
}
