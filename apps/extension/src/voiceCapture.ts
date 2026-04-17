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

// When the bot is speaking, we still want to allow barge-in via a clear
// "Protege" — but not random noises or the bot's own voice bleeding through
// the mic. So during TTS we apply a stricter confidence threshold on top of
// the binary's already-sensitive detection.
let strictMode = false;
let lastWakeAvg = 0;
const STRICT_AVG_THRESHOLD = 0.35;

export function setStrictWakeMode(v: boolean): void {
  strictMode = v;
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
  }
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

  wakeProcess = spawn(binPath, ["--wake-word", "--model", modelPath], {
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

      if (trimmed === "WAKE:detected") {
        if (strictMode && lastWakeAvg < STRICT_AVG_THRESHOLD) {
          pipeLog(
            "protege-wake",
            `barge-in ignored (avg=${lastWakeAvg.toFixed(3)} < ${STRICT_AVG_THRESHOLD} during speech)`
          );
          continue;
        }
        // Wake word heard — binary is now recording
        wakeAudioChunks = []; // clear any stale data
        onWakeDetected?.();
      } else if (trimmed === "RECORDING:stopped") {
        // Silence after speech — audio is ready
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

export async function transcribe(wavBuffer: Buffer): Promise<string> {
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
  return data.text ?? "";
}
