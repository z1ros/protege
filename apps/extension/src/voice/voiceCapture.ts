import { spawn, ChildProcess } from "node:child_process";
import * as path from "node:path";
import * as vscode from "vscode";
import { BACKEND_URL } from "../user/protegeClient.js";
import { authHeaders, isSignedIn } from "../user/auth.js";
import {
  checkAssets,
  fetchVoiceAssets,
  type DownloadProgress,
} from "./fetchAssets.js";

let micProcess: ChildProcess | null = null;
let audioChunks: Buffer[] = [];
let stderrLog = "";
let stopping = false;
let onAutoStop: (() => void) | null = null;

// Wake word listener
let wakeProcess: ChildProcess | null = null;

/** Auto-restart state for the wake binary. The Rust mic process can
 *  crash mid-session ("mutex lock failed: Invalid argument" was seen
 *  in real testing 2026-05-02). Without a restart loop, every exit
 *  silently kills voice for the rest of the session. We remember the
 *  original start params so we can re-spawn, and gate the restart on
 *  whether the host explicitly asked us to stop. */
let intentionalStop = false;
let restartAttempts = 0;
const MAX_RESTART_ATTEMPTS = 3;
let savedStartArgs: {
  extensionPath: string;
  callbacks: Parameters<typeof startWakeWordListener>[1];
  thresholdOverride?: number;
} | null = null;
let lastSpawnAt = 0;
let wakeAudioChunks: Buffer[] = [];
let onWakeDetected: (() => void) | null = null;
let onWakeRecordingStopped: (() => void) | null = null;

// When the bot is speaking, we fully suspend the wake listener. No wake
// events fire, no recordings start. Prevents bot voice bleed from mic
// triggering false barge-ins. Trade: no mid-speech interrupt — user waits
// ~500ms after bot finishes. setSuspended(false) re-enables after buffer.
let suspended = false;

// Separate flag from `suspended` — set while we're actively processing
// a single user utterance (STT in flight, chat call out, etc., before
// TTS starts and `suspended` takes over). Without this, the wake binary
// can fire WAKE:detected a second time from the tail end of the user's
// own utterance — the prob stays elevated for a moment after the user
// stops talking and the binary's wake-word ONNX latches onto a similar
// pattern. Suppressing wake during this in-flight window means the
// user only ever has to say "Protege" once.
let requestInFlight = false;
export function setRequestInFlight(v: boolean): void {
  requestInFlight = v;
}

/* ============ Barge-in detection (DISABLED 2026-04-30) ============
   We tried sustained-prob detection during wake-suspension to let
   users interrupt the bot mid-sentence by speaking. It worked in
   sim but turned out to be unreliable in real-world acoustic
   environments — bot voice bleeding through speakers spikes the
   wake-word ONNX prob to 0.10–0.40, often clearing any threshold
   that's also low enough to catch a real "stop"/"wait". Tuning the
   threshold higher (0.30 → 0.45) cut some false fires but the bot
   still got randomly cut off mid-explanation. User explicitly asked
   for reliability over interrupt capability.

   The infrastructure (setBargeInCallback, prob parser, hostAudio
   armBargeIn) is preserved so we can re-enable cleanly when we have
   better detection (real VAD / echo cancellation / energy-only
   instead of wake-word-ONNX prob). For now: registering a callback
   is a no-op — bot always plays through. User can interrupt by
   waiting for end-of-reply and saying "Protege" again. */
type BargeInCallback = () => void;
let bargeInCallback: BargeInCallback | null = null;
let bargeInArmedAt = 0;
let recentProbs: number[] = [];
// Effectively disabled. Probs from the wake ONNX max out around 1.0;
// 99 means we never fire. When re-enabling, calibrated values were
// 0.30 threshold / 2 frames / 600ms warmup — but reach for a real
// VAD before going back to that.
const BARGE_PROB_THRESHOLD = 99;
const BARGE_FRAME_COUNT = 2;
const BARGE_WARMUP_MS = 600;

/** Register a one-shot callback that fires when sustained voice is
 *  detected during wake-suspension. Pass null to clear. The callback
 *  is automatically cleared after firing — caller should re-register
 *  before each TTS playback if it wants barge-in for that turn. */
export function setBargeInCallback(cb: BargeInCallback | null): void {
  bargeInCallback = cb;
  bargeInArmedAt = cb ? Date.now() : 0;
  recentProbs = [];
}

