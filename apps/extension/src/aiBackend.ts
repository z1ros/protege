import * as vscode from "vscode";
import { generateLocal, isOnDeviceReady } from "./onDeviceModel.js";
import { runSingleQuery } from "./chatRunner.js";

/**
 * AI Backend Selector — routes queries to the right model.
 *
 * The user chooses their preferred backend in the Live tab:
 *   - "on-device" → Qwen 1.5B via llama.cpp (free, instant, offline)
 *   - "haiku"     → Claude Haiku 4.5 via API (fast, cheap, cloud)
 *   - "sonnet"    → Claude Sonnet 4.5 via API (best quality, cloud)
 *   - "auto"      → on-device if ready, fall back to haiku
 *
 * All JARVIS features call `aiQuery()` instead of directly calling
 * Claude or the local model. This single function handles the routing.
 *
 * Persistence uses `context.globalState` — `localStorage` does NOT exist
 * in VS Code's Node extension host, so the previous impl silently lost
 * the user's choice on every reload.
 */

export type AiBackend = "on-device" | "haiku" | "sonnet" | "auto";
export type ActualBackend = "on-device" | "haiku" | "sonnet";

const STATE_KEY = "protege.aiBackend";

let currentBackend: AiBackend = "auto";
let ctx: vscode.ExtensionContext | null = null;

/** Track of the last actually-executed query so the UI can prove
 *  which backend ran (not just which was selected). `fallback: true`
 *  means the user wanted on-device but we routed to cloud because the
 *  local model wasn't ready / errored — this must be surfaced, never
 *  hidden. */
export interface LastCallInfo {
  backend: ActualBackend;
  atMs: number;
  durationMs: number;
  ok: boolean;
  /** Set when the user's selected backend couldn't run so we fell back. */
  fallback?: { requested: AiBackend; reason: string };
}
let lastCall: LastCallInfo | null = null;
const callListeners: Array<(info: LastCallInfo) => void> = [];

/** Must be invoked once during `activate(context)`. Loads the saved
 *  backend choice from globalState so it survives reloads. If the user's
 *  saved choice is `on-device` or `auto`, kick off model initialization
 *  in the background — otherwise `isOnDeviceReady()` stays false on every
 *  reload and every `aiQuery` silently falls through to Claude.
 *
 *  Also pulls the cross-device preference from Supabase (if configured)
 *  and picks the newer of the two. globalState wins when present to avoid
 *  the network round-trip dictating the first render; cloud wins on a
 *  fresh install / new machine where globalState is empty. */
export function initAiBackend(context: vscode.ExtensionContext): void {
  ctx = context;
  const saved = context.globalState.get<AiBackend>(STATE_KEY);
  if (saved === "on-device" || saved === "haiku" || saved === "sonnet" || saved === "auto") {
    currentBackend = saved;
  }

  // Cloud hydration — fire-and-forget. If the user has a preference saved
  // in Supabase from another machine and no local globalState, adopt it
  // and push the update to any mounted webview so the Live tab reflects
  // the authoritative value immediately.
  //
  // Race we explicitly defend against: the network round-trip is ~200-600ms.
  // If the user clicks a backend in the Live tab during that window, their
  // choice lands in globalState before cloud responds. We MUST NOT clobber
  // that — we re-read globalState right before applying, not the `saved`
  // captured at init time (which is a closure over the pre-click value).
  void (async () => {
    try {
      const { fetchPreferences, getUserId } = await import("./protegeClient.js");
      const prefs = await fetchPreferences(getUserId(context));
      const cloud = prefs.aiBackend;
      if (
        cloud !== "on-device" &&
        cloud !== "haiku" &&
        cloud !== "sonnet" &&
        cloud !== "auto"
      ) {
        return;
      }

      // Re-read — not the captured `saved`. If the user picked in the
      // meantime, globalState now has their choice. Don't clobber it.
      const freshLocal = context.globalState.get<AiBackend>(STATE_KEY);
      if (freshLocal) return;

      if (cloud === currentBackend) return; // already matches, nothing to do
      currentBackend = cloud;
      await context.globalState.update(STATE_KEY, cloud);
      console.log(`[protege] aiBackend hydrated from cloud: ${cloud}`);
      // Push the new value to any mounted webview (webviewHost is lazy-
      // imported to avoid a circular module dep during activation).
      try {
        const { broadcast } = await import("./webviewHost.js");
        broadcast({ type: "ai/backend", backend: cloud });
      } catch {
        /* webview module not ready yet — next panel render will read it */
      }
    } catch (err) {
      // Network is not required — local preference keeps working.
      console.warn("[protege] aiBackend cloud hydration failed:", err);
    }
  })();

  // Pre-warm the on-device model if the user's preference needs it.
  // The model file (~1.1 GB) was downloaded via `ai/downloadModel` once;
  // subsequent sessions just load from disk (~2-3s warm-up).
  if (currentBackend === "on-device" || currentBackend === "auto") {
    void (async () => {
      try {
        const { initOnDeviceModel } = await import("./onDeviceModel.js");
        console.log(`[protege] Pre-warming on-device model for saved backend=${currentBackend}`);
        await initOnDeviceModel(context.extensionPath);
      } catch (err) {
        console.error("[protege] Pre-warm failed:", err);
      }
    })();
  }
}

