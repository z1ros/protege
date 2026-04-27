import * as vscode from "vscode";
import type { EchoEvent } from "@protege/types";
import { authHeaders, isSignedIn } from "../user/auth.js";
import { BACKEND_URL, currentUserIdOrNull } from "../user/protegeClient.js";

/**
 * Offline-safe event batcher. Collects EchoEvent instances in memory,
 * flushes every 2 minutes + on VS Code close. If the backend is
 * unreachable, the pending batch is re-queued into globalState so it
 * survives a restart. The queue is capped so a long offline streak
 * can't grow memory without bound.
 */

const QUEUE_KEY = "protege.echo.pendingEvents";
const FLUSH_INTERVAL_MS = 2 * 60 * 1000;
const MAX_QUEUE = 5000;
const MAX_POST_BATCH = 500;

interface BatcherHandle {
  push: (e: EchoEvent) => void;
  flush: () => Promise<void>;
  dispose: () => void;
  /** Subscribe to every pushed event (used by the commit watcher's
   *  enrichment buffer). Returns an unsubscribe fn. */
  onPush: (cb: (e: EchoEvent) => void) => () => void;
}

let instance: BatcherHandle | null = null;

export function getBatcher(): BatcherHandle | null {
  return instance;
}

/**
 * @param userId  unused; retained for source-compat with old call sites.
 *                The userId is resolved per-flush from the current GitHub
 *                session so a sign-in mid-session starts flushing the
 *                buffered events under the right identity.
 */
export function startBatcher(
  context: vscode.ExtensionContext,
  _userId: string | null,
  log: vscode.OutputChannel
): BatcherHandle {
  if (instance) return instance;

  const buffer: EchoEvent[] = [];
  // Hydrate any events persisted from a previous session.
  const persisted = context.globalState.get<EchoEvent[]>(QUEUE_KEY, []);
  if (Array.isArray(persisted) && persisted.length > 0) {
    buffer.push(...persisted);
    // Don't clear globalState yet — only remove events after a
    // successful flush.
  }

  let flushing = false;

  const trim = () => {
    // Drop oldest events if we've grown past the cap. Newer events carry
    // more behavioral signal than an hours-old keystroke batch.
    if (buffer.length > MAX_QUEUE) {
      const drop = buffer.length - MAX_QUEUE;
      buffer.splice(0, drop);
      log.appendLine(`[echo/batcher] queue over cap, dropped ${drop} oldest events`);
    }
  };

  const persist = async () => {
    try {
      await context.globalState.update(QUEUE_KEY, buffer.slice(-MAX_QUEUE));
    } catch {
      // globalState write failures are non-fatal — next tick will retry.
    }
  };

  const subscribers = new Set<(e: EchoEvent) => void>();

  const push = (e: EchoEvent) => {
    buffer.push(e);
    trim();
    for (const cb of subscribers) {
      try {
        cb(e);
      } catch {
        // Subscriber failures are isolated.
      }
    }
  };

  const onPush = (cb: (e: EchoEvent) => void) => {
    subscribers.add(cb);
    return () => subscribers.delete(cb);
  };

  const flush = async () => {
    if (flushing) return;
    if (buffer.length === 0) {
      // Nothing to flush — but make sure persisted state is empty too.
      await context.globalState.update(QUEUE_KEY, []);
      return;
    }
    // Login-first: hold events until the user has a session. The buffer
    // is already capped + persisted, so a long signed-out streak just
    // drops the oldest events at the cap, never spams 401s.
    if (!isSignedIn()) {
      await persist();
      return;
    }
    const activeUserId = currentUserIdOrNull();
    if (!activeUserId) {
      await persist();
      return;
    }
    flushing = true;
    try {
      // Drain in chunks so a single POST doesn't carry 5000 events.
      while (buffer.length > 0) {
        const chunk = buffer.slice(0, MAX_POST_BATCH);
        const res = await fetch(`${BACKEND_URL}/echo/events`, {
          method: "POST",
          headers: { ...authHeaders() },
          body: JSON.stringify({ userId: activeUserId, events: chunk }),
        });
        if (!res.ok) {
          log.appendLine(
            `[echo/batcher] flush HTTP ${res.status} — keeping ${buffer.length} events for retry`
          );
          await persist();
          return;
        }
        buffer.splice(0, chunk.length);
      }
      await context.globalState.update(QUEUE_KEY, []);
    } catch (err) {
      log.appendLine(
        `[echo/batcher] flush error (${err instanceof Error ? err.message : String(err)}) — queued for retry`
      );
      await persist();
    } finally {
      flushing = false;
    }
  };

  const timer = setInterval(() => {
    void flush();
  }, FLUSH_INTERVAL_MS);

  const dispose = () => {
    clearInterval(timer);
    // Best-effort flush on close. If it fails, globalState keeps the
    // buffer for the next activation.
    void persist();
    void flush();
  };

  context.subscriptions.push({ dispose });

  instance = { push, flush, dispose, onPush };
  return instance;
}

export function disposeBatcher(): void {
  if (instance) {
    instance.dispose();
    instance = null;
  }
}
