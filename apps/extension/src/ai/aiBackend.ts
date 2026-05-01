import * as vscode from "vscode";
import type { ChatTier } from "@protege/types";
import { generateLocal, isOnDeviceReady, isOnDeviceRemovedByUser } from "./onDeviceModel.js";
import { runSingleQuery } from "../chat/chatRunner.js";

/**
 * AI Backend Selector — routes queries to the right model.
 *
 * The user chooses their preferred backend in the Live tab:
 *   - "on-device" → Qwen2.5-Coder 7B via llama.cpp (free, offline, ~5-10s/scan)
 *   - "cloud"     → backend dispatches to the configured provider (OpenAI
 *                   gpt-4o-mini class for scan, gpt-4.1 for teach by
 *                   default; pluggable via env)
 *   - "auto"      → on-device if ready, fall back to cloud
 *
 * All JARVIS features call `aiQuery()` instead of directly calling
 * the cloud or the local model. This single function handles the routing.
 *
 * Persistence uses `context.globalState`. Legacy persisted values
 * "haiku" and "sonnet" (from when this extension defaulted to
 * Anthropic) are migrated to "cloud" on load — see initAiBackend.
 */

export type AiBackend = "on-device" | "cloud" | "auto";
export type ActualBackend = "on-device" | "cloud";

const STATE_KEY = "protege.aiBackend";

/**
 * Per-hour budget for AUTO-FIRED cloud calls (kind === "scan" reaching
 * the cloud path because the user picked an explicit cloud backend
 * "cloud"). User-triggered teach calls (chat, ⌘K P, learning mode,
 * voice Explain) bypass this cap entirely.
 *
 * Configurable via the `protege.autoBudgetPerHour` setting. Default 30 ≈
 * one auto-fire every 2 minutes — plenty for the hint surface to feel
 * alive, hard ceiling on bills. Set to 0 to disable auto-fired cloud
 * calls entirely.
 */
const AUTO_BUDGET_DEFAULT = 30;
const AUTO_BUDGET_WINDOW_MS = 60 * 60_000;
let autoBudgetWindowStart = Date.now();
let autoBudgetSpent = 0;

function getAutoBudgetPerHour(): number {
  const raw = vscode.workspace
    .getConfiguration("protege")
    .get<number>("autoBudgetPerHour", AUTO_BUDGET_DEFAULT);
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    return AUTO_BUDGET_DEFAULT;
  }
  return Math.floor(raw);
}

