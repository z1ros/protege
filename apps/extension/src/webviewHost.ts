import * as vscode from "vscode";
import type {
  WebviewToHost,
  HostToWebview,
  ChatMessage,
  Finding,
} from "@protege/types";
import { getUserId, fetchMe } from "./protegeClient.js";
import { getGitHubUser } from "./auth.js";
import { runChat } from "./chatRunner.js";
import { getActiveFileEditor } from "./activeFile.js";
import { classifyResponse, dispatchRouterActions } from "./responseRouter.js";
import { getHistory, appendMessage, searchHistory, clearHistory } from "./chatHistory.js";
import { clearAllHighlights } from "./tools.js";
import { isLiveReviewActive } from "./liveReview.js";
import { getOnDeviceStatus, onStatusChange } from "./onDeviceModel.js";
import {
  startRecording,
  stopRecording,
  transcribe,
  isRecording,
  collectAutoStopAudio,
  startWakeWordListener,
  stopWakeWordListener,
  isWakeWordListening,
  collectWakeAudio,
  setStrictWakeMode,
  setWakeSuspended,
} from "./voiceCapture.js";
import { getStoredWakeThreshold } from "./wakeWordCalibration.js";
import { devPortMapping, isDevMode, renderDevHtml } from "./devMode.js";

/**
 * Registry so outside code (analyzer, status bar) can broadcast messages
 * (like "iq/update") into every mounted Protege webview.
 */
const mountedWebviews = new Set<vscode.Webview>();

export function broadcast(msg: HostToWebview) {
  for (const w of mountedWebviews) {
    try {
      w.postMessage(msg);
    } catch {}
  }
}

/**
 * How many Protege webviews are currently mounted (sidebar launcher + any
 * open Protege editor tabs). Returns 0 when the user has never opened the
 * Protege panel in this session — useful for features (like voice
 * explain) that need at least one webview to deliver their output.
 */
export function mountedWebviewCount(): number {
  return mountedWebviews.size;
}

// Forward on-device model status changes to every mounted webview so the
// Live tab's "On-Device" card reflects real download/load state.
let modelStatusListenerRegistered = false;
function ensureModelStatusListener() {
  if (modelStatusListenerRegistered) return;
  modelStatusListenerRegistered = true;
  onStatusChange((status) => {
    broadcast({
      type: "ai/modelStatus",
      ready: status.ready,
      loading: status.loading,
      error: status.error,
      downloadProgress: status.downloadProgress,
    });
  });
}

export function pushTeachFinding(finding: Finding) {
  broadcast({ type: "teach/finding", finding });
}