// Legacy strict-mode gate (still used for the rare moment between
// suspend release and fresh wake events). Bot voice typically fades
// within 100ms; the 500ms unsuspend buffer covers decay.
let strictMode = false;
let lastWakeAvg = 0;
const STRICT_AVG_THRESHOLD = 0.55;

export function setStrictWakeMode(v: boolean): void {
  strictMode = v;
}

export function setWakeSuspended(v: boolean): void {
  // Clear any prob-history we accumulated under the previous state so
  // a stale spike doesn't leak across the suspend↔resume boundary and
  // false-trigger barge-in the moment we re-enter suspension.
  if (suspended !== v) recentProbs = [];
  suspended = v;
}

/** Read-only getter so consumers (e.g. the status bar updater in
 *  webviewHost) can skip "listening" flips when wake is suspended —
 *  those wakes are usually echoes from the bot's own voice and
 *  shouldn't repaint the bottom chip. */
export function isWakeSuspended(): boolean {
  return suspended;
}

function pipeLog(tag: string, msg: string): void {
  console.log(`[${tag}]`, msg);
  // Fire-and-forget. Skip the network leg pre-auth — `/log` is gated
  // server-side, and we don't want to spam 401s on every wake/STT log
  // line for a signed-out user. Console line above still lands.
  if (!isSignedIn()) return;
  fetch(`${BACKEND_URL}/log`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ tag, msg }),
  }).catch(() => {});
}

function getBinaryPath(extensionPath: string): string {
  const platform = process.platform;
  const arch = process.arch;
  const ext = platform === "win32" ? ".exe" : "";
  const name = `protege-mic-${platform}-${arch}${ext}`;
  return path.join(extensionPath, "bin", name);
}

function getModelPath(extensionPath: string): string {
  return path.join(extensionPath, "models", "protege-oww.onnx");
}

/**
 * Guard for every entry point that spawns the binary. Fetches the
 * platform-specific voice-engine tarball from GitHub Releases when
 * the binary or models are missing on disk, surfacing progress via a
 * native VS Code notification.
 *
 * Returns when assets are confirmed in place. Throws when:
 *   - download fails (no network, release not uploaded yet, 404 for
 *     this platform/arch — the user's platform isn't supported)
 *   - extraction fails (no `tar` in PATH)
 *
 * Idempotent — when the assets are already present and the version
 * stamp matches, returns immediately without showing UI.
 */
let inflightInstall: Promise<void> | null = null;
async function ensureVoiceEngine(extensionPath: string): Promise<void> {
  const check = checkAssets(extensionPath);
  if (check.missing.length === 0 && check.versionMatch) return;

  // Coalesce concurrent calls so two voice-mode entry points don't both
  // kick off downloads racing into the same files.
  if (inflightInstall) return inflightInstall;

  inflightInstall = Promise.resolve(
    vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Installing Protege voice engine",
        cancellable: false,
      },
      async (report) => {
        let lastPct = 0;
        const onProgress = (p: DownloadProgress) => {
          if (p.phase === "fetching" && p.total > 0) {
            const pct = Math.round((p.loaded / p.total) * 100);
            const mb = (p.loaded / 1_048_576).toFixed(1);
            const mbTotal = (p.total / 1_048_576).toFixed(1);
            report.report({
              message: `Downloading ${mb} / ${mbTotal} MB`,
              increment: pct - lastPct,
            });
            lastPct = pct;
          } else if (p.phase === "extracting") {
            report.report({ message: "Extracting…" });
          } else if (p.phase === "installing") {
            report.report({ message: "Installing files…" });
          } else if (p.phase === "done") {
            report.report({ message: "Done", increment: 100 - lastPct });
          }
        };
        await fetchVoiceAssets(extensionPath, onProgress);
      }
    )
  ).then(() => undefined);

  try {
    await inflightInstall;
  } finally {
    inflightInstall = null;
  }

  // Final sanity check — if the fetcher claimed success but files still
  // aren't where they should be, surface a clear error rather than
  // letting a downstream spawn fail with a confusing message.
  const final = checkAssets(extensionPath);
  if (final.missing.length > 0) {
    throw new Error(
      `Voice engine install incomplete — still missing: ${final.missing.join(
        ", "
      )}`
    );
  }
}

export function isRecording(): boolean {
  return micProcess !== null;
}

export function isWakeWordListening(): boolean {
  return wakeProcess !== null;
}

