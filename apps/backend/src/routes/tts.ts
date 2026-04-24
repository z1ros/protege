import { Hono } from "hono";
import {
  kokoroTts,
  isKokoroReady,
  startKokoroWarmup,
  kokoroWarmupError,
  kokoroWarmupStatus,
} from "../kokoro.js";
import { sanitizeForVoice } from "../voicePostProcess.js";

export const ttsRoute = new Hono();

// Minimal valid WAV (44-byte RIFF header + 0 samples). Returned when the
// caller's text was entirely code/markdown that sanitizes to nothing —
// lets the webview's onended fire cleanly without a 400/empty-blob path.
const EMPTY_WAV = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
  0x66, 0x6d, 0x74, 0x20, 0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
  0x80, 0x3e, 0x00, 0x00, 0x00, 0x7d, 0x00, 0x00, 0x02, 0x00, 0x10, 0x00,
  0x64, 0x61, 0x74, 0x61, 0x00, 0x00, 0x00, 0x00,
]);

/**
 * POST /tts
 * Body: { text: string, voice?: "female" | "male" }
 * Returns: WAV audio from Kokoro (self-hosted, free).
 *
 * If Kokoro is still warming up, responds 503 so the client can show a
 * loading state and retry. No OpenAI fallback — Kokoro only.
 */

startKokoroWarmup();

ttsRoute.get("/status", (c) => {
  const s = kokoroWarmupStatus();
  return c.json({
    ready: isKokoroReady(),
    warmupError: kokoroWarmupError(),
    provider: "kokoro",
    stage: s.stage, // "idle" | "downloading" | "loading" | "ready" | "error"
    progress: s.progress, // 0..1 fraction when downloading
    loadedBytes: s.loadedBytes,
    totalBytes: s.totalBytes,
  });
});

ttsRoute.post("/", async (c) => {
  const body = (await c.req.json()) as {
    text: string;
    voice?: "female" | "male";
  };

  if (!body.text || body.text.trim().length === 0) {
    return c.json({ error: "text is required" }, 400);
  }

  // Strip code fences / filenames / markdown-isms so the spoken reply
  // sounds natural, regardless of what the caller sent. Chat UI gets
  // the raw text with code blocks; TTS gets the spoken version here.
  // Teaching-step narrations are already clean, so this is a no-op for them.
  const spokenText = sanitizeForVoice(body.text);
  if (spokenText.trim().length === 0) {
    // Everything was code/fences → nothing to speak. Return a tiny empty
    // WAV so the webview's audio.play() resolves cleanly (onended fires)
    // instead of hitting the empty-blob warn path.
    return new Response(new Uint8Array(EMPTY_WAV), {
      headers: { "content-type": "audio/wav", "cache-control": "no-cache" },
    });
  }

  const voice = body.voice ?? "female";

  if (!isKokoroReady()) {
    const warmErr = kokoroWarmupError();
    console.log(
      `[protege] /tts kokoro not ready (warmupError=${warmErr ?? "none"}) — returning 503`
    );
    return c.json(
      {
        error: "kokoro-warming-up",
        warmupError: warmErr,
      },
      503
    );
  }

  console.log(
    `[protege] /tts voice=${voice} chars=${spokenText.length} (raw=${body.text.length})`
  );

  try {
    const wav = await kokoroTts(spokenText, voice);
    return new Response(new Uint8Array(wav), {
      headers: {
        "content-type": "audio/wav",
        "cache-control": "no-cache",
        "access-control-allow-origin": "*",
        "x-protege-tts": "kokoro",
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[protege] kokoro tts failed: ${msg}`);
    return c.json({ error: msg }, 500);
  }
});

/* ==========================================================
   /stt — speech-to-text (OpenAI Whisper)
   ========================================================== */

export const sttRoute = new Hono();

sttRoute.post("/", async (c) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return c.json({ error: "OPENAI_API_KEY not set" }, 500);

  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return c.json({ error: "file field required" }, 400);
  }

  console.log(`[protege] /stt bytes=${file.size}`);

  const fd = new FormData();
  fd.append("file", file);
  fd.append("model", "whisper-1");
  fd.append("language", "en");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: fd,
  });

  if (!res.ok) {
    const err = await res.text();
    console.error(`[protege] /stt failed ${res.status}: ${err.slice(0, 300)}`);
    return c.json(
      { error: `OpenAI Whisper ${res.status}: ${err.slice(0, 200)}` },
      500
    );
  }

  const data = (await res.json()) as { text?: string };
  return c.json({ text: data.text ?? "" });
});
