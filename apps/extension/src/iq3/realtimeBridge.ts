import * as vscode from "vscode";
import type { Iq3Headline } from "@protege/types";
import { BACKEND_URL, currentUserIdOrNull } from "../user/protegeClient.js";
import { authHeaders } from "../user/auth.js";
import { log } from "../log.js";

/**
 * Realtime IQ3 bridge — the host owns the polling loop, the webview consumes
 * the resulting headline via `panel.webview.postMessage({ channel:
 * "iq/headline", payload }) ` (see `chat/webviewHost.ts` `broadcast()`).
 *
 * Why host-side polling: a webview can't reach `BACKEND_URL` with the user's
 * GitHub bearer token directly — that token only lives in the extension's
 * authState cache. So the host fetches and fans the result out to every
 * mounted webview. Cheap enough at 30s that we don't bother with WebSockets
 * for Phase A.
 */
const POLL_INTERVAL_MS = 30 * 1000;

interface BridgeHandle {
  dispose: () => void;
  /** Subscribe to headline updates. Returns an unsubscribe function. */
  onHeadline: (cb: (h: Iq3Headline) => void) => () => void;
  /** Request an immediate refresh (skips the polling cadence). */
  refresh: () => Promise<void>;
  /** Last successfully-fetched headline, for replay on webview mount.
   *  `null` until the first successful poll lands. */
  getLast: () => Iq3Headline | null;
  /** Subscribe to status changes — `"ok"` after a successful poll, or a
   *  short failure tag (e.g. `"401"`, `"500"`, `"network"`, `"signed-out"`)
   *  on failure. Used by the dashboard to flip a banner without each
   *  consumer re-implementing failure detection. */
  onStatusChange: (cb: (status: BridgeStatus) => void) => () => void;
  /** Last status transition, for replay on subscriber mount. */
  getStatus: () => BridgeStatus;
}

export type BridgeStatus =
  | "idle"
  | "ok"
  | "signed-out"
  | "network"
  | "401"
  | "403"
  | "404"
  | "500"
  | "unknown-error";

export function startIq3Bridge(_ctx: vscode.ExtensionContext): BridgeHandle {
  const subs = new Set<(h: Iq3Headline) => void>();
  const statusSubs = new Set<(s: BridgeStatus) => void>();
  let lastHeadline: Iq3Headline | null = null;
  let lastStatus: BridgeStatus = "idle";
  // Suppress duplicate status logs / broadcasts. Logging every 30s when
  // backend is down is a noise generator; only log the transition.
  function setStatus(next: BridgeStatus): void {
    if (next === lastStatus) return;
    lastStatus = next;
    if (next !== "ok" && next !== "idle" && next !== "signed-out") {
      log("iq3-bridge", `status transition → ${next}`);
    }
    for (const cb of statusSubs) cb(next);
  }

  async function fetchHeadline(): Promise<Iq3Headline | null> {
    const userId = currentUserIdOrNull();
    if (!userId) {
      setStatus("signed-out");
      return null;
    }
    try {
      const res = await fetch(
        `${BACKEND_URL}/iq/me?userId=${encodeURIComponent(userId)}`,
        { headers: { ...authHeaders() } },
      );
      if (!res.ok) {
        // Map common auth/server failures to a status tag so the
        // dashboard can render an appropriate banner ("session expired",
        // "service unavailable", etc.) instead of frozen-on-loading.
        const tag: BridgeStatus =
          res.status === 401
            ? "401"
            : res.status === 403
              ? "403"
              : res.status === 404
                ? "404"
                : res.status >= 500
                  ? "500"
                  : "unknown-error";
        setStatus(tag);
        return null;
      }
      const json = (await res.json()) as { headline?: Iq3Headline };
      setStatus("ok");
      return json.headline ?? null;
    } catch (err) {
      // Network failure (fetch threw). Don't spam the same error every
      // 30s — setStatus dedupes on transition. Still capture the message
      // on the first occurrence for diagnosis.
      if (lastStatus !== "network") {
        log(
          "iq3-bridge",
          `fetch threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      setStatus("network");
      return null;
    }
  }

  async function refresh(): Promise<void> {
    const h = await fetchHeadline();
    if (h) {
      lastHeadline = h;
      for (const cb of subs) cb(h);
    }
  }

  // Only run the timer when there's a chance of success. The bridge
  // checks `currentUserIdOrNull` on each tick, so technically polling
  // when signed-out is harmless — but it produces noisy 401s in any
  // future logging path and consumes auth-verifier capacity for nothing.
  // Skip the interval until sign-in lands; an external caller can also
  // force a fresh fetch via `refresh()`.
  const interval = setInterval(() => {
    if (!currentUserIdOrNull()) {
      setStatus("signed-out");
      return;
    }
    void refresh();
  }, POLL_INTERVAL_MS);

  // Fire once on startup. If the user isn't signed in yet `fetchHeadline`
  // returns null and no subscribers see anything — the next poll picks it
  // up after sign-in lands.
  void refresh();

  return {
    dispose: () => clearInterval(interval),
    onHeadline: (cb) => {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
    refresh,
    getLast: () => lastHeadline,
    onStatusChange: (cb) => {
      statusSubs.add(cb);
      // Replay current status so the subscriber doesn't have to wait for
      // the next transition to render its banner state.
      cb(lastStatus);
      return () => {
        statusSubs.delete(cb);
      };
    },
    getStatus: () => lastStatus,
  };
}