/* ================================================================
   Record mode (click-to-talk with VAD auto-stop)
   ================================================================ */

export async function startRecording(extensionPath: string, autoStopCallback?: () => void): Promise<void> {
  if (micProcess) return;

  await ensureVoiceEngine(extensionPath);
  const binPath = getBinaryPath(extensionPath);

  audioChunks = [];
  stderrLog = "";
  stopping = false;
  onAutoStop = autoStopCallback ?? null;

  micProcess = spawn(binPath, [], { stdio: ["pipe", "pipe", "pipe"] });

  micProcess.stdout?.on("data", (chunk: Buffer) => {
    audioChunks.push(chunk);
  });

  micProcess.stderr?.on("data", (data: Buffer) => {
    const line = data.toString();
    stderrLog += line;
    console.warn("[protege-mic]", line);
  });

  micProcess.on("error", (err) => {
    console.error("[protege-mic] spawn error:", err);
    micProcess = null;
  });

  micProcess.on("exit", (code) => {
    if (code && code !== 0) {
      console.error(`[protege-mic] exited with code ${code}: ${stderrLog}`);
    }
    const wasRunning = micProcess !== null;
    micProcess = null;
    if (wasRunning && !stopping && onAutoStop) {
      onAutoStop();
      onAutoStop = null;
    }
  });
}

export async function stopRecording(): Promise<Buffer> {
  if (stopping) return Promise.reject(new Error("Already stopping"));
  stopping = true;

  return new Promise((resolve, reject) => {
    if (!micProcess) {
      stopping = false;
      reject(new Error("Not recording"));
      return;
    }

    const proc = micProcess;
    micProcess = null;

    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve(fixWavHeader(collectAudio()));
    }, 2000);

    proc.on("exit", () => {
      clearTimeout(timeout);
      resolve(fixWavHeader(collectAudio()));
    });

    proc.stdin?.end();
    proc.kill("SIGTERM");
  });
}

export function collectAutoStopAudio(): Buffer {
  return fixWavHeader(collectAudio());
}

/* ================================================================
   Wake word mode (always-on listener)
   ================================================================ */