export function mountProtegeWebview(
  webview: vscode.Webview,
  context: vscode.ExtensionContext
) {
  ensureModelStatusListener();
  webview.options = {
    enableScripts: true,
    localResourceRoots: [
      vscode.Uri.joinPath(context.extensionUri, "dist", "webview"),
    ],
    ...(isDevMode(context.extensionMode) ? { portMapping: devPortMapping() } : {}),
  };
  webview.html = renderHtml(webview, context.extensionUri, context.extensionMode);
  mountedWebviews.add(webview);

  const userId = getUserId(context);

  const sub = webview.onDidReceiveMessage(async (msg: WebviewToHost) => {
    if (msg.type === "chat/send") {
      // Intercept teaching flow follow-up chips
      const text = msg.message.trim().toLowerCase();
      if (text === "next step →" || text === "next step") {
        const { advanceFlow, isFlowActive } = await import("./teachingFlow.js");
        if (isFlowActive()) { advanceFlow(); return; }
      }
      if (text === "stop lesson") {
        vscode.commands.executeCommand("protege.stopTeachFlow");
        return;
      }
      if (text === "teach me something else") {
        vscode.commands.executeCommand("protege.startTeachFlow");
        return;
      }
      if (text === "another exercise") {
        vscode.commands.executeCommand("protege.createExercise");
        return;
      }
      if (text === "show me a hint") {
        vscode.commands.executeCommand("protege.showHint");
        return;
      }
      if (text === "i give up — show solution" || text === "i give up") {
        // TODO: show the solution from the active exercise
        vscode.window.showInformationMessage("Try one more time! Use Cmd+K H for a hint.");
        return;
      }
      await handleChat(webview, userId, msg.message, msg.mode ?? "text");
    } else if (msg.type === "ready") {
      sendInitialState(webview, userId);

      // Hydrate the AI backend choice + last-call info so the Live tab
      // reflects persisted state instead of defaulting to "auto".
      const { getAiBackend, getLastCall } = await import("./aiBackend.js");
      post(webview, { type: "ai/backend", backend: getAiBackend() });
      const last = getLastCall();
      if (last) {
        post(webview, {
          type: "ai/lastCall",
          backend: last.backend,
          atMs: last.atMs,
          durationMs: last.durationMs,
          ok: last.ok,
          fallback: last.fallback,
        });
      }

      // Send persisted chat history so conversations survive reloads
      const history = getHistory();
      if (history.length > 0) {
        post(webview, { type: "chat/history", messages: history });
      }

      // Send GitHub auth state (silent — don't prompt yet)
      const ghUser = await getGitHubUser(false);
      post(webview, {
        type: "auth/user",
        user: ghUser
          ? {
              githubId: ghUser.githubId,
              login: ghUser.login,
              email: ghUser.email,
              avatarUrl: ghUser.avatarUrl,
            }
          : null,
      });
    } else if (msg.type === "auth/login") {
      // User clicked "Sign in with GitHub" in the webview — prompt
      const ghUser = await getGitHubUser(true);
      post(webview, {
        type: "auth/user",
        user: ghUser
          ? {
              githubId: ghUser.githubId,
              login: ghUser.login,
              email: ghUser.email,
              avatarUrl: ghUser.avatarUrl,
            }
          : null,
      });
    } else if (msg.type === "watcher/engage") {
      // User clicked "Help me" on a proactive nudge — escalate to Claude
      const synthetic = buildEngagePrompt(msg.triggerId, msg.context);
      await handleChat(webview, userId, synthetic, "text");
    } else if (msg.type === "scan/request") {
      vscode.commands.executeCommand("protege.scanActiveFile");
    } else if (msg.type === "liveReview/toggle") {
      vscode.commands.executeCommand("protege.toggleLiveReview");
    } else if (msg.type === "echo/open") {
      vscode.commands.executeCommand("protege.openEcho");
    } else if (msg.type === "chat/search") {
      const results = searchHistory(msg.query);
      post(webview, { type: "chat/searchResults", results });
    } else if (msg.type === "chat/clearHistory") {
      clearHistory();
      post(webview, { type: "chat/history", messages: [] });
    } else if (msg.type === "feature/toggle") {
      if (msg.feature === "inlineErrors") {
        const { setInlineErrorsEnabled } = await import("./inlineErrors.js");
        setInlineErrorsEnabled(msg.enabled);
      } else if (msg.feature === "didYouKnow") {
        const { setDidYouKnowEnabled } = await import("./didYouKnow.js");
        setDidYouKnowEnabled(msg.enabled);
      }
    } else if (msg.type === "ai/setBackend") {
      const { setAiBackend } = await import("./aiBackend.js");
      setAiBackend(msg.backend);
      // Echo the persisted value back so the webview reflects the
      // authoritative host state (and so new panels in parallel hydrate).
      post(webview, { type: "ai/backend", backend: msg.backend });
    } else if (msg.type === "ai/downloadModel") {
      vscode.commands.executeCommand("protege.downloadOnDeviceModel");
    } else if (msg.type === "openExternal") {
      // Webview can't call openExternal itself — bounce through the host.
      // Used for jumping to macOS Settings → Privacy → Microphone.
      // Also detects "command:<id>" URIs from the Quick Actions buttons and
      // runs them as VS Code commands (openExternal can't execute commands).
      try {
        if (msg.url.startsWith("command:")) {
          const rest = msg.url.slice("command:".length);
          const qIdx = rest.indexOf("?");
          const commandId = qIdx === -1 ? rest : rest.slice(0, qIdx);
          let args: unknown[] = [];
          if (qIdx !== -1) {
            try {
              const parsed = JSON.parse(decodeURIComponent(rest.slice(qIdx + 1)));
              args = Array.isArray(parsed) ? parsed : [parsed];
            } catch {
              args = [];
            }
          }
          await vscode.commands.executeCommand(commandId, ...args);
        } else {
          await vscode.env.openExternal(vscode.Uri.parse(msg.url));
        }
      } catch (err) {
        console.warn("[protege] openExternal failed:", err);
      }
    } else if (msg.type === "voice/openInBrowser") {
      const url = `http://localhost:8787/voice?userId=${encodeURIComponent(userId)}`;
      try {
        await vscode.env.openExternal(vscode.Uri.parse(url));
      } catch (err) {
        console.warn("[protege] voice/openInBrowser failed:", err);
      }
    } else if (msg.type === "voice/start") {
      try {
        // Auto-stop callback: when the binary detects silence and exits
        // on its own, run the same transcribe→chat flow as manual stop.
        const autoStop = async () => {
          try {
            const wav = collectAutoStopAudio();
            post(webview, { type: "voice/recording", active: false });
            if (wav.length < 1000) {
              post(webview, { type: "voice/error", error: "Recording too short" });
              return;
            }
            const text = await transcribe(wav);
            if (!text.trim()) {
              post(webview, { type: "voice/error", error: "Couldn't hear anything" });
              return;
            }
            post(webview, { type: "voice/transcript", text });
            await handleChat(webview, userId, text, "voice");
          } catch (err) {
            post(webview, { type: "voice/recording", active: false });
            const stopErr = err instanceof Error ? err.message : String(err);
            post(webview, { type: "voice/error", error: stopErr });
          }
        };
        await startRecording(context.extensionUri.fsPath, autoStop);
        post(webview, { type: "voice/recording", active: true });
      } catch (err) {
        const startErr = err instanceof Error ? err.message : String(err);
        post(webview, { type: "voice/error", error: startErr });
      }
    } else if (msg.type === "voice/stop") {
      try {
        const wav = await stopRecording();
        post(webview, { type: "voice/recording", active: false });
        if (wav.length < 1000) {
          post(webview, { type: "voice/error", error: "Recording too short" });
          return;
        }
        const text = await transcribe(wav);
        if (!text.trim()) {
          post(webview, { type: "voice/error", error: "Couldn't hear anything" });
          return;
        }
        post(webview, { type: "voice/transcript", text });
        await handleChat(webview, userId, text, "voice");
      } catch (err) {
        post(webview, { type: "voice/recording", active: false });
        const stopErr = err instanceof Error ? err.message : String(err);
        post(webview, { type: "voice/error", error: stopErr });
      }
    } else if (msg.type === "voice/playbackDone") {
      // If this was a teach_step clip (has requestId), resolve the tool's
      // awaiter so Claude can issue the next step. Otherwise it was a
      // Ghost Lens voice explanation — pass it to the ghostMentor chip swap.
      if (msg.requestId) {
        const { resolvePlayback } = await import("./teachingStep.js");
        resolvePlayback(msg.requestId, msg.reason);
      } else {
        const { onVoicePlaybackDone } = await import("./ghostMentor.js");
        void onVoicePlaybackDone(msg.reason);
      }
    } else if (msg.type === "voice/speaking") {
      // Bot starts speaking → fully suspend the wake listener. No wake
      // events, no recordings. Bot voice bleeding back through the mic
      // cannot self-trigger the loop ("Oh yeah you brought the book…").
      // Bot finishes → wait 500ms for speaker decay, then un-suspend.
      const active = !!msg.active;
      setStrictWakeMode(active);
      if (active) {
        setWakeSuspended(true);
      } else {
        setTimeout(() => setWakeSuspended(false), 500);
      }
    } else if (msg.type === "wake/toggle") {
      if (isWakeWordListening()) {
        stopWakeWordListener();
        post(webview, { type: "wake/state", active: false });
      } else {
        try {
          // Immediately tell webview we're loading — the binary takes
          // ~1-3s to load its three ONNX models before it can detect
          // anything. The UI renders a "Warming up wake word…" state
          // until we get WAKE:ready back via onReady.
          post(webview, { type: "wake/state", active: true, status: "loading" });
          const threshold = getStoredWakeThreshold(context);
          await startWakeWordListener(
            context.extensionUri.fsPath,
            {
              onReady: () => {
                post(webview, { type: "wake/state", active: true, status: "listening" });
              },
              onWake: () => {
                // Wake word detected — tell webview we're recording
                post(webview, { type: "voice/recording", active: true });
                post(webview, { type: "wake/state", active: true, status: "recording" });
              },
              onRecordingDone: async () => {
                // Silence after speech — transcribe and chat
                try {
                  const wav = collectWakeAudio();
                  post(webview, { type: "voice/recording", active: false });
                  post(webview, { type: "wake/state", active: true, status: "listening" });
                  if (wav.length < 1000) return;
                  const text = await transcribe(wav);
                  if (!text.trim()) return;
                  post(webview, { type: "voice/transcript", text });
                  await handleChat(webview, userId, text, "voice");
                } catch (err) {
                  const errMsg = err instanceof Error ? err.message : String(err);
                  post(webview, { type: "voice/error", error: errMsg });
                }
              },
              onError: (err) => {
                post(webview, { type: "wake/state", active: false });
                post(webview, { type: "voice/error", error: err });
              },
            },
            threshold
          );
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          post(webview, { type: "voice/error", error: errMsg });
        }
      }
    }
  });

  return vscode.Disposable.from(
    sub,
    new vscode.Disposable(() => mountedWebviews.delete(webview))
  );
}

