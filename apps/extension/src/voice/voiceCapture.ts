import { spawn, ChildProcess } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";

const BACKEND_URL = "http://localhost:8787";

let micProcess: ChildProcess | null = null;
let audioChunks: Buffer[] = [];
let stderrLog = "";
let stopping = false;
let onAutoStop: (() => void) | null = null;

// Wake word listener
let wakeProcess: ChildProcess | null = null;
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
  fetch(`${BACKEND_URL}/log`, {
    method: "POST",
    headers: { "content-type": "application/json" },
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

  const binPath = getBinaryPath(extensionPath);
  if (!fs.existsSync(binPath)) {
    throw new Error(
      `Voice binary not found: ${binPath}. ` +
        `Your platform (${process.platform}-${process.arch}) may not be supported yet.`
    );
  }

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

  const binPath = getBinaryPath(extensionPath);
  const modelPath = getModelPath(extensionPath);

  if (!fs.existsSync(binPath)) {
    throw new Error(`Voice binary not found: ${binPath}`);
  }
  if (!fs.existsSync(modelPath)) {
    throw new Error(`Wake word model not found: ${modelPath}`);
  }

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
    wakeProcess = null;
  });

  pipeLog("protege-wake", `listener started (bin=${binPath})`);
}

export function stopWakeWordListener(): void {
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
  const binPath = getBinaryPath(extensionPath);
  if (!fs.existsSync(binPath)) throw new Error(`Voice binary not found: ${binPath}`);

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
  const binPath = getBinaryPath(extensionPath);
  const modelPath = getModelPath(extensionPath);
  if (!fs.existsSync(binPath)) throw new Error(`Voice binary not found: ${binPath}`);
  if (!fs.existsSync(modelPath)) throw new Error(`Model not found: ${modelPath}`);

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

/** Detect Whisper's "repeat-phrase" hallucination signature. Real speech
 *  from a coding Q&A rarely has the exact same 4+ word phrase twice; when
 *  Whisper is confused by noise it often regurgitates something like
 *  "You can't see it. You can't see it." Returns true if we should drop. */
function looksRepetitive(text: string): boolean {
  const words = text.toLowerCase().replace(/[.!?,]/g, "").split(/\s+/).filter(Boolean);
  if (words.length < 8) return false;
  const phraseLen = 4;
  const seen = new Map<string, number>();
  for (let i = 0; i + phraseLen <= words.length; i++) {
    const phrase = words.slice(i, i + phraseLen).join(" ");
    const count = (seen.get(phrase) ?? 0) + 1;
    seen.set(phrase, count);
    if (count >= 2) return true;
  }
  return false;
}

export async function transcribe(wavBuffer: Buffer): Promise<string> {
  // Defensive pre-check: skip Whisper entirely when the audio is mostly
  // silent. 0.012 is just below our Rust VAD speech threshold (0.015) —
  // if the overall energy is below this, the brief speech burst that
  // tripped VAD was too short to transcribe cleanly, and sending it to
  // Whisper produces hallucinations like "Thanks for watching".
  const rms = computeWavRms(wavBuffer);
  if (rms < 0.012) {
    pipeLog("protege-stt", `dropped low-signal audio (rms=${rms.toFixed(4)})`);
    return "";
  }

  const arrayBuf = wavBuffer.buffer.slice(
    wavBuffer.byteOffset,
    wavBuffer.byteOffset + wavBuffer.byteLength
  ) as ArrayBuffer;
  const blob = new Blob([arrayBuf], { type: "audio/wav" });
  const form = new FormData();
  form.append("file", blob, "recording.wav");

  const res = await fetch(`${BACKEND_URL}/stt`, {
    method: "POST",
    body: form,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`STT failed (${res.status}): ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as { text?: string };
  const text = (data.text ?? "").trim();

  // Exact-match ghost filter — the short-phrase hallucinations Whisper
  // outputs on silence.
  const normalized = text.toLowerCase().replace(/[.!?,]/g, "").trim();
  const GHOST_TRANSCRIPTS = new Set([
    "",
    "thank you",
    "thanks",
    "thanks for watching",
    "you",
    "bye",
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
    "subscribe",
    "like and subscribe",
    "please subscribe",
    "see you next time",
    "see you in the next video",
  ]);
  if (GHOST_TRANSCRIPTS.has(normalized)) {
    pipeLog("protege-stt", `dropped ghost transcript: "${text}"`);
    return "";
  }

  // Repetition sniff — classic Whisper-on-noise output has a repeated
  // phrase ("You can't see it. You can't see it."). Reject if we see
  // the same 4-word phrase twice.
  if (looksRepetitive(text)) {
    pipeLog("protege-stt", `dropped repetitive hallucination: "${text.slice(0, 120)}"`);
    return "";
  }

  return text;
}