export async function startWakeWordListener(
  extensionPath: string,
  callbacks: {
    onWake: () => void;
    onRecordingDone: () => void;
    onError: (err: string) => void;
    onReady?: () => void;
  },
  thresholdOverride?: number
): Promise<void> {
  if (wakeProcess) return;

  // Reset the intentional-stop flag every time the host explicitly
  // starts the listener — clears any prior "we asked it to die" state
  // so the auto-restart loop is armed.
  intentionalStop = false;
  // Remember args so the exit handler can re-spawn without the host
  // having to re-call startWakeWordListener.
  savedStartArgs = { extensionPath, callbacks, thresholdOverride };
  lastSpawnAt = Date.now();

  await ensureVoiceEngine(extensionPath);
  const binPath = getBinaryPath(extensionPath);
  const modelPath = getModelPath(extensionPath);

  wakeAudioChunks = [];
  onWakeDetected = callbacks.onWake;
  onWakeRecordingStopped = callbacks.onRecordingDone;

  const args = ["--wake-word", "--model", modelPath];
  if (typeof thresholdOverride === "number" && Number.isFinite(thresholdOverride)) {
    args.push("--threshold", thresholdOverride.toFixed(3));
  }

  wakeProcess = spawn(binPath, args, {
    stdio: ["pipe", "pipe", "pipe"],
  });

  wakeProcess.stdout?.on("data", (chunk: Buffer) => {
    wakeAudioChunks.push(chunk);
  });

  wakeProcess.stderr?.on("data", (data: Buffer) => {
    const lines = data.toString().split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      pipeLog("protege-wake", trimmed);

      // The binary prints "WAKE WORD DETECTED! avg=0.539 count=2" right
      // before the protocol signal "WAKE:detected". Parse the avg so we
      // can gate barge-in on confidence during TTS.
      const avgMatch = trimmed.match(/WAKE WORD DETECTED! avg=([\d.]+)/);
      if (avgMatch) {
        lastWakeAvg = parseFloat(avgMatch[1]);
      }

      // Barge-in: while the bot is speaking, watch the prob stream for
      // a sustained run above the voice threshold. The wake binary
      // emits "protege-mic: prob=X" continuously; background noise
      // sits at ~0.02–0.05, real voice spikes past 0.10. A run of
      // BARGE_FRAME_COUNT samples averaging above BARGE_PROB_THRESHOLD
      // is the user trying to interrupt — fire the callback (which
      // kills afplay + arms a fresh recording).
      const probMatch = trimmed.match(/protege-mic: prob=([\d.]+)/);
      if (probMatch && suspended && bargeInCallback) {
        // Warmup gate — ignore prob spikes for the first 600ms after
        // arming. Catches bot-syllable bleed and stale prob frames from
        // a recording that just stopped. Real user interruptions almost
        // always start past this window because the bot needs at least
        // a syllable to land before the user reacts.
        if (Date.now() - bargeInArmedAt < BARGE_WARMUP_MS) {
          // Still record the prob into history so the avg has data
          // ready when the warmup ends — but don't fire yet.
          recentProbs.push(parseFloat(probMatch[1]));
          if (recentProbs.length > BARGE_FRAME_COUNT) recentProbs.shift();
        } else {
          const p = parseFloat(probMatch[1]);
          recentProbs.push(p);
          if (recentProbs.length > BARGE_FRAME_COUNT) recentProbs.shift();
          if (recentProbs.length >= BARGE_FRAME_COUNT) {
            const avg =
              recentProbs.reduce((s, x) => s + x, 0) / recentProbs.length;
            if (avg > BARGE_PROB_THRESHOLD) {
              const cb = bargeInCallback;
              bargeInCallback = null; // one-shot
              recentProbs = [];
              pipeLog(
                "protege-wake",
                `barge-in detected (avg prob=${avg.toFixed(3)} over ${BARGE_FRAME_COUNT} frames during suspension) — interrupting bot`
              );
              try {
                cb();
              } catch (err) {
                console.warn(
                  `[protege] barge-in callback threw: ${err instanceof Error ? err.message : String(err)}`
                );
              }
            }
          }
        }
      }

      if (trimmed === "WAKE:ready") {
        callbacks.onReady?.();
        continue;
      }

      if (trimmed === "WAKE:detected") {
        // Loud log so the user can clearly distinguish a real wake fire
        // from the constant `protege-mic: prob=…` polling stream.
        // Without this it's easy to misread "wake fired and I didn't
        // mean it to" when actually the mic was opened by an unrelated
        // path (post-TTS follow-up, manual toggle, barge-in).
        pipeLog(
          "protege-wake",
          `🎤 WAKE FIRED · avg=${lastWakeAvg.toFixed(3)} (threshold gate passed) — opening mic`
        );
        if (suspended) {
          pipeLog("protege-wake", "wake suppressed (mic suspended during bot speech)");
          continue;
        }
        if (requestInFlight) {
          // STT/chat already running for the previous wake — ignore
          // tail-end re-fires from the user's own voice. Without this,
          // a single "Protege keep going" produced TWO wake events:
          // one on "Protege" (good) and one on the tail of the user's
          // sentence (bad — would queue a second phantom recording).
          pipeLog(
            "protege-wake",
            "wake suppressed (request already in flight from previous wake)"
          );
          continue;
        }
        if (strictMode && lastWakeAvg < STRICT_AVG_THRESHOLD) {
          pipeLog(
            "protege-wake",
            `barge-in ignored (avg=${lastWakeAvg.toFixed(3)} < ${STRICT_AVG_THRESHOLD} during speech)`
          );
          continue;
        }
        wakeAudioChunks = [];
        onWakeDetected?.();
      } else if (trimmed === "FOLLOW_UP:detected") {
        // Host-triggered post-reply listening (voice-dialogue continuity).
        // Binary has already flipped into recording mode; treat identically
        // to a real wake — same audio path, same silence auto-stop. We
        // ignore `suspended` here because FOLLOW_UP can only be sent by
        // the host AFTER it already unsuspended (post-speech decay passed).
        wakeAudioChunks = [];
        onWakeDetected?.();
      } else if (trimmed === "RECORDING:stopped") {
        // Always fire onWakeRecordingStopped so the host can resync the
        // status-bar chip (otherwise it stays stuck on "Listening" if a
        // recording stops while wake is suspended). The host's handler
        // checks isWakeSuspended() at entry and drops the audio buffer
        // — so we don't accidentally feed bot-bleed to STT — but the
        // chip update is allowed through.
        onWakeRecordingStopped?.();
      }
    }
  });

  wakeProcess.on("error", (err) => {
    pipeLog("protege-wake", `spawn error: ${err.message}`);
    wakeProcess = null;
    callbacks.onError(err.message);
  });

  wakeProcess.on("exit", (code) => {
    pipeLog("protege-wake", `exited with code ${code}`);
    const lifetimeMs = Date.now() - lastSpawnAt;
    wakeProcess = null;

    // Reset the failure counter on long-running sessions — if the
    // binary lived ≥60s before exiting, that's a new failure event,
    // not part of a tight crash loop. Without this, a few rapid
    // crashes would permanently disable voice for the session even
    // if the binary later starts working again.
    if (lifetimeMs > 60_000) {
      restartAttempts = 0;
    }

    // Don't restart when the host asked us to stop (window reload,
    // user toggled wake off via the chip, extension deactivated).
    if (intentionalStop) return;
    // Cap restart attempts so a persistently-broken binary doesn't
    // burn CPU in a respawn loop. After the cap, surface the error
    // and let the user toggle wake off/on to manually retry.
    if (restartAttempts >= MAX_RESTART_ATTEMPTS) {
      pipeLog(
        "protege-wake",
        `restart cap reached (${MAX_RESTART_ATTEMPTS} consecutive crashes) — giving up. Toggle wake off/on to retry.`
      );
      savedStartArgs?.callbacks.onError(
        `Wake binary crashed ${MAX_RESTART_ATTEMPTS}× in a row. Click the status-bar chip to retry.`
      );
      return;
    }
    if (!savedStartArgs) return;

    restartAttempts++;
    // Linear backoff: 1s, 2s, 3s. Quick enough that the user barely
    // notices a recovery, slow enough to dodge a hot crash loop.
    const delayMs = restartAttempts * 1000;
    pipeLog(
      "protege-wake",
      `auto-restart in ${delayMs}ms (attempt ${restartAttempts}/${MAX_RESTART_ATTEMPTS}) — last lifetime ${lifetimeMs}ms`
    );
    const args = savedStartArgs;
    setTimeout(() => {
      // The process may have already been re-started by the host
      // calling startWakeWordListener directly during the backoff.
      if (wakeProcess) return;
      void startWakeWordListener(
        args.extensionPath,
        args.callbacks,
        args.thresholdOverride
      );
    }, delayMs);
  });

  pipeLog("protege-wake", `listener started (bin=${binPath})`);
}