export function setAiBackend(backend: AiBackend): void {
  currentBackend = backend;
  if (ctx) {
    // Local persistence — authoritative for this machine, survives reloads.
    void ctx.globalState.update(STATE_KEY, backend);

    // Cloud sync — fire-and-forget. Makes the choice follow the user to
    // any other machine they sign into with the same account. If the
    // backend isn't reachable / Supabase isn't configured, this no-ops.
    void (async () => {
      try {
        const { patchPreferences, getUserId } = await import("./protegeClient.js");
        await patchPreferences(getUserId(ctx!), { aiBackend: backend });
      } catch (err) {
        console.warn("[protege] aiBackend cloud sync failed:", err);
      }
    })();
  }

  // Broadcast to ALL mounted webviews so the sidebar + any editor-tab panel
  // stay in sync. Without this, picking in one pane leaves the other pane
  // stuck on the previous value until reload.
  void (async () => {
    try {
      const { broadcast } = await import("./webviewHost.js");
      broadcast({ type: "ai/backend", backend });
    } catch {
      /* webview module not loaded yet — safe to ignore */
    }
  })();
}

export function getAiBackend(): AiBackend {
  return currentBackend;
}

export function getLastCall(): LastCallInfo | null {
  return lastCall;
}

export function onBackendCall(cb: (info: LastCallInfo) => void): () => void {
  callListeners.push(cb);
  return () => {
    const i = callListeners.indexOf(cb);
    if (i >= 0) callListeners.splice(i, 1);
  };
}

function recordCall(info: LastCallInfo): void {
  lastCall = info;
  for (const cb of callListeners) {
    try { cb(info); } catch {}
  }
}

/**
 * Send a query to the AI — routed based on user preference.
 *
 * @param prompt — the prompt to send
 * @param maxTokens — max response length (only used for on-device)
 * @returns the response text, or null if all backends failed
 */
export async function aiQuery(
  prompt: string,
  maxTokens = 256
): Promise<string | null> {
  const backend = currentBackend;
  let fallback: { requested: AiBackend; reason: string } | undefined;

  // On-device path
  if (backend === "on-device" || backend === "auto") {
    if (isOnDeviceReady()) {
      const start = Date.now();
      const result = await generateLocal(prompt, maxTokens);
      const duration = Date.now() - start;
      if (result) {
        recordCall({
          backend: "on-device",
          atMs: Date.now(),
          durationMs: duration,
          ok: true,
        });
        console.log(`[protege] aiQuery → on-device (Qwen) · ${duration}ms`);
        return result;
      }
      // On-device errored. For strict "on-device", fail visibly — do NOT
      // silently become a Claude call. For "auto", record the fallback.
      if (backend === "on-device") {
        recordCall({
          backend: "on-device",
          atMs: Date.now(),
          durationMs: duration,
          ok: false,
          fallback: { requested: "on-device", reason: "local generation failed" },
        });
        console.warn("[protege] aiQuery → on-device errored; not falling back because backend=on-device");
        return null;
      }
      fallback = { requested: "auto", reason: "local generation failed" };
    } else if (backend === "on-device") {
      // Strict on-device: user said no cloud — respect that. Record a
      // failure so the chip turns red and the user sees that nothing ran.
      const reason = "on-device model not ready (open Live tab to download/load)";
      console.warn(`[protege] aiQuery → ${reason}`);
      recordCall({
        backend: "on-device",
        atMs: Date.now(),
        durationMs: 0,
        ok: false,
        fallback: { requested: "on-device", reason },
      });
      return null;
    } else {
      // "auto" + not ready → mark as fallback to cloud
      fallback = { requested: "auto", reason: "on-device not ready" };
    }
  }

  // Cloud path — when explicit "haiku"/"sonnet" or "auto" fallback
  const cloudBackend: ActualBackend = backend === "sonnet" ? "sonnet" : "haiku";
  const start = Date.now();
  try {
    const result = await runSingleQuery(prompt);
    const duration = Date.now() - start;
    recordCall({
      backend: cloudBackend,
      atMs: Date.now(),
      durationMs: duration,
      ok: true,
      fallback,
    });
    console.log(
      `[protege] aiQuery → ${cloudBackend} (Claude) · ${duration}ms${
        fallback ? ` · fallback from ${fallback.requested} (${fallback.reason})` : ""
      }`
    );
    return result;
  } catch (err) {
    const duration = Date.now() - start;
    recordCall({
      backend: cloudBackend,
      atMs: Date.now(),
      durationMs: duration,
      ok: false,
      fallback,
    });
    console.error("[protege] Cloud AI query failed:", err);
    return null;
  }
}

/**
 * Get the name of the backend that would handle the next query.
 * Useful for showing "Powered by: Qwen 1.5B" or "Powered by: Haiku" in UI.
 */
export function getActiveBackendName(): string {
  if (currentBackend === "on-device") return "Qwen 1.5B (on-device)";
  if (currentBackend === "haiku") return "Claude Haiku 4.5";
  if (currentBackend === "sonnet") return "Claude Sonnet 4.5";
  // auto
  if (isOnDeviceReady()) return "Qwen 1.5B (on-device)";
  return "Claude Haiku 4.5 (fallback)";
}
