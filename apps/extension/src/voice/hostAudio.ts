import * as vscode from "vscode";
import { spawn, type ChildProcess } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authHeaders } from "../user/auth.js";
import { BACKEND_URL } from "../user/protegeClient.js";
import {
  setBargeInCallback,
  triggerFollowUp,
  setWakeSuspended,
  isWakeWordListening,
} from "./voiceCapture.js";
import { setVoiceState } from "./voiceStatusBar.js";

/**
 * Host-side audio playback — bypasses the webview entirely.
 *
 * Why it exists: Chromium's autoplay policy blocks `audio.play()` inside
 * a webview until the user has performed an activation gesture in that
 * specific document. Wake-word firing in a Node.js child process doesn't
 * count, so the in-webview path silently failed for users who hadn't
 * clicked anywhere in the Protege panel. Endless workarounds (banner,
 * unlock-on-click, replay-on-unlock) couldn't paper over the underlying
 * constraint.
 *
 * The fix: pull the TTS audio host-side and spawn the OS audio player
 * (afplay on macOS, powershell on Windows, aplay on Linux). The OS has
 * no autoplay restriction. Audio plays whether the user has interacted
 * with the panel or not.
 *
 * State management: this module owns voice/speaking transitions for the
 * playback it drives. It calls `setVoiceState` directly and resolves
 * teach_step awaiters when playback ends — no round trip through the
 * webview required.
 */

let currentProcess: ChildProcess | null = null;
let currentTempPath: string | null = null;
let playbackGen = 0;

interface PlayOptions {
  text: string;
  voice: "female" | "male";
  /** When set, `resolvePlayback(requestId, reason)` is called on
   *  end/error so teach_step's awaiter resumes. */
  requestId?: string;
}

interface PlaybackHooks {
  onStart?: () => void;
  onEnd?: (reason: "ended" | "error") => void;
  /** Fires when the user interrupts mid-playback (sustained voice during
   *  wake-suspension). Caller should clear its own state — strict-mode
   *  flag, pending follow-up mode, etc. Audio kill, chip flip, and the
   *  follow-up mic re-arm are handled centrally inside armBargeIn.
   *  When this fires, `onEnd` is NOT called for the same playback. */
  onBargeIn?: () => void;
}

function pickPlayer(): { cmd: string; argsFor: (path: string) => string[] } | null {
  switch (process.platform) {
    case "darwin":
      return { cmd: "afplay", argsFor: (p) => [p] };
    case "win32":
      return {
        cmd: "powershell",
        argsFor: (p) => [
          "-NoProfile",
          "-Command",
          `(New-Object Media.SoundPlayer '${p.replace(/'/g, "''")}').PlaySync();`,
        ],
      };
    case "linux":
      // Try aplay; users without alsa can install or override later.
      return { cmd: "aplay", argsFor: (p) => [p] };
    default:
      return null;
  }
}

/** Stop the currently-playing clip (if any) so the new one isn't drowned
 *  out. Mirrors the audio-element behavior of replacing src + restarting. */
export function stopHostAudio(): void {
  playbackGen += 1;
  if (currentProcess) {
    try {
      currentProcess.kill("SIGTERM");
    } catch {}
    currentProcess = null;
  }
  if (currentTempPath) {
    void unlink(currentTempPath).catch(() => {});
    currentTempPath = null;
  }
  // Any pending barge-in arming is moot once playback has been
  // killed — the binary's prob stream will keep spiking but there's
  // nothing to interrupt.
  setBargeInCallback(null);
}

/** Arm barge-in for the lifetime of an in-flight playback. The wake
 *  binary's prob stream is watched while we have wake suspended; if
 *  user voice rises above the threshold, the callback:
 *    1. Kills afplay immediately (silence).
 *    2. Flips the bottom-bar chip off "speaking" so the UI matches reality.
 *    3. Runs the caller's onBargeIn hook (caller cleans up its own state).
 *    4. Un-suspends wake so the binary delivers events normally again.
 *    5. Opens the mic (FOLLOW_UP) so the user's interruption is recorded
 *       as the start of a new turn — no need to say "Protege".
 *
 *  Returns a `fired()` checker so the surrounding playback path can tell
 *  whether the natural-end cleanup or the barge-in path resolved this
 *  playback. Used to skip onEnd (caller's onBargeIn already ran). */