export function stopWakeWordListener(): void {
  // Tell the exit handler we asked for this — don't auto-restart.
  intentionalStop = true;
  savedStartArgs = null;
  restartAttempts = 0;
  if (!wakeProcess) return;
  wakeProcess.stdin?.end();
  wakeProcess.kill("SIGTERM");
  wakeProcess = null;
  onWakeDetected = null;
  onWakeRecordingStopped = null;
}

/** Write "FOLLOW_UP\n" to the mic binary's stdin. The binary interprets
 *  it as a synthetic wake-word trigger and enters recording mode — same
 *  audio path, same silence auto-stop. Used after a voice-dialogue reply
 *  ends to give the user ~1.4s of silence tolerance to start replying
 *  WITHOUT saying "protege" again. If they stay silent, the existing
 *  VAD timeout ends the capture and the flow returns to wake-word mode. */
export function triggerFollowUp(): boolean {
  if (!wakeProcess || !wakeProcess.stdin) return false;
  try {
    wakeProcess.stdin.write("FOLLOW_UP\n");
    return true;
  } catch {
    return false;
  }
}

export function collectWakeAudio(): Buffer {
  const wav = Buffer.concat(wakeAudioChunks);
  wakeAudioChunks = [];
  if (wav.length < 44) return wav;
  // Fix WAV header
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.writeUInt32LE(wav.length - 44, 40);
  return wav;
}

/* ================================================================
   Calibration mode — record a single utterance, score against the
   wake-word pipeline, return the peak probability. Used by the
   onboarding flow to pick a per-user threshold.
   ================================================================ */

/** Record one utterance using the binary's built-in VAD auto-stop. Returns a
 *  WAV buffer (16kHz mono 16-bit PCM). Throws if no speech is detected. */