async function sendInitialState(webview: vscode.Webview, userId: string) {
  // Send current active file info (using sticky last-real-editor)
  const editor = getActiveFileEditor();
  webview.postMessage({
    type: "file/active",
    file: editor
      ? { path: editor.document.fileName, language: editor.document.languageId }
      : null,
  } satisfies HostToWebview);

  // Sync the Live Review toggle so the button reflects the real backend state
  webview.postMessage({
    type: "liveReview/state",
    active: isLiveReviewActive(),
  } satisfies HostToWebview);

  // Sync on-device model status so the AI Engine selector reflects real state
  const modelStatus = getOnDeviceStatus();
  webview.postMessage({
    type: "ai/modelStatus",
    ready: modelStatus.ready,
    loading: modelStatus.loading,
    error: modelStatus.error,
    downloadProgress: modelStatus.downloadProgress,
  } satisfies HostToWebview);

  // Send current Code IQ
  try {
    const me = await fetchMe(userId);
    webview.postMessage({
      type: "iq/update",
      codeIq: me.codeIq,
      maxIq: me.maxIq,
      bonusIq: me.bonusIq,
      totalConcepts: me.totalConcepts,
      ruleCount: me.ruleCount,
      topConcepts: me.topConcepts,
      clusters: me.clusters,
      recentGains: me.recentGains,
      streak: me.streak,
      dailyIq: me.dailyIq,
      milestones: me.milestones,
      recommendations: me.recommendations,
      pillars: me.pillars,
      level: me.level,
      synergies: me.synergies,
      velocity: me.velocity,
      breakdown: me.breakdown,
      iqV2: me.iqV2,
    } satisfies HostToWebview);
  } catch {
    // backend may be offline
  }
}