function armBargeIn(onBargeIn?: () => void): { fired: () => boolean } {
  let fired = false;
  if (!isWakeWordListening()) return { fired: () => false };
  setBargeInCallback(() => {
    fired = true;
    console.log("[protege] barge-in firing — stopping audio + opening mic");
    stopHostAudio();
    // Flip the chip immediately so we don't leave it on "speaking" while
    // the new recording's events propagate (they take ~50–100ms).
    setVoiceState(isWakeWordListening() ? "idle" : "off");
    try {
      onBargeIn?.();
    } catch (err) {
      console.warn(
        `[protege] barge-in: onBargeIn hook threw: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    setWakeSuspended(false);
    const ok = triggerFollowUp();
    if (!ok) {
      console.warn(
        "[protege] barge-in: triggerFollowUp returned false — wake binary not in a re-armable state"
      );
    }
  });
  return { fired: () => fired };
}

export function isHostAudioPlaying(): boolean {
  return currentProcess !== null;
}

/**
 * Fetch a TTS clip and play it through the OS audio player.
 *
 * Returns a promise that resolves when playback ends (or fails). State
 * transitions for the bottom-bar chip and wake suspension are handled
 * inside.
 */
export async function playHostAudio(
  opts: PlayOptions,
  hooks: PlaybackHooks = {}
): Promise<"ended" | "error"> {
  const player = pickPlayer();
  if (!player) {
    console.warn(
      `[protege] host audio: unsupported platform "${process.platform}" — no player available`
    );
    hooks.onEnd?.("error");
    return "error";
  }

  // Cancel any in-flight clip so the new one starts immediately.
  stopHostAudio();
  const myGen = ++playbackGen;
  const isCurrent = () => myGen === playbackGen;

  // 1. Fetch the WAV bytes.
  let wav: Buffer;
  try {
    const res = await fetch(`${BACKEND_URL}/tts`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeaders(),
      },
      body: JSON.stringify({ text: opts.text, voice: opts.voice }),
    });
    if (!isCurrent()) return "error";
    if (!res.ok) {
      console.warn(`[protege] host audio: /tts ${res.status} ${res.statusText}`);
      hooks.onEnd?.("error");
      return "error";
    }
    const buf = await res.arrayBuffer();
    if (!isCurrent()) return "error";
    if (buf.byteLength === 0) {
      hooks.onEnd?.("error");
      return "error";
    }
    wav = Buffer.from(buf);
  } catch (err) {
    console.warn(
      `[protege] host audio: fetch failed: ${err instanceof Error ? err.message : String(err)}`
    );
    hooks.onEnd?.("error");
    return "error";
  }

  // 2. Write to a temp file.
  const tempPath = join(tmpdir(), `protege-tts-${Date.now()}-${myGen}.wav`);
  try {
    await writeFile(tempPath, wav);
  } catch (err) {
    console.warn(
      `[protege] host audio: tempfile write failed: ${err instanceof Error ? err.message : String(err)}`
    );
    hooks.onEnd?.("error");
    return "error";
  }
  if (!isCurrent()) {
    void unlink(tempPath).catch(() => {});
    return "error";
  }
  currentTempPath = tempPath;

  // 3. Spawn the OS player.
  return new Promise<"ended" | "error">((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(player.cmd, player.argsFor(tempPath), {
        stdio: "ignore",
      });
    } catch (err) {
      console.warn(
        `[protege] host audio: spawn ${player.cmd} failed: ${err instanceof Error ? err.message : String(err)}`
      );
      void unlink(tempPath).catch(() => {});
      currentTempPath = null;
      hooks.onEnd?.("error");
      resolve("error");
      return;
    }
    currentProcess = child;
    // Force chip to "speaking" the instant audio starts. Was previously
    // gated on isWakeWordListening() at the call site, so text-mode TTS
    // (chat reply, teach_step without wake) never flipped the chip and
    // the user couldn't tell the bot was talking. Now the chip is the
    // single source of truth for "is audio playing right now?". Idle
    // restoration happens in cleanup below.
    setVoiceState("speaking");
    hooks.onStart?.();
    const arm = armBargeIn(hooks.onBargeIn);

    const cleanup = (reason: "ended" | "error") => {
      // Two ways `isCurrent()` can be false:
      //   1. Preempted by a NEW playback (`stopHostAudio` then a new
      //      `playHostAudio` call) — skip cleanup entirely; the new
      //      playback owns state now.
      //   2. Barge-in fired — `stopHostAudio` was called from inside
      //      armBargeIn's callback. We still need to resolve the promise
      //      so callers don't leak; but skip onEnd because onBargeIn
      //      already handled the caller's state.
      if (!isCurrent() && !arm.fired()) return;
      // Only touch the global slots if they still point at OUR resources.
      // After barge-in OR preempt, a brand-new playback may have already
      // claimed them — clobbering would kill the new playback's process
      // and leak its tempfile.
      if (currentProcess === child) currentProcess = null;
      void unlink(tempPath).catch(() => {});
      if (currentTempPath === tempPath) currentTempPath = null;
      // Clear the barge-in callback only if we're still the owner of the
      // playback that armed it. If a new playback re-armed in the gap,
      // its callback shouldn't be cleared.
      if (isCurrent()) setBargeInCallback(null);
      // Pair with the onStart "speaking" flip — restore chip to its
      // resting state. Skip if barge-in fired (it already flipped to
      // idle/off in armBargeIn) or if a new playback preempted us
      // (its own setVoiceState("speaking") owns the chip now).
      if (isCurrent() && !arm.fired()) {
        setVoiceState(isWakeWordListening() ? "idle" : "off");
      }
      if (!arm.fired()) hooks.onEnd?.(reason);
      resolve(reason);
    };

    child.on("exit", (code) => {
      cleanup(code === 0 ? "ended" : "error");
    });
    child.on("error", (err) => {
      console.warn(
        `[protege] host audio: ${player.cmd} runtime error: ${err.message}`
      );
      cleanup("error");
    });
  });
}

/* ============================================================
   Streaming variant — split text into sentences, fetch each one's
   TTS in parallel, play sequentially. Cuts perceived latency in
   half: the first sentence starts playing after one TTS round-trip
   (~500ms–1s) instead of after the full reply's TTS (which scales
   linearly with reply length).

   Pipeline:
     fetch(s1) ─┐
     fetch(s2) ─┼─ awaited in order ─→ spawn(afplay) ─ in sequence
     fetch(s3) ─┘

   By the time afplay(s1) exits, fetch(s2) is usually already done,
   so playback is continuous. Order is preserved because we await
   the fetch promises in array order.
   ============================================================ */

/** Strip markdown that the model occasionally leaks into voice replies
 *  (Haiku 4.5 ignores VOICE_MODE's "no fences" rule maybe 5–15% of the
 *  time). Without this, TTS would literally pronounce backticks and
 *  asterisks. We drop full code fences (the user can't hear code anyway —
 *  they're supposed to see it via edit_file) and unwrap inline emphasis. */
function stripMarkdownForVoice(text: string): string {
  return text
    // Remove fenced code blocks entirely — voice can't read code, the
    // user reads it visually in the editor.
    .replace(/```[\s\S]*?```/g, " ")
    // Inline backtick code → bare word ("the foo function" not "the
    // backtick foo backtick function").
    .replace(/`([^`]+)`/g, "$1")
    // Bold / italic markers → drop the markers, keep the words.
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    // Heading hashes at line start.
    .replace(/^#+\s+/gm, "")
    // Collapse the whitespace we created above.
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Hard cap on chunk length so a single TTS round-trip never holds
 *  audio playback hostage. 600 chars ≈ 43 seconds at 14 chars/sec —
 *  past that, even with barge-in, the user is staring at "speaking"
 *  for too long before they hear anything new. */
const MAX_CHUNK_CHARS = 600;

/** Split a chunk that exceeds MAX_CHUNK_CHARS into sub-chunks at the
 *  best soft boundary we can find (comma, em-dash, or whitespace).
 *  Used when sentence-level splitting wasn't enough — typically when
 *  the model emitted a paragraph with no terminal punctuation. */
function splitOversizeChunk(chunk: string): string[] {
  if (chunk.length <= MAX_CHUNK_CHARS) return [chunk];
  const out: string[] = [];
  let remaining = chunk;
  while (remaining.length > MAX_CHUNK_CHARS) {
    // Look for the latest comma/dash/space before MAX_CHUNK_CHARS, then
    // fall back to a hard cut. Try comma > em-dash > space.
    const window = remaining.slice(0, MAX_CHUNK_CHARS);
    const cutAt =
      window.lastIndexOf(", ") + 1 ||
      window.lastIndexOf(" — ") + 1 ||
      window.lastIndexOf("— ") + 1 ||
      window.lastIndexOf(" ") + 1 ||
      MAX_CHUNK_CHARS;
    out.push(remaining.slice(0, cutAt).trim());
    remaining = remaining.slice(cutAt).trim();
  }
  if (remaining.length > 0) out.push(remaining);
  return out;
}

/** Split text into sentence-shaped chunks for parallel TTS. Tries
 *  to keep chunks at ≥18 chars so we don't pay the afplay spawn
 *  overhead on tiny "Yeah." fragments. Strips markdown first and
 *  enforces a max chunk size so code-block leaks (which lack sentence
 *  punctuation) can't produce 15-second mono-chunks. */
function splitForStreaming(text: string, minChars = 18): string[] {
  const cleaned = stripMarkdownForVoice(text);
  // Split on sentence-ending punctuation followed by whitespace.
  // Lookbehind keeps the punctuation attached to the prior sentence.
  const raw = cleaned
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (raw.length === 0) return [];
  // Combine adjacent fragments smaller than minChars so we don't
  // chop off "Yeah." into its own afplay invocation.
  const out: string[] = [];
  let buf = "";
  for (const s of raw) {
    if (buf.length === 0) {
      buf = s;
      continue;
    }
    if (buf.length < minChars) {
      buf = `${buf} ${s}`;
    } else {
      out.push(buf);
      buf = s;
    }
  }
  if (buf) out.push(buf);
  // Enforce per-chunk size cap — splitOversizeChunk subdivides any
  // chunk that came in over MAX_CHUNK_CHARS (rare; only happens when
  // the model produced a paragraph with no sentence punctuation).
  return out.flatMap(splitOversizeChunk);
}

async function fetchTtsToTempFile(
  text: string,
  voice: "female" | "male",
  gen: number
): Promise<string | null> {
  try {
    const res = await fetch(`${BACKEND_URL}/tts`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeaders(),
      },
      body: JSON.stringify({ text, voice }),
    });
    if (!res.ok) {
      console.warn(`[protege] host audio (stream): /tts ${res.status}`);
      return null;
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength === 0) return null;
    const tempPath = join(
      tmpdir(),
      `protege-tts-${Date.now()}-${gen}-${Math.random().toString(36).slice(2, 7)}.wav`
    );
    await writeFile(tempPath, Buffer.from(buf));
    return tempPath;
  } catch (err) {
    console.warn(
      `[protege] host audio (stream): fetch failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

function spawnPlayerOnce(
  player: { cmd: string; argsFor: (path: string) => string[] },
  tempPath: string,
  myGen: number
): Promise<"ended" | "error"> {
  return new Promise<"ended" | "error">((resolve) => {
    const isCurrent = () => myGen === playbackGen;
    let child: ChildProcess;
    try {
      child = spawn(player.cmd, player.argsFor(tempPath), {
        stdio: "ignore",
      });
    } catch (err) {
      console.warn(
        `[protege] host audio (stream): spawn failed: ${err instanceof Error ? err.message : String(err)}`
      );
      void unlink(tempPath).catch(() => {});
      resolve("error");
      return;
    }
    if (!isCurrent()) {
      try {
        child.kill("SIGTERM");
      } catch {}
      void unlink(tempPath).catch(() => {});
      resolve("error");
      return;
    }
    currentProcess = child;
    currentTempPath = tempPath;

    const cleanup = (reason: "ended" | "error") => {
      // Same ownership guard as single-shot: don't clobber a new
      // playback that grabbed these slots after we were preempted.
      if (currentProcess === child) currentProcess = null;
      void unlink(tempPath).catch(() => {});
      if (currentTempPath === tempPath) currentTempPath = null;
      resolve(reason);
    };
    child.on("exit", (code) => cleanup(code === 0 ? "ended" : "error"));
    child.on("error", () => cleanup("error"));
  });
}

/**
 * Streaming version of playHostAudio. Splits the text into sentences,
 * fetches all TTS in parallel, plays them sequentially as each one
 * arrives. First audio starts after a single TTS round-trip instead
 * of waiting for the full reply.
 */
export async function playHostAudioStreaming(
  opts: PlayOptions,
  hooks: PlaybackHooks = {}
): Promise<"ended" | "error"> {
  const player = pickPlayer();
  if (!player) {
    console.warn(
      `[protege] host audio: unsupported platform "${process.platform}"`
    );
    hooks.onEnd?.("error");
    return "error";
  }

  const chunks = splitForStreaming(opts.text);
  if (chunks.length === 0) {
    hooks.onEnd?.("error");
    return "error";
  }

  // One-chunk shortcut — falls back to the simple non-streaming path
  // (no benefit from the parallel pipeline when there's nothing to
  // parallelize).
  if (chunks.length === 1) {
    return playHostAudio(opts, hooks);
  }

  stopHostAudio();
  const myGen = ++playbackGen;
  const isCurrent = () => myGen === playbackGen;

  // Kick ALL fetches off in parallel. They resolve out of order, but
  // we await them in index order in the play loop below — so playback
  // is sequential while fetches are concurrent.
  const fetchPromises = chunks.map((chunk) =>
    fetchTtsToTempFile(chunk, opts.voice, myGen)
  );

  let startedFlag = false;
  let arm: { fired: () => boolean } = { fired: () => false };
  let finalReason: "ended" | "error" = "ended";

  for (let i = 0; i < chunks.length; i++) {
    if (!isCurrent()) {
      finalReason = "error";
      break;
    }
    const tempPath = await fetchPromises[i];
    if (!isCurrent()) {
      if (tempPath) void unlink(tempPath).catch(() => {});
      finalReason = "error";
      break;
    }
    if (!tempPath) {
      // This chunk's TTS failed; skip it and continue with the next.
      finalReason = "error";
      continue;
    }
    if (!startedFlag) {
      startedFlag = true;
      // Force chip to "speaking" the moment the first chunk starts —
      // single source of truth for "audio is playing right now". See
      // the matching call in playHostAudio() for the rationale.
      setVoiceState("speaking");
      hooks.onStart?.();
      arm = armBargeIn(hooks.onBargeIn);
    }
    const r = await spawnPlayerOnce(player, tempPath, myGen);
    if (r === "error") finalReason = "error";
    // If barge-in fired mid-playback, stopHostAudio bumped playbackGen
    // and `isCurrent()` is false now — exit the loop early so we don't
    // play the remaining sentences over the user's voice.
    if (!isCurrent()) {
      finalReason = "ended";
      break;
    }
  }
  // Clear any unfired barge-in arming once the loop drains — but only
  // if we still own the current playback. A new playback that started
  // after us would have armed its own callback; clobbering would
  // disable barge-in for it.
  if (isCurrent()) setBargeInCallback(null);

  // Drain any still-pending fetches we aborted out of so their temp
  // files don't leak. Best-effort.
  if (!isCurrent()) {
    for (const p of fetchPromises) {
      void p.then((path) => {
        if (path) void unlink(path).catch(() => {});
      });
    }
  }

  // Pair with the onStart "speaking" flip — restore the chip to its
  // resting state when streaming finishes. Skip when barge-in fired
  // (it already flipped the chip in armBargeIn) or when a new playback
  // preempted us (its own start flip owns the chip now).
  if (isCurrent() && !arm.fired() && startedFlag) {
    setVoiceState(isWakeWordListening() ? "idle" : "off");
  }
  // Skip onEnd when barge-in handled the turn already — onBargeIn ran
  // in its place and the caller's state is clean.
  if (!arm.fired()) hooks.onEnd?.(finalReason);
  return finalReason;
}

/** Convenience: VS Code disposable that stops any in-flight playback on
 *  extension deactivation. */
export function registerHostAudioCleanup(
  context: vscode.ExtensionContext
): void {
  context.subscriptions.push({
    dispose: () => stopHostAudio(),
  });
}
