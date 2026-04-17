import { Hono } from "hono";

export const voiceRoute = new Hono();

/**
 * GET /voice — standalone voice page that runs in the user's real browser.
 *
 * Why this exists: VS Code / Cursor webviews sandbox getUserMedia via iframe
 * Permissions-Policy — microphone is blocked regardless of macOS TCC grants.
 * The workaround is to have the extension call vscode.env.openExternal(...)
 * with this URL, which opens the system browser where getUserMedia works
 * normally. See: github.com/microsoft/vscode/issues/113916.
 *
 * This first version is an echo test: mic → /stt → show transcript → /tts
 * → play audio back. Proves the full roundtrip works outside the webview.
 */
voiceRoute.get("/", (c) => {
  const userId = c.req.query("userId") ?? "local-dev";
  const html = renderVoicePage(userId);
  return c.html(html);
});

function renderVoicePage(userId: string): string {
  const safeUserId = userId.replace(/[^a-zA-Z0-9._-]/g, "");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Protege Voice</title>
<style>
  :root {
    --bg: #05060a;
    --fg: #e8ecf5;
    --muted: #7a8399;
    --accent: #7aa2ff;
    --accent-glow: rgba(122, 162, 255, 0.45);
    --panel: rgba(255, 255, 255, 0.04);
    --border: rgba(255, 255, 255, 0.08);
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0; height: 100%;
    background: radial-gradient(1200px 800px at 50% 20%, #0b1020 0%, var(--bg) 60%);
    color: var(--fg);
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  body {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 28px; padding: 32px;
  }
  h1 {
    font-size: 14px; letter-spacing: 0.18em; text-transform: uppercase;
    color: var(--muted); font-weight: 500; margin: 0;
  }
  .orb {
    width: 180px; height: 180px; border-radius: 50%;
    background: radial-gradient(circle at 35% 30%, #9dbcff, #4a6bd6 55%, #1a2550 100%);
    box-shadow: 0 0 60px var(--accent-glow), inset 0 0 40px rgba(0,0,0,0.4);
    transition: transform 0.2s ease, box-shadow 0.2s ease;
  }
  .orb.recording {
    transform: scale(1.08);
    box-shadow: 0 0 100px #ff6a8a, inset 0 0 40px rgba(0,0,0,0.4);
    background: radial-gradient(circle at 35% 30%, #ffb1c4, #d64a6b 55%, #50161a 100%);
  }
  .orb.speaking {
    animation: pulse 1.2s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { transform: scale(1); }
    50% { transform: scale(1.06); }
  }
  .status { font-size: 18px; color: var(--fg); min-height: 26px; text-align: center; }
  .transcript {
    max-width: 540px; min-height: 64px; padding: 16px 20px;
    background: var(--panel); border: 1px solid var(--border); border-radius: 14px;
    color: var(--fg); font-size: 15px; line-height: 1.5; text-align: center;
  }
  .transcript.empty { color: var(--muted); font-style: italic; }
  .controls { display: flex; gap: 12px; }
  button {
    appearance: none; border: 1px solid var(--border); background: var(--panel);
    color: var(--fg); font-size: 14px; font-weight: 500;
    padding: 12px 22px; border-radius: 12px; cursor: pointer;
    transition: background 0.15s ease, border-color 0.15s ease, transform 0.1s ease;
  }
  button:hover:not(:disabled) { background: rgba(255,255,255,0.08); border-color: var(--accent); }
  button:active:not(:disabled) { transform: scale(0.97); }
  button:disabled { opacity: 0.4; cursor: not-allowed; }
  button.primary {
    background: var(--accent); color: #05060a; border-color: var(--accent);
  }
  button.primary:hover:not(:disabled) { background: #9dbcff; }
  .footer {
    position: fixed; bottom: 16px; left: 0; right: 0; text-align: center;
    font-size: 11px; color: var(--muted);
  }
  .error {
    color: #ff8a9e; font-size: 13px; max-width: 520px; text-align: center;
  }
</style>
</head>
<body>
  <h1>Protege · Voice Test</h1>
  <div class="orb" id="orb"></div>
  <div class="status" id="status">Tap the mic to start</div>
  <div class="transcript empty" id="transcript">Your speech will appear here</div>
  <div class="controls">
    <button id="recBtn" class="primary">Start talking</button>
    <button id="stopBtn" disabled>Stop</button>
  </div>
  <div class="error" id="error"></div>
  <div class="footer">userId: ${safeUserId} · backend: ${""}</div>

<script>
(() => {
  const BACKEND = window.location.origin;
  const USER_ID = ${JSON.stringify(safeUserId)};

  const orb = document.getElementById("orb");
  const status = document.getElementById("status");
  const transcript = document.getElementById("transcript");
  const recBtn = document.getElementById("recBtn");
  const stopBtn = document.getElementById("stopBtn");
  const errorEl = document.getElementById("error");

  let mediaStream = null;
  let recorder = null;
  let chunks = [];

  function setStatus(text) { status.textContent = text; }
  function setTranscript(text) {
    if (!text) {
      transcript.textContent = "Your speech will appear here";
      transcript.classList.add("empty");
    } else {
      transcript.textContent = text;
      transcript.classList.remove("empty");
    }
  }
  function setError(msg) { errorEl.textContent = msg || ""; }

  async function ensureMic() {
    if (mediaStream) return mediaStream;
    setStatus("Requesting microphone…");
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    return mediaStream;
  }

  async function startRecording() {
    setError("");
    try {
      const stream = await ensureMic();
      chunks = [];
      recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      recorder.onstop = handleStop;
      recorder.start();
      orb.classList.add("recording");
      orb.classList.remove("speaking");
      recBtn.disabled = true;
      stopBtn.disabled = false;
      setStatus("Listening…");
    } catch (err) {
      setError("Mic access failed: " + (err && err.message ? err.message : String(err)));
      setStatus("Tap the mic to start");
    }
  }

  function stopRecording() {
    if (!recorder || recorder.state === "inactive") return;
    recorder.stop();
    orb.classList.remove("recording");
    stopBtn.disabled = true;
    setStatus("Transcribing…");
  }

  async function handleStop() {
    const blob = new Blob(chunks, { type: "audio/webm" });
    chunks = [];
    try {
      const form = new FormData();
      form.append("file", blob, "speech.webm");
      const sttRes = await fetch(BACKEND + "/stt", { method: "POST", body: form });
      if (!sttRes.ok) throw new Error("STT " + sttRes.status);
      const { text } = await sttRes.json();
      if (!text || !text.trim()) {
        setStatus("Didn't catch that — try again");
        setTranscript("");
        recBtn.disabled = false;
        return;
      }
      setTranscript(text);
      setStatus("Speaking back…");
      await speak(text);
      setStatus("Tap the mic to start");
      recBtn.disabled = false;
    } catch (err) {
      setError("Error: " + (err && err.message ? err.message : String(err)));
      setStatus("Tap the mic to start");
      recBtn.disabled = false;
    }
  }

  async function speak(text) {
    const res = await fetch(BACKEND + "/tts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, voice: "female" }),
    });
    if (!res.ok) throw new Error("TTS " + res.status);
    const buf = await res.arrayBuffer();
    const audioBlob = new Blob([buf], { type: "audio/wav" });
    const url = URL.createObjectURL(audioBlob);
    const audio = new Audio(url);
    orb.classList.add("speaking");
    await new Promise((resolve) => {
      audio.onended = () => { orb.classList.remove("speaking"); URL.revokeObjectURL(url); resolve(); };
      audio.onerror = () => { orb.classList.remove("speaking"); URL.revokeObjectURL(url); resolve(); };
      audio.play().catch(() => { orb.classList.remove("speaking"); resolve(); });
    });
  }

  recBtn.addEventListener("click", startRecording);
  stopBtn.addEventListener("click", stopRecording);
})();
</script>
</body>
</html>`;
}