function post(webview: vscode.Webview, msg: HostToWebview) {
  webview.postMessage(msg);
}

/** Builds a natural-sounding synthetic user prompt that maps a nudge → Claude request. */
function buildEngagePrompt(
  triggerId: string,
  ctx: { filePath?: string; errorMessage?: string; errorLine?: number; concept?: string; note?: string }
): string {
  switch (triggerId) {
    case "error_persists":
      return `I've got this error stuck in ${ctx.filePath ?? "my file"} on line ${ctx.errorLine ?? "?"}: "${ctx.errorMessage ?? ""}". Can you look at it and teach me what's going on?`;
    case "struggle_cluster":
      return `I've been going back and forth on ${ctx.filePath ?? "this file"} — can you read it and tell me what I'm overthinking?`;
    case "stare_pause":
      return `I'm stuck on ${ctx.filePath ?? "this"}. Take a look and help me figure out where to go next.`;
    case "build_fail_loop":
      return `I keep saving ${ctx.filePath ?? "this file"} with errors. Can you trace through what's happening and explain it?`;
    case "commit_risk":
      return `I'm about to commit a bunch of files with no tests touched. Can you suggest a quick test for the main thing that changed?`;
    case "late_night_marathon":
      return `It's late and I've been at this a while. Can you write a quick resume-here summary of what I've been working on so I can pick it back up tomorrow?`;
    case "risky_edit":
      return `I just made a big change across several files. Can you review the diff and flag anything suspicious?`;
    default:
      return `Protege noticed something (${triggerId}) — can you take a look and help me?`;
  }
}

/** Trigger phrases that promote a voice chat into "teaching mode" — Claude
 *  responds with a sequence of teach_step calls (highlight + narration)
 *  instead of a single prose reply. Conservative on purpose: only clear
 *  pedagogical asks match, so casual Q&A keeps its current rhythm. */