export async function recordSingleUtterance(extensionPath: string, timeoutMs = 8000): Promise<Buffer> {
  await ensureVoiceEngine(extensionPath);
  const binPath = getBinaryPath(extensionPath);

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let errLog = "";
    const proc = spawn(binPath, [], { stdio: ["pipe", "pipe", "pipe"] });

    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`recordSingleUtterance: no speech detected within ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout?.on("data", (c: Buffer) => chunks.push(c));
    proc.stderr?.on("data", (c: Buffer) => { errLog += c.toString(); });
    proc.on("error", (err) => { clearTimeout(timeout); reject(err); });
    proc.on("exit", () => {
      clearTimeout(timeout);
      const wav = Buffer.concat(chunks);
      if (wav.length < 44) {
        reject(new Error(`recordSingleUtterance: empty audio (${errLog.slice(0, 200)})`));
        return;
      }
      wav.writeUInt32LE(wav.length - 8, 4);
      wav.writeUInt32LE(wav.length - 44, 40);
      resolve(wav);
    });
  });
}

/** Run the wake-word pipeline on a WAV file. Returns the peak probability
 *  (0–1) reported by the binary via `CALIBRATE_PEAK=<f32>` on stdout. */
export async function scoreWavAgainstWakeModel(extensionPath: string, wavPath: string): Promise<number> {
  await ensureVoiceEngine(extensionPath);
  const binPath = getBinaryPath(extensionPath);
  const modelPath = getModelPath(extensionPath);

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const proc = spawn(binPath, ["--calibrate", wavPath, "--model", modelPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.stdout?.on("data", (c: Buffer) => { stdout += c.toString(); });
    proc.stderr?.on("data", (c: Buffer) => { stderr += c.toString(); });
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code !== 0) { reject(new Error(`calibrate exit ${code}: ${stderr.slice(0, 300)}`)); return; }
      const m = stdout.match(/CALIBRATE_PEAK=([\d.]+)/);
      if (!m) { reject(new Error(`no CALIBRATE_PEAK in stdout: ${stdout.slice(0, 200)}`)); return; }
      resolve(parseFloat(m[1]));
    });
  });
}

/* ================================================================
   Shared helpers
   ================================================================ */

function collectAudio(): Buffer {
  const wav = Buffer.concat(audioChunks);
  audioChunks = [];
  stopping = false;
  if (wav.length === 0 && stderrLog) {
    throw new Error(
      stderrLog.includes("panicked")
        ? `Mic binary crashed: ${stderrLog.slice(0, 200)}`
        : `No audio captured. Make sure Cursor has mic permission in System Settings → Privacy → Microphone. (${stderrLog.slice(0, 100)})`
    );
  }
  return wav;
}

function fixWavHeader(wav: Buffer): Buffer {
  if (wav.length < 44) return wav;
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.writeUInt32LE(wav.length - 44, 40);
  return wav;
}

/** Compute RMS of a 16kHz mono 16-bit PCM WAV buffer. Skips the 44-byte
 *  RIFF header and reads signed 16-bit little-endian samples. Returns a
 *  normalized value in roughly [0, 1]. Used to reject mostly-silent
 *  captures before paying for a Whisper call — Whisper hallucinates on
 *  low-signal audio. */
function computeWavRms(wav: Buffer): number {
  if (wav.length < 44 + 2) return 0;
  const data = wav.subarray(44);
  const sampleCount = Math.floor(data.length / 2);
  if (sampleCount === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < sampleCount; i++) {
    const s = data.readInt16LE(i * 2) / 32768;
    sumSq += s * s;
  }
  return Math.sqrt(sumSq / sampleCount);
}

/** Detect Whisper's "repeat-phrase" hallucination AND extract whichever
 *  side of the repetition zone holds the real content.
 *
 *  Real speech rarely has the exact same 4+ word phrase twice; when
 *  Whisper is confused by noise it regurgitates something like "Can
 *  you hear me? Can you hear me?". The hallucination can sit at the
 *  START (real content trails after) or at the END (real content sits
 *  before the loop). We pick whichever side has more tokens.
 *
 *  Examples:
 *    A. "Can you hear me? Can you hear me? Like, explain the weather
 *       today." → keep tail "Like, explain the weather today."
 *    B. "Explain me the weather today. The weather today, the weather
 *       today." → keep head "Explain me the weather today."
 *    C. "What is what is what is what." → drop entirely
 *
 *  Returns:
 *    - { keep: text }       → no repetition detected, use as-is
 *    - { keep: head/tail }  → repetition at one end; non-repeated side returned
 *    - { keep: "" }         → both sides too short, whole transcript was junk */
export function dedupRepetitiveTranscript(text: string): { keep: string } {
  const tokens = text
    .toLowerCase()
    .replace(/[.!?,]/g, "")
    .split(/\s+/)
    .filter(Boolean);
  // Floor lowered 6 → catches short stutters like "yes please yes
  // please yes please" (6 tokens, 4-gram repeat). The previous 8-floor
  // let pure-repetition junk reach the chat route via the < 4 word
  // filter at line ~906.
  if (tokens.length < 6) return { keep: text };

  const phraseLen = 4;
  const seen = new Map<string, number>();
  for (let i = 0; i + phraseLen <= tokens.length; i++) {
    const phrase = tokens.slice(i, i + phraseLen).join(" ");
    if (seen.has(phrase)) {
      // Found a repeat. Walk to the LAST occurrence of this phrase so
      // we know the full extent of the repetition zone.
      const firstStart = seen.get(phrase)!;
      let lastEnd = firstStart + phraseLen;
      for (let j = i; j + phraseLen <= tokens.length; j++) {
        const p2 = tokens.slice(j, j + phraseLen).join(" ");
        if (p2 === phrase) lastEnd = j + phraseLen;
      }
      // Two candidate slices:
      //   - HEAD = [0, firstStart + phraseLen): everything up to + including
      //     the first instance of the phrase. Captures the legit prose
      //     before a suffix-repetition (case B).
      //   - TAIL = [lastEnd, end): everything after the final repetition.
      //     Captures the legit prose after a prefix-repetition (case A).
      const headEnd = firstStart + phraseLen;
      const tailStart = lastEnd;
      const headWords = headEnd;
      const tailWords = tokens.length - tailStart;
      const origTokens = text.split(/\s+/).filter(Boolean);

      // Each candidate side is "legit" only if it contains at least one
      // token NOT in the repeated phrase. Without this guard, fully-
      // repetitive transcripts like "yes yes yes yes yes yes yes yes"
      // (firstStart=0, headWords=4) leak the first phrase as if it were
      // real content. The min-words filter downstream is `< 4`, so a
      // 4-token phrase passes through and reaches /chat as junk.
      const phraseTokenSet = new Set(tokens.slice(firstStart, headEnd));
      const headHasNonPhraseToken = tokens
        .slice(0, firstStart)
        .some((t) => !phraseTokenSet.has(t));
      const tailHasNonPhraseToken = tokens
        .slice(tailStart)
        .some((t) => !phraseTokenSet.has(t));

      // Pick whichever side has (a) more tokens, (b) at least 3 words,
      // (c) at least one non-repetition token. If neither side qualifies,
      // the whole transcript was repetition junk → drop.
      const tailQualifies = tailWords >= 3 && tailHasNonPhraseToken;
      const headQualifies = headWords >= 3 && headHasNonPhraseToken;
      if (tailQualifies && (!headQualifies || tailWords >= headWords)) {
        return { keep: origTokens.slice(tailStart).join(" ").trim() };
      }
      if (headQualifies) {
        return { keep: origTokens.slice(0, headEnd).join(" ").trim() };
      }
      return { keep: "" };
    }
    seen.set(phrase, i);
  }
  return { keep: text };
}

export async function transcribe(wavBuffer: Buffer): Promise<string> {
  // Defensive pre-check: skip Whisper entirely when the audio is mostly
  // silent. The RMS here averages over the WHOLE recording — including
  // the silence pad before/after the user's actual words — so even
  // clear speech lands well below the Rust VAD's 0.022 instantaneous
  // threshold.
  //
  // Threshold is 0.008, the user's-side floor: their lowest observed
  // real-speech recording was 0.0111 (real test 2026-05-02), so 0.008
  // gives a 30% safety margin below that. Pure room tone runs ~0.002-
  // 0.005, so the gap is wide enough to still drop true silence.
  //
  // Tuning history:
  //   0.012 (orig) — dropped 0.0111 RMS real speech ("words went
  //                  nowhere")
  //   0.018 (try)  — dropped 0.011-0.013 real speech, also rejected
  //   0.008 (now)  — explicitly looser per user: "better to be
  //                  slightly more sensitive than drop it at all"
  //
  // Bot-tail bleed is handled separately by the 5s strict-mode buffer
  // + 1500ms decay post-TTS, not by this filter.
  const rms = computeWavRms(wavBuffer);
  if (rms < 0.008) {
    pipeLog("protege-stt", `dropped low-signal audio (rms=${rms.toFixed(4)})`);
    return "";
  }

  if (!isSignedIn()) {
    throw new Error("STT requires sign-in");
  }
  const arrayBuf = wavBuffer.buffer.slice(
    wavBuffer.byteOffset,
    wavBuffer.byteOffset + wavBuffer.byteLength
  ) as ArrayBuffer;
  const blob = new Blob([arrayBuf], { type: "audio/wav" });
  const form = new FormData();
  form.append("file", blob, "recording.wav");

  // FormData sets its own multipart Content-Type with boundary, so we
  // strip the JSON default that authHeaders bakes in. Authorization +
  // x-github-login still ride through.
  const headers = authHeaders();
  delete headers["content-type"];

  const res = await fetch(`${BACKEND_URL}/stt`, {
    method: "POST",
    headers,
    body: form,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`STT failed (${res.status}): ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as { text?: string };
  // `let` because the dedup step below may strip a Whisper-repetition
  // prefix and reassign the trailing real content.
  let text = (data.text ?? "").trim();

  // Exact-match ghost filter — the short-phrase hallucinations Whisper
  // outputs on silence.
  const normalized = text.toLowerCase().replace(/[.!?,]/g, "").trim();
  const GHOST_TRANSCRIPTS = new Set([
    "",
    "thank you",
    "thank you so much",
    "thank you for watching",
    "thanks",
    "thanks for watching",
    "thanks for watching this video",
    "thanks for listening",
    "you",
    "bye",
    "bye bye",
    "see ya",
    "see you",
    ".",
    "okay",
    "ok",
    "hi",
    "hello",
    "yeah",
    "yes",
    "no",
    "huh",
    "uh",
    "um",
    "mm",
    "mm hmm",
    "mmhmm",
    "ah",
    "ha",
    "hm",
    "hmm",
    "oh",
    "well",
    "yay",
    "ta da",
    "tada",
    "ta-da",
    "amen",
    "wow",
    "subscribe",
    "like and subscribe",
    "please subscribe",
    "see you next time",
    "see you in the next video",
    "if you enjoyed this video",
  ]);
  if (GHOST_TRANSCRIPTS.has(normalized)) {
    pipeLog("protege-stt", `dropped ghost transcript: "${text}"`);
    return "";
  }

  // Repetition sniff — Whisper-on-noise often repeats a 4+ word phrase
  // ("Can you hear me? Can you hear me?"). If the WHOLE transcript is
  // junk, drop it. If there's a repetition prefix followed by real
  // content, strip the prefix and keep the real part.
  const dedup = dedupRepetitiveTranscript(text);
  if (dedup.keep === "") {
    pipeLog("protege-stt", `dropped repetitive hallucination: "${text.slice(0, 120)}"`);
    return "";
  }
  if (dedup.keep !== text) {
    pipeLog("protege-stt", `stripped repetition prefix · was="${text.slice(0, 80)}…" now="${dedup.keep.slice(0, 80)}"`);
    text = dedup.keep;
  }

  // Min-word filter — short transcripts on near-silence are
  // overwhelmingly Whisper hallucinations.
  //
  // Bumped 3 → 4 (2026-05-01) after a real-world false positive:
  // mic auto-opened for a voice-dialogue follow-up window, captured
  // ~3s of room tone, Whisper produced the 3-word phrase
  // "Already upside down." — passed the old 3-word filter, fired a
  // ghost /chat call. Voice-dialogue users speak in full sentences
  // ("what about this part", "show me an example", "yes please
  // continue"); a 4-word floor cuts that whole class without
  // affecting natural speech.
  //
  // Legit 1–3 word voice commands are deliberately dropped — voice
  // mode is long-form Q&A. If a use case for short commands turns
  // up, add it to SHORT_COMMAND_ALLOWLIST.
  const SHORT_COMMAND_ALLOWLIST = new Set<string>([
    // Empty for now — keep this filter strict by default.
  ]);
  // Re-normalize against the (possibly trimmed) text so the word count
  // reflects what's actually being sent downstream — not the original
  // text before the repetition-prefix strip.
  const normalizedFinal = text.toLowerCase().replace(/[.!?,]/g, "").trim();
  const wordCount = normalizedFinal.split(/\s+/).filter(Boolean).length;
  if (wordCount < 4 && !SHORT_COMMAND_ALLOWLIST.has(normalizedFinal)) {
    pipeLog("protege-stt", `dropped short transcript (${wordCount} word${wordCount === 1 ? "" : "s"}): "${text}"`);
    return "";
  }

  return text;
}
