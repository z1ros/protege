import * as vscode from "vscode";
import { broadcast, mountedWebviewCount } from "../chat/webviewHost.js";
import { setWakeSuspended } from "../voice/voiceCapture.js";
import type { HighlightRegion } from "../ai/tools.js";

interface Pending {
  resolve: (reason: "ended" | "error") => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, Pending>();
let nextId = 1;

// Reference counter so back-to-back teach_step calls keep the wake
// listener suspended across the whole lesson, not just one beat.
let activeSteps = 0;
let unsuspendTimer: ReturnType<typeof setTimeout> | null = null;

function enterTeachingStep(): void {
  activeSteps++;
  if (unsuspendTimer) {
    clearTimeout(unsuspendTimer);
    unsuspendTimer = null;
  }
  setWakeSuspended(true);
}

function exitTeachingStep(): void {
  activeSteps = Math.max(0, activeSteps - 1);
  if (activeSteps === 0) {
    // Grace window: if another teach_step call arrives within 700ms
    // (typical backend round-trip), stay suspended to avoid a mid-lesson
    // wake-word flicker. Also covers speaker audio decay.
    unsuspendTimer = setTimeout(() => {
      setWakeSuspended(false);
      unsuspendTimer = null;
    }, 700);
  }
}

/** Called from webviewHost when the webview posts `voice/playbackDone`
 *  with a requestId. Resolves the awaiting teach_step. */
export function resolvePlayback(requestId: string | undefined, reason: "ended" | "error"): void {
  if (!requestId) return;
  const p = pending.get(requestId);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(requestId);
  p.resolve(reason);
}

function awaitPlayback(requestId: string, timeoutMs: number): Promise<"ended" | "error" | "timeout"> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolve("timeout");
    }, timeoutMs);
    pending.set(requestId, { resolve: (r) => resolve(r), timer });
  });
}

/** Args shape for the `teach_step` tool call. Mirrors the Anthropic schema
 *  in apps/backend/src/anthropic.ts. */
export interface TeachStepArgs {
  highlight: {
    path: string;
    startLine: number;
    endLine: number;
    label?: string;
  };
  narration: string;
  pauseMsAfter?: number;
}

/** Execute one teaching beat: apply a focus highlight, play TTS narration,
 *  await playback completion, optional pause, then return a tool result so
 *  Claude can issue the next step.
 *
 *  Lazily imports highlightCode to avoid a circular dep with tools.ts. */
export async function runTeachStep(args: TeachStepArgs): Promise<string> {
  const { highlight, narration, pauseMsAfter } = args;

  if (!narration || typeof narration !== "string" || narration.trim().length === 0) {
    return "teach_step error: narration is empty";
  }

  enterTeachingStep();
  try {
    const h = highlight;
    if (h && h.path && Number.isFinite(h.startLine) && Number.isFinite(h.endLine)) {
      try {
        const { highlightCodeForTeaching } = await import("../ai/tools.js");
        await highlightCodeForTeaching([
          {
            path: h.path,
            startLine: h.startLine,
            endLine: h.endLine,
            kind: "focus",
            label: h.label,
          } as HighlightRegion,
        ]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Don't abort — still narrate. User can still learn even without
        // the visual cue.
        vscode.window.setStatusBarMessage(`Protege teach_step: highlight failed (${msg})`, 3000);
      }
    }

    if (mountedWebviewCount() === 0) {
      return "teach_step error: no Protege panel open — open the sidebar first";
    }

    const requestId = `teach-${Date.now()}-${nextId++}`;
    const awaiter = awaitPlayback(requestId, 20_000);

    broadcast({
      type: "voice/playExplain",
      text: narration.trim(),
      requestId,
    });

    const result = await awaiter;

    if (typeof pauseMsAfter === "number" && pauseMsAfter > 0) {
      await new Promise((r) => setTimeout(r, Math.min(pauseMsAfter, 1500)));
    }

    return `teach_step complete (${result}): narrated "${narration.slice(0, 60)}…"`;
  } finally {
    exitTeachingStep();
  }
}