const TEACH_INTENT_RE =
  /\b(teach me|walk me through|show me how|explain this|explain that|explain it|break this down|break it down|help me understand|tutor me|how does this work|step by step)\b/i;

async function handleChat(
  webview: vscode.Webview,
  userId: string,
  message: string,
  mode: "text" | "voice" | "teaching"
) {
  // Auto-promote to teaching mode when the user asks to be taught — but
  // only when we're already in voice mode (teaching is a voice-only UX;
  // it requires TTS to pace the highlights).
  let effectiveMode: "text" | "voice" | "teaching" = mode;
  if (mode === "voice" && TEACH_INTENT_RE.test(message)) {
    effectiveMode = "teaching";
  }

  // Wipe any lingering highlight decorations from a previous turn. The
  // model may paint new ones during this run via highlight_code, but we
  // always start each turn on a fresh canvas — fixes the "highlights stay
  // forever" UX bug.
  clearAllHighlights().catch(() => {});

  // Create the user message for persistence
  const userMsg: ChatMessage = {
    id: crypto.randomUUID(),
    role: "user",
    content: message,
    createdAt: new Date().toISOString(),
  };

  post(webview, { type: "chat/loading", loading: true });

  try {
    const reply = await runChat(
      userId,
      message,
      {
        onTool: (call, status) => {
          post(webview, {
            type: "chat/tool",
            name: call.name,
            args: call.arguments,
            status,
          });
        },
      },
      { mode: effectiveMode }
    );
    const assistant: ChatMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: reply,
      createdAt: new Date().toISOString(),
    };
    post(webview, { type: "chat/append", message: assistant });

    // Persist both user + assistant messages to globalState
    appendMessage(userMsg);
    appendMessage(assistant);

    // JARVIS: Route the reply through the Smart Response Router.
    // This highlights relevant code in the editor, shows apply-fix
    // notifications, and flashes the status bar — all automatically
    // based on what Claude said.
    try {
      const editor = getActiveFileEditor();
      const fileContent = editor?.document.getText();
      const result = classifyResponse(reply, fileContent);
      if (result.kind !== "general" && editor) {
        dispatchRouterActions(result, editor, reply);
      }
    } catch {
      // Router failures are non-fatal — chat still works fine
    }
  } catch (err) {
    post(webview, {
      type: "chat/error",
      error: err instanceof Error ? err.message : "Unknown error",
    });
  } finally {
    post(webview, { type: "chat/loading", loading: false });
  }
}

function renderHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  mode: vscode.ExtensionMode
): string {
  // In the F5 Extension Development Host the webview loads from the Vite
  // dev server so HMR updates React/CSS changes in ~100ms without a full
  // panel reload. Installed extensions always take the bundled path below.
  if (isDevMode(mode)) return renderDevHtml(webview, "main");

  const base = vscode.Uri.joinPath(extensionUri, "dist", "webview");
  // Webview-safe URI for the dist/webview/ directory. Using this as the
  // <base href> makes every relative asset import inside the bundled JS
  // (e.g. "./assets/cathedral.png") resolve through VS Code's resource
  // protocol, so cinematic photos actually load.
  const baseUri = webview.asWebviewUri(base) + "/";
  // Vite emits these names because vite.config.mts uses a named multi-entry
  // input map ({ main, echo }). Keep in sync if the entry key changes.
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(base, "assets", "main.js")
  );
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(base, "assets", "main.css")
  );
  const nonce = getNonce();
  // `wasm-unsafe-eval` is required for Shiki's Oniguruma grammar engine
  // (TextMate regex compiled to WebAssembly). Without it the webview's
  // CSP silently kills the syntax-highlight pipeline and every code block
  // renders as monochrome plain text.
  const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline' https://fonts.googleapis.com; script-src 'nonce-${nonce}' 'wasm-unsafe-eval'; img-src ${webview.cspSource} data: blob:; font-src ${webview.cspSource} https://fonts.gstatic.com; connect-src ${webview.cspSource} http://localhost:8787 http://127.0.0.1:8787; media-src ${webview.cspSource} blob: data: http://localhost:8787 http://127.0.0.1:8787;`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<base href="${baseUri}" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<link rel="stylesheet" href="${styleUri}" />
<title>Protege</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
}

function getNonce() {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++)
    out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
