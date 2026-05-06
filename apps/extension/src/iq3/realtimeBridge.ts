import * as vscode from "vscode";
import type { Iq3Headline } from "@protege/types";
import { BACKEND_URL, currentUserIdOrNull } from "../user/protegeClient.js";
import { authHeaders } from "../user/auth.js";

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
}

export function startIq3Bridge(_ctx: vscode.ExtensionContext): BridgeHandle {
  const subs = new Set<(h: Iq3Headline) => void>();

  async function fetchHeadline(): Promise<Iq3Headline | null> {
    const userId = currentUserIdOrNull();
    if (!userId) return null;
    try {
      const res = await fetch(
        `${BACKEND_URL}/iq/me?userId=${encodeURIComponent(userId)}`,
        { headers: { ...authHeaders() } },
      );
      if (!res.ok) return null;
      const json = (await res.json()) as { headline?: Iq3Headline };
      return json.headline ?? null;
    } catch {
      return null;
    }
  }

  async function refresh(): Promise<void> {
    const h = await fetchHeadline();
    if (h) for (const cb of subs) cb(h);
  }

  const interval = setInterval(() => {
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
  };
}
