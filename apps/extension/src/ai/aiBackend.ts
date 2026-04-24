import * as vscode from "vscode";
import { generateLocal, isOnDeviceReady } from "./onDeviceModel.js";
import { runSingleQuery } from "../chat/chatRunner.js";

/**
 * AI Backend Selector — routes queries to the right model.
 *
 * The user chooses their preferred backend in the Live tab:
 *   - "on-device" → Qwen2.5-Coder 7B via llama.cpp (free, offline, ~5-10s/scan)
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
    // TEMP: Sonnet is hidden from the UI; if someone had it persisted
    // from before, transparently flip them to Haiku so the picker
    // doesn't end up with a phantom "no option selected" state.
    currentBackend = saved === "sonnet" ? "haiku" : saved;
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
      const { fetchPreferences, getUserId } = await import("../user/protegeClient.js");
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
        const { broadcast } = await import("../chat/webviewHost.js");
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
        await initOnDeviceModel(context.globalStorageUri.fsPath);
      } catch (err) {
        console.error("[protege] Pre-warm failed:", err);
      }
    })();
  }
}

export function setAiBackend(backend: AiBackend): void {
  const previous = currentBackend;
  currentBackend = backend;

  // Invalidate the "LAST CALL" chip on backend change. Otherwise an
  // in-flight scan from the previous backend can complete *after* the
  // user switches, leaving the UI claiming "you're on On-Device but the
  // last call was Sonnet" — which looks like the routing is broken when
  // it actually isn't. Clearing here means the chip just disappears
  // until the next call fires on the NEW backend, which is always
  // honest: "here's what just ran."
  if (previous !== backend) {
    lastCall = null;
    void (async () => {
      try {
        const { broadcast } = await import("../chat/webviewHost.js");
        broadcast({ type: "ai/lastCallCleared" });
      } catch {
        /* noop */
      }
    })();
  }

  if (ctx) {
    // Local persistence — authoritative for this machine, survives reloads.
    void ctx.globalState.update(STATE_KEY, backend);

    // Cloud sync — fire-and-forget. Makes the choice follow the user to
    // any other machine they sign into with the same account. If the
    // backend isn't reachable / Supabase isn't configured, this no-ops.
    void (async () => {
      try {
        const { patchPreferences, getUserId } = await import("../user/protegeClient.js");
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
      const { broadcast } = await import("../chat/webviewHost.js");
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
 * Kind of AI call — lets the router choose the right backend based on
 * whether this is a high-frequency automatic scan or a user-triggered
 * teach/chat call.
 *
 *   "scan"  → every 3s debounce while typing / on save / on idle.
 *             Happens thousands of times a day per user. MUST stay cheap.
 *             In "auto" mode these use on-device only; if Qwen isn't
 *             loaded the scan skips silently (better than surprise
 *             $30/user/month Haiku bills).
 *
 *   "teach" → user-triggered (hover Explain, thread Teach/Ask, chat,
 *             voice follow-up). ~10-50/day/user. Quality matters, latency
 *             is acceptable, cost is bounded. In "auto" mode these always
 *             go to Haiku.
 */
export type AiIntent = "scan" | "teach";

/**
 * Send a query to the AI — routed based on user preference AND intent.
 *
 * @param prompt — the prompt to send
 * @param maxTokens — max response length (only used for on-device)
 * @param opts.kind — "scan" (cheap, local-first) or "teach" (quality, cloud)
 * @returns the response text, or null if no backend could handle it
 */
export async function aiQuery(
  prompt: string,
  maxTokens = 256,
  opts: { kind?: AiIntent } = {}
): Promise<string | null> {
  const backend = currentBackend;
  const kind: AiIntent = opts.kind ?? "scan";
  let fallback: { requested: AiBackend; reason: string } | undefined;

  // ---- Smart mix ("auto") ----
  // This is where the Haiku + on-device hybrid lives. Call kind decides
  // the route so the economics work out:
  //   auto + scan  → on-device (skip if unavailable — no cloud fallback)
  //   auto + teach → Haiku (always cloud; on-device is too slow / too
  //                  inconsistent for teaching prose)
  if (backend === "auto") {
    if (kind === "scan") {
      if (!isOnDeviceReady()) {
        // Silent skip — the user installed "auto" for the margin, not
        // for surprise cloud bills on every keystroke. The Live tab will
        // show the download prompt; once Qwen is ready, scans resume.
        recordCall({
          backend: "on-device",
          atMs: Date.now(),
          durationMs: 0,
          ok: false,
          fallback: { requested: "auto", reason: "on-device not ready · scan skipped" },
        });
        console.log("[protege] aiQuery(scan) → skipped · on-device not ready, refusing Haiku fallback on scan path");
        return null;
      }
      const start = Date.now();
      const result = await generateLocal(prompt, maxTokens);
      const duration = Date.now() - start;
      recordCall({
        backend: "on-device",
        atMs: Date.now(),
        durationMs: duration,
        ok: !!result,
      });
      console.log(`[protege] aiQuery(scan) → on-device · ${duration}ms`);
      return result;
    }
    // kind === "teach" → fall through to Haiku path below
    fallback = undefined;
  }

  // ---- On-device (explicit) ----
  // When the user picked "on-device" strict, both scan AND teach run
  // locally — even for teach, which will be slower and rougher than
  // Haiku. That's the user's explicit choice.
  if (backend === "on-device") {
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
        console.log(`[protege] aiQuery(${kind}) → on-device (Qwen) · ${duration}ms`);
        return result;
      }
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
  }

  // ---- Cloud path ----
  // Reached when: backend is explicit "haiku" / "sonnet" / user picked
  // "auto" + kind=="teach". Always goes to Claude via /chat.
  // TEMP: Sonnet is disabled — all cloud calls go to Haiku regardless of
  // user pick. Easy revert: change `"haiku"` back to
  // `backend === "sonnet" ? "sonnet" : "haiku"`.
  const cloudBackend: ActualBackend = "haiku";
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
      `[protege] aiQuery(${kind}) → ${cloudBackend} (Claude) · ${duration}ms${
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
 * Useful for showing "Powered by: Qwen 7B" or "Powered by: Haiku" in UI.
 */
export function getActiveBackendName(): string {
  if (currentBackend === "on-device") return "Qwen 7B (on-device)";
  // TEMP: Sonnet folded into Haiku for the moment. If the user has
  // "sonnet" persisted from before, we still report Haiku — that's
  // what they're actually getting.
  if (currentBackend === "haiku" || currentBackend === "sonnet") {
    return "Claude Haiku 4.5";
  }
  // auto
  if (isOnDeviceReady()) return "Qwen 7B (on-device)";
  return "Claude Haiku 4.5 (fallback)";
}
