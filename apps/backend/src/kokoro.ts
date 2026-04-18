import { KokoroTTS } from "kokoro-js";

/**
 * Kokoro TTS — open source, self-hosted, high quality.
 * First call downloads ~80MB model. Warmed on backend start.
 *
 * Voice choices:
 *   female: af_bella (warm American)  | af_heart | af_nicole | bf_emma (British)
 *   male:   am_michael | am_adam | bm_george (British)
 */

type Voice = "female" | "male";

const MODEL_ID =
  process.env.KOKORO_MODEL_ID ?? "onnx-community/Kokoro-82M-v1.0-ONNX";
// NOTE: the HF repo hosts: model.onnx, model_fp16.onnx, model_q4.onnx,
// model_q4f16.onnx, model_q8f16.onnx, model_quantized.onnx, model_uint8.onnx,
// model_uint8f16.onnx. transformers.js v3 does not reliably resolve dtype "q8"
// to model_quantized.onnx for this repo, so default to "fp16" (exists, canonical).
const DTYPE = (process.env.KOKORO_DTYPE ?? "fp16") as "fp32" | "fp16" | "q8" | "q4" | "q4f16";

const VOICE_MAP: Record<Voice, string> = {
  female: process.env.KOKORO_VOICE_FEMALE ?? "af_bella",
  male: process.env.KOKORO_VOICE_MALE ?? "am_michael",
};

let instancePromise: Promise<KokoroTTS> | null = null;
let ready = false;
let warmupError: string | null = null;

// Track whether we're downloading from HF or just loading an already-
// cached model. The UX differs drastically: download = show a progress
// bar, minutes; cached load = sub-second, just hide the card entirely.
type WarmupStage = "idle" | "downloading" | "loading" | "ready" | "error";
let stage: WarmupStage = "idle";
let downloadProgress = 0; // 0..1
let downloadTotalBytes = 0;
let downloadLoadedBytes = 0;

export function startKokoroWarmup(): Promise<KokoroTTS> | null {
  if (instancePromise) return instancePromise;
  const start = Date.now();
  stage = "loading";
  console.log(
    `[protege] kokoro warmup (model=${MODEL_ID} dtype=${DTYPE}) — first time downloads ~80MB…`
  );

  // transformers.js progress_callback fires for both initiate/download/done
  // events across the files being fetched. We aggregate to a single 0..1
  // fraction and flip the stage to "downloading" on the first real byte.
  const progressCallback = (data: {
    status?: string;
    name?: string;
    file?: string;
    progress?: number;
    loaded?: number;
    total?: number;
  }) => {
    if (data.status === "download" || data.status === "progress") {
      stage = "downloading";
      if (typeof data.loaded === "number" && typeof data.total === "number" && data.total > 0) {
        downloadLoadedBytes = data.loaded;
        downloadTotalBytes = data.total;
        downloadProgress = Math.max(0, Math.min(1, data.loaded / data.total));
      } else if (typeof data.progress === "number") {
        downloadProgress = Math.max(0, Math.min(1, data.progress / 100));
      }
    } else if (data.status === "done") {
      downloadProgress = 1;
    }
  };

  instancePromise = (KokoroTTS.from_pretrained as unknown as (
    id: string,
    opts: { dtype: string; progress_callback?: typeof progressCallback }
  ) => Promise<KokoroTTS>)(MODEL_ID, { dtype: DTYPE, progress_callback: progressCallback });
  instancePromise
    .then(() => {
      ready = true;
      stage = "ready";
      const ms = Date.now() - start;
      console.log(`[protege] kokoro ready in ${ms}ms`);
    })
    .catch((err) => {
      warmupError = err instanceof Error ? err.message : String(err);
      stage = "error";
      console.error(`[protege] kokoro warmup failed: ${warmupError}`);
      if (err instanceof Error && err.stack) console.error(err.stack);
      instancePromise = null;
      ready = false;
    });
  return instancePromise;
}

export function isKokoroReady(): boolean {
  return ready;
}

export function kokoroWarmupError(): string | null {
  return warmupError;
}

export function kokoroWarmupStatus() {
  return {
    stage,
    progress: downloadProgress,
    loadedBytes: downloadLoadedBytes,
    totalBytes: downloadTotalBytes,
  };
}

export async function kokoroTts(
  text: string,
  voice: Voice
): Promise<Buffer> {
  if (!instancePromise) startKokoroWarmup();
  const tts = await instancePromise!;

  const voiceId = VOICE_MAP[voice];
  const audio = await (
    tts.generate as unknown as (
      text: string,
      opts: { voice: string; speed?: number }
    ) => Promise<{ toWav: () => Uint8Array | ArrayBuffer }>
  )(text, { voice: voiceId, speed: 1.0 });

  const wav = audio.toWav();
  // toWav may return Uint8Array or ArrayBuffer depending on version
  if (wav instanceof Uint8Array) return Buffer.from(wav);
  return Buffer.from(new Uint8Array(wav));
}
