import { Hono } from "hono";
import {
  kokoroTts,
  isKokoroReady,
  startKokoroWarmup,
  kokoroWarmupError,
  kokoroWarmupStatus,
} from "../kokoro.js";
import { sanitizeForVoice } from "../voicePostProcess.js";
import { quotaMiddleware } from "../middleware/quota.js";
import { addVoiceMinutes } from "../quotas.js";
import { getAuthenticatedUserId } from "../middleware/auth.js";

export const ttsRoute = new Hono();
// Quota gate. KNOWN LIMITATION (2026-04-29): /tts is currently called
// from the webview via plain `fetch()` without GitHub auth headers,
// because the webview can't reach the host's authState directly. With
// no `authenticatedUserId` on the context, this middleware no-ops via
// the `if (!userId) return next()` branch — so the tts quota panel
// stays at 0/limit even with PROTEGE_QUOTAS=on. The cap doesn't yet
// enforce. Wiring the webview through the host (so /tts goes via
// `authedFetch`) is the next step; tracked in the beta-quotas plan.
ttsRoute.post("*", quotaMiddleware("tts"));

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
  const reqId = Math.random().toString(36).slice(2, 8);
  const t0 = Date.now();

  const body = (await c.req.json()) as {
    text: string;
    voice?: "female" | "male";
  };

  console.log(
    `[protege] /tts[${reqId}] IN voice=${body.voice ?? "female"} rawChars=${body.text?.length ?? 0} preview=${JSON.stringify((body.text ?? "").slice(0, 80))}`
  );

  if (!body.text || body.text.trim().length === 0) {
    console.log(`[protege] /tts[${reqId}] REJECT — empty text`);
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
    console.log(
      `[protege] /tts[${reqId}] EMPTY-AFTER-SANITIZE — returning empty WAV (${EMPTY_WAV.length}b)`
    );
    return new Response(new Uint8Array(EMPTY_WAV), {
      headers: { "content-type": "audio/wav", "cache-control": "no-cache" },
    });
  }

  const voice = body.voice ?? "female";

  if (!isKokoroReady()) {
    const warmErr = kokoroWarmupError();
    const s = kokoroWarmupStatus();
    console.log(
      `[protege] /tts[${reqId}] 503 — kokoro not ready · stage=${s.stage} progress=${s.progress?.toFixed?.(2) ?? "?"} warmupError=${warmErr ?? "none"}`
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
    `[protege] /tts[${reqId}] GENERATE voice=${voice} sanitizedChars=${spokenText.length} (raw=${body.text.length}) sanitizedPreview=${JSON.stringify(spokenText.slice(0, 80))}`
  );

  try {
    const tGen0 = Date.now();
    const wav = await kokoroTts(spokenText, voice);
    const tGen = Date.now() - tGen0;
    console.log(
      `[protege] /tts[${reqId}] OK · wavBytes=${wav.byteLength} kokoroMs=${tGen} totalMs=${Date.now() - t0}`
    );
    // Record voice minutes. ~750 chars/min is typical for the Kokoro
    // voice we're using; the actual audio length comes from the WAV
    // header but estimating from text length is close enough for the
    // budget signal and avoids parsing the WAV. No-op when no userId
    // (see route header — /tts isn't yet authed end-to-end).
    const userId = getAuthenticatedUserId(c);
    if (userId) {
      const minutes = spokenText.length / 750;
      void addVoiceMinutes(userId, minutes);
    }
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
    const stack = err instanceof Error ? err.stack : undefined;
    console.error(
      `[protege] /tts[${reqId}] FAIL kokoro · ${msg}${stack ? `\n${stack}` : ""}`
    );
    return c.json({ error: msg }, 500);
  }
});

/* ==========================================================
   /stt — speech-to-text (OpenAI Whisper)
   ========================================================== */

export const sttRoute = new Hono();
// Same KNOWN LIMITATION as /tts — voiceCapture posts to /stt without
// auth headers, so the middleware no-ops until /stt is moved through
// the authed host proxy. See ttsRoute comment above + beta-quotas plan.
sttRoute.post("*", quotaMiddleware("stt"));

sttRoute.post("/", async (c) => {
  const reqId = Math.random().toString(36).slice(2, 8);
  const t0 = Date.now();
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error(`[protege] /stt[${reqId}] FAIL — OPENAI_API_KEY missing`);
    return c.json({ error: "OPENAI_API_KEY not set" }, 500);
  }

  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    console.error(`[protege] /stt[${reqId}] REJECT — no file field`);
    return c.json({ error: "file field required" }, 400);
  }

  console.log(`[protege] /stt[${reqId}] IN bytes=${file.size} type=${file.type}`);

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
    console.error(
      `[protege] /stt[${reqId}] FAIL ${res.status} · ${err.slice(0, 300)} · totalMs=${Date.now() - t0}`
    );
    return c.json(
      { error: `OpenAI Whisper ${res.status}: ${err.slice(0, 200)}` },
      500
    );
  }

  const data = (await res.json()) as { text?: string };
  const text = data.text ?? "";
  console.log(
    `[protege] /stt[${reqId}] OK chars=${text.length} preview=${JSON.stringify(text.slice(0, 80))} totalMs=${Date.now() - t0}`
  );
  // Record voice minutes from the audio blob's reported size. Whisper
  // accepts up to 25 MB; Opus at ~32 kbps gives roughly ~4 KB/sec, but
  // the user's voiceCapture uses 16 kHz mono PCM which is ~32 KB/sec.
  // Approximate minutes from byte count / 32_000 / 60 — close enough
  // for a budget signal. No-op when no userId.
  const userId = getAuthenticatedUserId(c);
  if (userId) {
    const minutes = file.size / 32_000 / 60;
    void addVoiceMinutes(userId, minutes);
  }
  return c.json({ text });
});