function consumeAutoBudget(): { ok: boolean; cap: number; spent: number } {
  const cap = getAutoBudgetPerHour();
  const now = Date.now();
  if (now - autoBudgetWindowStart >= AUTO_BUDGET_WINDOW_MS) {
    autoBudgetWindowStart = now;
    autoBudgetSpent = 0;
  }
  if (autoBudgetSpent >= cap) return { ok: false, cap, spent: autoBudgetSpent };
  autoBudgetSpent++;
  return { ok: true, cap, spent: autoBudgetSpent };
}

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
  /** Optional caller tag for cost analysis (e.g. "liveReview.healthTimer",
   *  "vibeBrief", "patternSpotter"). Backwards-compatible — older record
   *  sites omit it and dashboards treat as "uncategorized". */
  feature?: string;
  /** Optional outcome label for the call. For LLM scans this is typically
   *  "llm-scan"; for render-only refreshes triggered through the same
   *  recordCall pipeline (e.g. Live Review V2 timer) this is "render-only".
   *  Lets us prove cost reduction in production without inferring intent. */
  outcome?: "llm-scan" | "render-only" | "cache-hit" | "static-fallback" | "error";
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
  // Read as raw string and migrate. The persisted value may be the new
  // canonical "cloud" or one of the legacy aliases ("haiku" / "sonnet")
  // from when this extension defaulted to Anthropic. Any of those is
  // treated as the same thing — "use the cloud backend, let it route."
  const raw = context.globalState.get<string>(STATE_KEY);
  if (raw === "on-device" || raw === "auto") {
    currentBackend = raw;
  } else if (raw === "cloud" || raw === "haiku" || raw === "sonnet") {
    currentBackend = "cloud";
    if (raw !== "cloud") {
      // Persist the migrated value so the legacy alias only triggers
      // this branch once. Saves a tiny bit of confusion on next load.
      void context.globalState.update(STATE_KEY, "cloud");
    }
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
      const rawCloud = prefs.aiBackend;
      // Same migration as the local-load path: collapse legacy haiku/
      // sonnet aliases onto the new "cloud" value before adopting.
      const cloud: AiBackend | null =
        rawCloud === "on-device" || rawCloud === "auto"
          ? rawCloud
          : rawCloud === "cloud" || rawCloud === "haiku" || rawCloud === "sonnet"
            ? "cloud"
            : null;
      if (!cloud) return;

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

  // On-device pre-warm retired 2026-05-01 — scan path no longer uses
  // Qwen, so auto-loading 4.5GB into RAM at activation was waste even
  // for users with backend="auto" or "on-device" persisted from older
  // sessions. The on-device infrastructure (initOnDeviceModel,
  // onDeviceModel.ts) is still on disk and gets loaded explicitly when:
  //   - user runs `Protege: Download On-Device Model` command, or
  //   - user clicks the on-device toggle in the Live tab UI (fires an
  //     `ai/downloadModel` message that calls initOnDeviceModel)
  // No automatic load on activation. Pure cloud out of the box.
  void (async () => {
    const { log } = await import("../log.js");
    log(
      "aiBackend",
      `[ON-DEVICE] pre-warm SKIPPED · cloud-only by default · 'Protege: Download On-Device Model' command available for opt-in`
    );
  })();
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

    // Switching TO on-device or auto must also kick the model load if it
    // isn't already ready / loading. The Live-tab picker handles this
    // separately via an `ai/downloadModel` message, but other callsites
    // (the `protege.toggleMaxPlanBackend` command, programmatic flips)
    // would otherwise leave on-device unloaded — the next scan would
    // hit `isOnDeviceReady() === false` and silently return null with
    // no findings. Folding the trigger in here covers every caller.
    if (
      previous !== backend &&
      (backend === "on-device" || backend === "auto")
    ) {
      void (async () => {
        try {
          const { log } = await import("../log.js");
          const { initOnDeviceModel, isOnDeviceReady, isOnDeviceLoading } =
            await import("./onDeviceModel.js");
          if (isOnDeviceReady()) {
            log("aiBackend", `[ON-DEVICE] setAiBackend(${backend}) · already ready · skipping load`);
            return;
          }
          if (isOnDeviceLoading()) {
            log("aiBackend", `[ON-DEVICE] setAiBackend(${backend}) · already loading · skipping`);
            return;
          }
          log("aiBackend", `[ON-DEVICE] setAiBackend(${backend}) → kicking on-device model load`);
          await initOnDeviceModel(ctx!.globalStorageUri.fsPath);
        } catch (err) {
          const { log } = await import("../log.js");
          log("aiBackend", `[ON-DEVICE] setAiBackend init THREW · ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
    }
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
  opts: { kind?: AiIntent; tier?: ChatTier; forceBackend?: AiBackend } = {}
): Promise<string | null> {
  // `forceBackend` overrides the user's saved pick for this single call.
  // Used by the hybrid Live Review orchestrator: phase-1 forces on-device,
  // phase-2 forces cloud. Doesn't touch persisted state — just the
  // routing of this one call. Safe under the live-review single-flight
  // guard (isScanning); no concurrent inversions.
  const backend = opts.forceBackend ?? currentBackend;
  const kind: AiIntent = opts.kind ?? "scan";
  // Default tier follows kind: auto-fired scans get the cheap model
  // (gpt-4.1-mini / Haiku), user-triggered teach calls get the premium
  // model (gpt-4.1 / Sonnet-when-enabled). Callers can override.
  const tier: ChatTier =
    opts.tier ?? (kind === "scan" ? "cheap" : "premium");
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
        // Two distinct cases when on-device isn't ready:
        //
        //   A) User REMOVED the model via the Live tab button (or
        //      `protege.removeOnDeviceModel` palette command). They
        //      explicitly opted out of on-device — fall back to cloud
        //      so 24/7 Live Review keeps working. They reclaimed disk
        //      space; we trust the budget cap to prevent runaway cost.
        //
        //   B) Model is loading / not yet downloaded for first time —
        //      silent skip. User installed "auto" for the margin, not
        //      for surprise cloud bills on every keystroke. Once Qwen
        //      finishes loading, scans resume.
        //
        // Distinguished via isOnDeviceRemovedByUser() — sticky flag set
        // when the user removes the model, cleared on fresh download.
        if (isOnDeviceRemovedByUser()) {
          fallback = {
            requested: "auto",
            reason: "on-device removed by user · routing scan to cloud",
          };
          // Fall through to the cloud path below — runs the same code
          // as a "cloud" backend selection, with the fallback marker
          // set so the Live tab "Last call" chip turns AMBER and shows
          // the reason. Keeps user fully informed about what just ran.
        } else {
          recordCall({
            backend: "on-device",
            atMs: Date.now(),
            durationMs: 0,
            ok: false,
            fallback: { requested: "auto", reason: "on-device not ready · scan skipped" },
          });
          void (async () => {
            const { log } = await import("../log.js");
            log(
              "aiBackend",
              `[QWEN] aiQuery(scan) SKIPPED · on-device model not ready (loading? not downloaded?) · refusing cloud fallback on auto+scan path`
            );
          })();
          return null;
        }
      } else {
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
    }
    // kind === "teach" → fall through to Haiku path below.
    // (Or kind === "scan" + user-removed: fallback already set above,
    //  same Haiku path below honors it.)
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
    void (async () => {
      const { log } = await import("../log.js");
      log("aiBackend", `[QWEN] aiQuery SKIPPED · ${reason}`);
    })();
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
  // Reached when: backend is explicit "cloud" / user picked "auto" +
  // kind=="teach". Always goes to the configured cloud provider via
  // the backend's /chat route — the backend decides between OpenAI,
  // Anthropic, etc. based on env. The extension just labels the call
  // "cloud" for cost / observability.
  const cloudBackend: ActualBackend = "cloud";

  // Budget gate: cap auto-fired cloud calls (kind === "scan") at the
  // user-configured `protege.autoBudgetPerHour`. User-triggered "teach"
  // calls bypass — those are explicit user actions and shouldn't be
  // silently dropped.
  if (kind === "scan") {
    const budget = consumeAutoBudget();
    if (!budget.ok) {
      recordCall({
        backend: cloudBackend,
        atMs: Date.now(),
        durationMs: 0,
        ok: false,
        fallback: {
          requested: backend,
          reason: `auto-fire budget exhausted (${budget.cap}/h)`,
        },
      });
      console.log(
        `[protege] aiQuery(scan) → skipped · auto-fire budget exhausted (${budget.spent}/${budget.cap} this hour)`
      );
      return null;
    }
  }

  // Caller-trace diagnostic: capture the first stack frame outside of
  // aiBackend.ts so the backend log line tells us WHICH feature fired
  // this LLM call. Without this the only signal in /chat logs is "tier
  // and tools-off shape" which matches ~10 callers — useless for
  // pinpointing a regression. `new Error().stack` is cheap (~µs) and
  // Node's V8 already collects it on construction. We slice past the
  // aiBackend frames to find the caller.
  const callerTrace = (() => {
    const stack = new Error().stack ?? "";
    const lines = stack.split("\n").slice(1); // drop "Error" header
    for (const line of lines) {
      // Skip frames inside this file and runSingleQuery's wrapper
      if (line.includes("aiBackend") || line.includes("chatRunner")) continue;
      // Trim to "    at fnName (file:line:col)" → "fnName · file:line"
      const m = line.match(/at (\S+) \(.*?([^/\\]+:\d+):\d+\)/) ??
                line.match(/at .*?([^/\\]+:\d+):\d+/);
      if (m) return m.length === 3 ? `${m[1]} · ${m[2]}` : m[1];
      return line.trim();
    }
    return "unknown caller";
  })();
  const promptPreview = prompt.slice(0, 60).replace(/\s+/g, " ");
  console.log(
    `[protege] aiQuery FIRE · ${kind}/${tier} · caller=${callerTrace} · prompt="${promptPreview}…"`
  );

  const start = Date.now();
  try {
    const result = await runSingleQuery(prompt, { tier });
    const duration = Date.now() - start;
    recordCall({
      backend: cloudBackend,
      atMs: Date.now(),
      durationMs: duration,
      ok: true,
      fallback,
    });
    console.log(
      `[protege] aiQuery(${kind}, ${tier}) → ${cloudBackend} (Claude) · ${duration}ms · caller=${callerTrace}${
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
    console.log(
      `[protege] aiQuery FAIL · ${kind}/${tier} · caller=${callerTrace} · ${err instanceof Error ? err.message : String(err)}`
    );
    console.error("[protege] Cloud AI query failed:", err);
    return null;
  }
}

/**
 * Get the name of the backend that would handle the next query.
 * Useful for showing "Powered by: …" in UI. The actual cloud model is
 * decided by the backend env (OPENAI_CHEAP_MODEL / OPENAI_PREMIUM_MODEL
 * / ANTHROPIC_*); the extension only labels it "cloud" generically.
 */
export function getActiveBackendName(): string {
  if (currentBackend === "on-device") return "Qwen 7B (on-device)";
  if (currentBackend === "cloud") return "Cloud (provider configured server-side)";
  // auto
  if (isOnDeviceReady()) return "Qwen 7B (on-device)";
  return "Cloud (fallback)";
}
