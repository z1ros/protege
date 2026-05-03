import * as vscode from "vscode";
import { setWakeSuspended } from "../voice/voiceCapture.js";
import { getVoiceGender } from "../voice/voiceStatusBar.js";
import { isWakeWordListening } from "../voice/voiceCapture.js";
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

/** True while at least one teach_step call is in flight (audio playing,
 *  TTS fetching, or pause-after timer running). hostAudio reads this so
 *  the post-audio chip flip can keep the status bar on "thinking" between
 *  steps in a lesson chain instead of bouncing through "idle" — which
 *  the user perceived as the chip lying about the bot's state. */
export function isTeachingStepActive(): boolean {
  return activeSteps > 0;
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

/** Args shape for the `teach_step` tool call. Schema FLATTENED 2026-05-01
 *  to match what Haiku 4.5 reliably produces — the model was mangling
 *  the previous nested `highlight` object. Backward-compat: still
 *  accepts the old nested form if a future model emits it. */
export interface TeachStepArgs {
  /** Flat fields (preferred — matches current schema in anthropic.ts). */
  path?: string;
  startLine?: number;
  endLine?: number;
  anchor?: string;
  label?: string;
  narration: string;
  pauseMsAfter?: number;
  /** Legacy nested shape — rare but accepted for safety. */
  highlight?: {
    path?: string;
    startLine?: number;
    endLine?: number;
    anchor?: string;
    label?: string;
  };
}

/** Execute one teaching beat: apply a focus highlight, play TTS narration,
 *  await playback completion, optional pause, then return a tool result so
 *  Claude can issue the next step.
 *
 *  Lazily imports highlightCode to avoid a circular dep with tools.ts. */
export async function runTeachStep(args: TeachStepArgs): Promise<string> {
  const { narration, pauseMsAfter } = args;

  if (!narration || typeof narration !== "string" || narration.trim().length === 0) {
    return "teach_step error: narration is empty (required string field)";
  }

  // Resolve highlight fields from either the flat shape (preferred) or
  // the legacy nested `highlight` object. Flat wins if both present.
  const highlight = {
    path: args.path ?? args.highlight?.path,
    startLine: args.startLine ?? args.highlight?.startLine,
    endLine: args.endLine ?? args.highlight?.endLine,
    anchor: args.anchor ?? args.highlight?.anchor,
    label: args.label ?? args.highlight?.label,
  };

  enterTeachingStep();
  try {
    const h = highlight;
    if (h.path && Number.isFinite(h.startLine) && Number.isFinite(h.endLine)) {
      try {
        const { highlightCodeForTeaching } = await import("../ai/tools.js");
        await highlightCodeForTeaching([
          {
            path: h.path,
            startLine: h.startLine,
            endLine: h.endLine,
            anchor: h.anchor,
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

    // Zero-UI mode (2026-04-30): teach_step works without a mounted
    // sidebar. Audio plays host-side via afplay/aplay/powershell, the
    // status-bar chip is the visual signal, the highlight goes
    // straight into the editor. The old "no Protege panel open" error
    // was a leftover from when audio routed through a webview <audio>
    // element. Removed so chained teach_step walkthroughs work even
    // with the sidebar closed.

    // Chip state ("speaking") is owned by hostAudio.ts now — it flips
    // unconditionally on actual playback start. The previous pre-flip
    // here was defensive against a 50ms afplay spawn lag, but with
    // hostAudio's centralized chip control it's redundant and would
    // mask the real "no audio yet" state if TTS fetch errored.
    const tBroadcast = Date.now();
    console.log(
      `[protege] teach_step PLAY narrationChars=${narration.trim().length} preview=${JSON.stringify(narration.trim().slice(0, 80))} wakeOn=${isWakeWordListening()}`
    );

    // Host-side audio (2026-04-30) — see voice/hostAudio.ts. Replaces
    // the broadcast → webview → audio.play() chain that was blocked by
    // Chromium autoplay policy. Plays via OS native player (afplay,
    // powershell, aplay), no autoplay constraint.
    // Streaming TTS — splits narration into sentences and starts
    // playing the first one as soon as its TTS lands. For multi-
    // sentence narrations this halves perceived latency.
    const { playHostAudioStreaming } = await import("../voice/hostAudio.js");
    const result = await playHostAudioStreaming({
      text: narration.trim(),
      voice: getVoiceGender(),
    });
    const elapsed = Date.now() - tBroadcast;
    console.log(
      `[protege] teach_step RESOLVED reason=${result} elapsedMs=${elapsed}`
    );
    // Chip restoration ("idle"|"off") is owned by hostAudio.ts —
    // playHostAudioStreaming's cleanup flips it back when audio ends.
    // Removed the duplicate post-flip here (relied on stale wasWakeOn).

    if (typeof pauseMsAfter === "number" && pauseMsAfter > 0) {
      await new Promise((r) => setTimeout(r, Math.min(pauseMsAfter, 1500)));
    }

    return `teach_step complete (${result}): narrated "${narration.slice(0, 60)}…"`;
  } finally {
    exitTeachingStep();
  }
}
