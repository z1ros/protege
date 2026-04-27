import * as vscode from "vscode";
import type {
  WebviewToHost,
  HostToWebview,
  ChatMessage,
  Finding,
} from "@protege/types";
import { currentUserIdOrNull, fetchMe } from "../user/protegeClient.js";
import { getGitHubUser, isSignedIn, onAuthChange, signOut } from "../user/auth.js";
import { runChat } from "./chatRunner.js";
import { getActiveFileEditor } from "../workspace/activeFile.js";
import { classifyResponse, dispatchRouterActions } from "./responseRouter.js";
import { getHistory, appendMessage, searchHistory, clearHistory } from "./chatHistory.js";
import { clearAllHighlights } from "../ai/tools.js";
import { isLiveReviewActive } from "../review/liveReview.js";
import { getOnDeviceStatus, onStatusChange } from "../ai/onDeviceModel.js";
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
  triggerFollowUp,
} from "../voice/voiceCapture.js";
import {
  getStoredWakeThreshold,
  getWakeEnabled,
  setWakeEnabled,
} from "../voice/wakeWordCalibration.js";
import { setVoiceState, flashVoiceError } from "../voice/voiceStatusBar.js";
import { shapeTask, buildShapeContext, verifyUnderstanding } from "../intent/index.js";
import { devPortMapping, isDevMode, renderDevHtml } from "../devMode.js";
import {
  handleEchoRpc,
  registerEchoBroadcastTarget,
  type PanelState as EchoPanelState,
} from "../echo/panel.js";
import type { EchoHostToWebview } from "@protege/types";

/**
 * Registry so outside code (analyzer, status bar) can broadcast messages
 * (like "iq/update") into every mounted Protege webview.
 */
const mountedWebviews = new Set<vscode.Webview>();
let speakingDeadman: ReturnType<typeof setTimeout> | null = null;
// Tracks whether the turn that just spoke was a voice-channel turn — drives
// the conversational follow-up (auto-open mic after bot stops). Set in
// handleChat when shouldSpeak fires, consumed when voice/speaking:false
// arrives. Reset afterwards so text-mode turns that happen between voice
// sessions don't spuriously trigger follow-ups.
let pendingFollowUpMode: "voice" | "voice-dialogue" | null = null;
// Transient flag: strip any <learningFork> tag from the next reply and
// skip fallback injection. Set when we fire a synthetic "Just do it"
// follow-up so the confirmation reply ("Done — changed X to Y") doesn't
// re-offer the fork. Self-clearing: reset inside handleChat after one turn.
let suppressNextFork = false;

/**
 * Understanding-Check clarifier continuity. When the verifier returns
 * `action: "clarify"` we send one question to the user and park the
 * conversation here. The NEXT user message is treated as the reply; we
 * rerun verify with forceProceed=true on the combined (original +
 * clarifier + reply) so the verifier MUST pick answer/offer-learn/offer-do.
 *
 * Expires in 3 min so an ignored clarifier doesn't hijack a fresh turn
 * 30 minutes later. See plans/understanding-check.md §5.
 */
interface PendingClarifier {
  originalMessage: string;
  clarifier: string;
  expiresAt: number;
}
let pendingClarifier: PendingClarifier | null = null;
const CLARIFIER_TTL_MS = 3 * 60 * 1000;
/** Should the mic auto-open after the bot's reply finishes? True only if
 *  the turn was explicitly a voice channel AND wake is still enabled. */
function shouldTriggerFollowUp(): boolean {
  if (!pendingFollowUpMode) return false;
  pendingFollowUpMode = null; // consume
  return isWakeWordListening();
}

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

// Build-intent: the user wants to ADD / IMPLEMENT / INTEGRATE something.
// Teach-intent: the user asked to be taught something buildable.
// Regex list is the one in learning-mode-fork-integration.md §2. The
// 8-char floor filters out action commands like "fix it", "do it",
// which are go-signals, not build requests.
// Fork-specific intent regexes — distinct from the (legacy) TEACH_INTENT_RE
// below which promotes a turn to "teaching" mode. Fork-intent is broader:
// any buildable ask qualifies for the Just-do-it / Learn-with-me offer.
const FORK_BUILD_RE =
  /\b(add|build|implement|create|make|wire up|hook up|set up|integrate|refactor|convert|migrate|extract|rewrite)\b/i;
const FORK_TEACH_RE =
  /\b(teach me|walk me through|show me how|how do i|how would i|help me (?:use|add|build|implement))\b/i;
function hasBuildOrTeachIntent(message: string): boolean {
  if (message.length < 8) return false;
  return FORK_BUILD_RE.test(message) || FORK_TEACH_RE.test(message);
}

/** Explicit teach-me intent — user unambiguously wants Learning Mode, no
 *  fork chip needed, no verifier clarifier loop. Matches phrasings that
 *  START with a pedagogical verb. "set a timer teach me" doesn't match
 *  (teach-me buried in the middle is softer intent); "teach me set a
 *  timer" does. When this fires, we auto-start `protege.learning.start`
 *  with the whole message as the goal and skip the chat pipeline. */
const EXPLICIT_TEACH_RE =
  /^(teach me|walk me through|show me how to|show me how|tutor me|walk through)\b/i;
function isExplicitTeachAsk(message: string): boolean {
  const trimmed = message.trim();
  if (trimmed.length < 10) return false; // "teach me X" needs a topic
  return EXPLICIT_TEACH_RE.test(trimmed);
}

function findLastAssistantReply(): string | null {
  const hist = getHistory();
  for (let i = hist.length - 1; i >= 0; i--) {
    if (hist[i].role === "assistant") return hist[i].content;
  }
  return null;
}

/** Detect when Whisper's transcript is really the bot's last reply
 *  echoing back through the speakers. Uses Jaccard similarity on
 *  normalized word sets — self-echo lands around 0.8–1.0, real
 *  follow-ups like "yes, do it" sit well under 0.2. Short transcripts
 *  (<20 chars) bypass the check so quick "yes"/"no"/"stop" commands
 *  always get through even when their few words happen to appear in
 *  the bot's reply. */
function looksLikeEcho(transcript: string, lastAssistant: string): boolean {
  if (transcript.length < 20) return false;
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[`*_~\[\](){}<>"']/g, " ")
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3);
  const t = new Set(norm(transcript));
  const a = new Set(norm(lastAssistant));
  if (t.size === 0 || a.size === 0) return false;
  let inter = 0;
  for (const w of t) if (a.has(w)) inter++;
  const union = t.size + a.size - inter;
  const jaccard = inter / union;
  return jaccard >= 0.5;
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

  // Login-first: track the userId in a let-binding kept in sync with the
  // GitHub session via the authState change feed. Pre-auth it's "" — every
  // backend-touching handler MUST gate on `requireUserIdOrToast()` (or its
  // null-returning sibling) before sending. Sign-in mid-session updates
  // the binding so subsequent handlers see the real id without remounting.
  let userId: string = currentUserIdOrNull() ?? "";
  const resolveUserId = (): string | null => currentUserIdOrNull();
  const requireUserIdOrToast = (): string | null => {
    const id = resolveUserId();
    if (!id) {
      try {
        webview.postMessage({
          type: "chat/error",
          error: "Sign in with GitHub to use Protege.",
        } satisfies HostToWebview);
      } catch {
        /* webview disposed */
      }
    }
    return id;
  };
  const offAuth = onAuthChange((snap) => {
    userId = snap.user?.githubId ?? "";
    try {
      webview.postMessage({
        type: "auth/user",
        user: snap.user
          ? {
              githubId: snap.user.githubId,
              login: snap.user.login,
              email: snap.user.email,
              avatarUrl: snap.user.avatarUrl,
            }
          : null,
      } satisfies HostToWebview);
    } catch {
      /* webview disposed */
    }
  });

  // Echo RPC bridge: the main webview hosts Echo inline (see EchoTab). The
  // post callback wraps every outgoing Echo message in an `echo/msg`
  // envelope on the shared HostToWebview channel. Registering as a
  // broadcast target lets host-side event streams (commit enrichment,
  // scan status) fan out here too.
  const echoState: EchoPanelState = { currentWindow: "today", context };
  const echoPost = (payload: EchoHostToWebview): void => {
    try {
      webview.postMessage({ type: "echo/msg", payload } satisfies HostToWebview);
    } catch {
      // Webview disposed between fan-out and delivery; ignore.
    }
  };
  const unregisterEcho = registerEchoBroadcastTarget(echoPost);

  const sub = webview.onDidReceiveMessage(async (msg: WebviewToHost) => {
    if (msg.type === "chat/send") {
      // Intercept teaching flow follow-up chips
      const text = msg.message.trim().toLowerCase();
      if (text === "next step →" || text === "next step") {
        const { advanceFlow, isFlowActive } = await import("../teaching/teachingFlow.js");
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
      const sendId = requireUserIdOrToast();
      if (!sendId) return;
      await handleChat(
        webview,
        sendId,
        msg.message,
        msg.mode ?? "text",
        msg.contextMessages
      );
    } else if (msg.type === "ready") {
      sendInitialState(webview, resolveUserId());

      // Hydrate the AI backend choice + last-call info so the Live tab
      // reflects persisted state instead of defaulting to "auto".
      const { getAiBackend, getLastCall } = await import("../ai/aiBackend.js");
      post(webview, { type: "ai/backend", backend: getAiBackend() });
      // Hydrate the current explain mode so the Live tab's 3-option
      // toggle reflects the persisted setting on mount.
      const modeVal = vscode.workspace
        .getConfiguration("protege")
        .get<string>("explainMode", "text");
      const mode = (modeVal === "voice" || modeVal === "both" ? modeVal : "text") as
        | "text"
        | "voice"
        | "both";
      post(webview, { type: "explainMode/state", mode });
      // Hydrate an in-flight Architecture Tour if one's running — the
      // session strip needs to reappear when the user re-opens the
      // sidebar. Idempotent; `null` means no active tour.
      const { getCurrentTour } = await import("../teaching/architectureTour.js");
      post(webview, { type: "tour/state", state: getCurrentTour() });
      // Same for explain-back — survives sidebar close/reopen mid-session.
      const { getCurrentExplainBack } = await import("../teaching/explainBack.js");
      post(webview, {
        type: "explainBack/state",
        state: getCurrentExplainBack(),
      });
      // And for Learning Mode — without this hydration, reloading the
      // sidebar during an active session would unmount the panel
      // (webview receives null) and the user's plan appears abandoned
      // even though the host still has the session.
      const { getCurrentSession } = await import("../teaching/learningMode.js");
      post(webview, {
        type: "learning/state",
        state: getCurrentSession(),
      });
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

      // Fresh-chat-on-open policy (2026-04-23): the webview always
      // starts with an empty main chat when Cursor/VS Code is reopened
      // or the panel remounts. The full persisted history stays in
      // globalState and is still reachable via the history icon (which
      // fetches through `chat/getFullHistory` below) — clicking an old
      // conversation there restores it into the main view. Users
      // wanted a clean slate every time they open Protege, not a
      // silent auto-restore of whatever they were last mid-asking.
      //
      // We intentionally do NOT post `chat/history` here. The webview's
      // `messages` state starts as [] and stays that way until the user
      // opens the history panel and clicks a past conversation.

      // Auto-resume the wake-word listener if the user had it on before
      // reloading. Defaults to TRUE for new users so voice-first is the
      // out-of-box experience. Fires on the first webview ready — no-op
      // for any subsequent webview since the listener is a singleton.
      if (getWakeEnabled(context)) {
        void startGlobalWakeListener(context, userId);
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
    } else if (msg.type === "auth/logout") {
      // In-app sign-out. Confirmation runs host-side because
      // `window.confirm` is blocked inside VS Code webviews and returns
      // undefined silently — confirming there would no-op the click.
      const choice = await vscode.window.showWarningMessage(
        "Sign out of Protege? Your data stays in the cloud — you can sign back in anytime.",
        { modal: true },
        "Sign out"
      );
      if (choice !== "Sign out") return;
      // Clears our cached user and persists the opt-out flag so we don't
      // silently re-hydrate from VS Code's still-live GitHub session on
      // the next activation. The `onAuthChange` listener wired above
      // broadcasts `auth/user: null` to every mounted webview, which
      // flips the gate on across all open panels at once.
      await signOut();
      // Hint about the Accounts panel — only way to fully revoke the
      // underlying GitHub OAuth session.
      void vscode.window.showInformationMessage(
        "Signed out of Protege. To revoke your GitHub session in VS Code entirely, open the Accounts panel (bottom-left) → GitHub → Sign Out."
      );
    } else if (msg.type === "watcher/engage") {
      // User clicked "Help me" on a proactive nudge — escalate to Claude
      const id = requireUserIdOrToast();
      if (!id) return;
      const synthetic = buildEngagePrompt(msg.triggerId, msg.context);
      await handleChat(webview, id, synthetic, "text");
    } else if (msg.type === "scan/request") {
      vscode.commands.executeCommand("protege.scanActiveFile");
    } else if (msg.type === "liveReview/toggle") {
      vscode.commands.executeCommand("protege.toggleLiveReview");
    } else if (msg.type === "echo/open") {
      vscode.commands.executeCommand("protege.openEcho");
    } else if (msg.type === "echo/msg") {
      const id = resolveUserId();
      if (!id) {
        echoPost({ type: "echo_authRequired" });
        return;
      }
      await handleEchoRpc(echoPost, id, msg.payload, echoState, context);
    } else if (msg.type === "chat/search") {
      const results = searchHistory(msg.query);
      post(webview, { type: "chat/searchResults", results });
    } else if (msg.type === "chat/getFullHistory") {
      // On-demand read of the full persisted history — used by the
      // history panel so it always shows everything in globalState,
      // not just what's currently in the webview's `messages` state.
      // After "New chat" the local state is empty but globalState
      // still carries the full record; this round-trip is what makes
      // the panel honest about that.
      post(webview, { type: "chat/fullHistory", messages: getHistory() });
    } else if (msg.type === "chat/clearHistory") {
      clearHistory();
      post(webview, { type: "chat/history", messages: [] });
    } else if (msg.type === "debug/log") {
      const { log } = await import("../log.js");
      log(msg.tag, msg.message);
      // Also stream to stdout so the extension-host tsx watch terminal
      // shows the line in real time (same stream as [protege-wake] logs).
      // eslint-disable-next-line no-console
      console.log(`[protege-${msg.tag}] ${msg.message}`);
    } else if (msg.type === "feature/toggle") {
      if (msg.feature === "inlineErrors") {
        const { setInlineErrorsEnabled } = await import("../review/inlineErrors.js");
        setInlineErrorsEnabled(msg.enabled);
      } else if (msg.feature === "didYouKnow") {
        const { setDidYouKnowEnabled } = await import("../hints/didYouKnow.js");
        setDidYouKnowEnabled(msg.enabled);
      }
    } else if (msg.type === "ai/setBackend") {
      const { setAiBackend } = await import("../ai/aiBackend.js");
      setAiBackend(msg.backend);
      // Echo the persisted value back so the webview reflects the
      // authoritative host state (and so new panels in parallel hydrate).
      post(webview, { type: "ai/backend", backend: msg.backend });
    } else if (msg.type === "explainMode/set") {
      // Persist to the `protege.explainMode` VS Code setting. The
      // onDidChangeConfiguration listener in extension.ts will broadcast
      // `explainMode/state` back to ALL mounted webviews so any open
      // sidebar mirrors the change.
      await vscode.workspace
        .getConfiguration("protege")
        .update("explainMode", msg.mode, vscode.ConfigurationTarget.Global);
    } else if (msg.type === "map/request") {
      // Project Map tab (A1) — file tree + git signals + entry points.
      const { collectProjectMap } = await import("../workspace/projectMap.js");
      const data = await collectProjectMap();
      post(webview, { type: "map/data", data });
    } else if (msg.type === "map/fileSummary") {
      // MAP tab — fetch (or pull from cache) a 2-sentence summary.
      const { getFileSummary } = await import("../workspace/projectMap.js");
      const summary = await getFileSummary(msg.path);
      post(webview, { type: "map/fileSummaryResult", path: msg.path, summary });
    } else if (msg.type === "map/openFile") {
      // MAP tab — "Open file" button.
      const { openMapFile } = await import("../workspace/projectMap.js");
      await openMapFile(msg.path);
    } else if (msg.type === "tour/start") {
      // Architecture Tour (A2) — kick off a codebase walkthrough.
      const { startTour } = await import("../teaching/architectureTour.js");
      await startTour(msg.intent);
    } else if (msg.type === "tour/next") {
      const { advanceTour } = await import("../teaching/architectureTour.js");
      await advanceTour();
    } else if (msg.type === "tour/stop") {
      const { stopTour } = await import("../teaching/architectureTour.js");
      await stopTour();
    } else if (msg.type === "explainBack/submit") {
      const { submitExplanation } = await import("../teaching/explainBack.js");
      await submitExplanation(msg.explanation);
    } else if (msg.type === "explainBack/stop") {
      const { stopExplainBack } = await import("../teaching/explainBack.js");
      await stopExplainBack();
    } else if (
      msg.type === "learning/done" ||
      msg.type === "learning/hint" ||
      msg.type === "learning/show" ||
      msg.type === "learning/stop"
    ) {
      // Each of these simply routes the webview click to its command.
      // Wrapped so a failed executeCommand (module deactivation race,
      // command not yet registered during startup) doesn't kill the
      // message loop silently — the user would see a dead button.
      const cmd =
        msg.type === "learning/done"
          ? "protege.learning.done"
          : msg.type === "learning/hint"
            ? "protege.learning.hint"
            : msg.type === "learning/show"
              ? "protege.learning.show"
              : "protege.learning.stop";
      try {
        await vscode.commands.executeCommand(cmd);
      } catch (err) {
        console.warn(
          `[protege] ${cmd} failed:`,
          err instanceof Error ? err.message : String(err)
        );
        vscode.window.showErrorMessage(
          `Protege: couldn't run ${cmd}. Try reloading the window.`
        );
      }
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
      const id = requireUserIdOrToast();
      if (!id) return;
      const url = `http://localhost:8787/voice?userId=${encodeURIComponent(id)}`;
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
            const id = requireUserIdOrToast();
            if (!id) return;
            await handleChat(webview, id, text, "voice");
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
        const id = requireUserIdOrToast();
        if (!id) return;
        await handleChat(webview, id, text, "voice");
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
        const { resolvePlayback } = await import("../teaching/teachingStep.js");
        resolvePlayback(msg.requestId, msg.reason);
      } else {
        const { onVoicePlaybackDone } = await import("../hints/ghostMentor.js");
        void onVoicePlaybackDone(msg.reason);
      }
    } else if (msg.type === "voice/speaking") {
      // Bot starts speaking → fully suspend the wake listener. No wake
      // events, no recordings. Bot voice bleeding back through the mic
      // cannot self-trigger the loop ("Oh yeah you brought the book…").
      // Bot finishes → wait 500ms for speaker decay, then un-suspend.
      //
      // Deadman timer: if the :true arrives but :false never does
      // (webview crash, audio element stuck, handler race), the wake
      // listener would stay suspended forever and the user can't talk
      // to the agent again until reload. Clear on every :true, fire at
      // 30s as a forced resume.
      const active = !!msg.active;
      setStrictWakeMode(active);
      setVoiceState(active ? "speaking" : "idle");
      if (active) {
        setWakeSuspended(true);
        if (speakingDeadman) clearTimeout(speakingDeadman);
        speakingDeadman = setTimeout(() => {
          console.warn(
            "[protege] voice/speaking deadman fired — resuming wake listener after 30s with no :false"
          );
          setStrictWakeMode(false);
          setVoiceState("idle");
          setWakeSuspended(false);
          speakingDeadman = null;
        }, 30000);
      } else {
        if (speakingDeadman) {
          clearTimeout(speakingDeadman);
          speakingDeadman = null;
        }
        setTimeout(() => {
          setWakeSuspended(false);
          // Conversational follow-up: if the turn that just finished was
          // voice / voice-dialogue, auto-open the mic for a reply without
          // requiring the user to say "protege" again. Matches what the
          // VOICE_DIALOGUE_MODE prompt promises ("mic opens after each of
          // your sentences"). If the user stays silent, the binary's VAD
          // + 12s safety cap close the window and we return to wake mode.
          if (shouldTriggerFollowUp()) {
            const ok = triggerFollowUp();
            console.log(`[protege] voice follow-up triggered ok=${ok}`);
          }
        }, 500);
      }
    } else if (msg.type === "wake/toggle") {
      const id = requireUserIdOrToast();
      if (!id) return;
      await toggleGlobalWake(context, id);
    } else if (msg.type === "learning/forkChosen") {
      if (msg.choice === "learn") {
        // Fire Learning Mode with the user's original ask as the
        // pre-filled goal — bypasses the InputBox. The learningMode
        // command does its own active-editor guarding + "mode disabled"
        // guard, so we don't duplicate checks here.
        await vscode.commands.executeCommand("protege.learning.start", {
          goal: msg.goal,
        });
      } else {
        // "Just do it" — synthesize a follow-up user turn so the bot
        // actually performs the change. `suppressNextFork` blocks the
        // fork fallback from re-injecting on the confirmation reply
        // (otherwise the LLM's "Done — changed X" reply would get a
        // fresh fork since the synthetic message contains "implement").
        // CORE_PERSONA's "don't re-ask" rule makes Claude act instead
        // of asking "are you sure".
        const id = requireUserIdOrToast();
        if (!id) return;
        suppressNextFork = true;
        const synthetic = `Yes, go ahead — please ${msg.goal}. Apply the changes directly.`;
        await handleChat(webview, id, synthetic, "text");
      }
    }
  });

  return vscode.Disposable.from(
    sub,
    new vscode.Disposable(unregisterEcho),
    new vscode.Disposable(offAuth),
    new vscode.Disposable(() => mountedWebviews.delete(webview))
  );
}

async function sendInitialState(webview: vscode.Webview, userId: string | null) {
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

  // Send current Code IQ — only when signed in. Pre-auth this is a no-op;
  // the gate UI in the webview is what the user sees instead.
  if (!userId) return;
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

/** Wait briefly for a Protege webview to mount. Called after we reveal
 *  the launcher when the user closed the sidebar but wake still needs a
 *  panel to play TTS through. */
async function ensureWebviewMounted(timeoutMs = 1500): Promise<vscode.Webview | null> {
  if (mountedWebviews.size > 0) return [...mountedWebviews][0]!;
  vscode.commands
    .executeCommand("protege.launcher.focus")
    .then(undefined, () => {});
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (mountedWebviews.size > 0) return [...mountedWebviews][0]!;
    await new Promise((r) => setTimeout(r, 80));
  }
  return mountedWebviews.size > 0 ? [...mountedWebviews][0]! : null;
}

/** Toggle the wake-word listener on/off. Called both from the webview
 *  ("Protege ON" chip in VoiceMode) and the status bar item, so both
 *  surfaces stay in sync. Broadcasts the new state so any mounted
 *  webview updates its chip, and sets the status bar to "off" when
 *  turning off — startGlobalWakeListener handles the "on" transition. */
export async function toggleGlobalWake(
  context: vscode.ExtensionContext,
  userId: string
): Promise<void> {
  if (isWakeWordListening()) {
    stopWakeWordListener();
    broadcast({ type: "wake/state", active: false });
    await setWakeEnabled(context, false);
    setVoiceState("off");
  } else {
    await setWakeEnabled(context, true);
    await startGlobalWakeListener(context, userId);
  }
}

/** Boot the wake-word listener GLOBALLY — not tied to a specific webview.
 *  Every callback uses `broadcast()` so events reach whichever Protege
 *  panels happen to be mounted at the moment — including panels mounted
 *  AFTER the listener started. If the user closed the sidebar and wake
 *  fires, we reveal the launcher so there's a panel to play audio.
 *  Idempotent — safe to call multiple times. */
export async function startGlobalWakeListener(
  context: vscode.ExtensionContext,
  userId: string
): Promise<void> {
  if (isWakeWordListening()) {
    broadcast({ type: "wake/state", active: true, status: "listening" });
    return;
  }
  try {
    broadcast({ type: "wake/state", active: true, status: "loading" });
    const threshold = getStoredWakeThreshold(context);
    await startWakeWordListener(
      context.extensionUri.fsPath,
      {
        onReady: () => {
          broadcast({ type: "wake/state", active: true, status: "listening" });
          setVoiceState("idle");
        },
        onWake: () => {
          // Sidebar closed? Reveal it so the reply has somewhere to play.
          if (mountedWebviews.size === 0) {
            vscode.commands
              .executeCommand("protege.launcher.focus")
              .then(undefined, () => {});
          }
          broadcast({ type: "voice/recording", active: true });
          broadcast({ type: "wake/state", active: true, status: "recording" });
          setVoiceState("listening");
        },
        onRecordingDone: async () => {
          try {
            const wav = collectWakeAudio();
            broadcast({ type: "voice/recording", active: false });
            broadcast({ type: "wake/state", active: true, status: "listening" });
            if (wav.length < 1000) {
              setVoiceState("idle");
              return;
            }
            setVoiceState("thinking");
            broadcast({ type: "voice/fillerPlay" });
            const text = await transcribe(wav);
            if (!text.trim()) {
              setVoiceState("idle");
              return;
            }
            // Echo guard: if the mic picked up the bot's own voice through
            // speakers (wake suspension failed or was too slow), Whisper
            // returns a transcript that mirrors the last assistant reply.
            // Drop it before it becomes a new chat turn and loops forever.
            const lastAssistant = findLastAssistantReply();
            if (lastAssistant && looksLikeEcho(text, lastAssistant)) {
              console.log(
                `[protege] echo detected — transcript matches last assistant reply (${text.length}ch). Dropped.`
              );
              setVoiceState("idle");
              return;
            }
            broadcast({ type: "voice/transcript", text });
            const target = await ensureWebviewMounted();
            if (!target) {
              broadcast({
                type: "voice/error",
                error: "Open the Protege panel so the reply can play.",
              });
              flashVoiceError();
              return;
            }
            // Resolve userId at fire time — the wake listener may have been
            // started under a stale id that has since signed out.
            const liveId = currentUserIdOrNull();
            if (!liveId) {
              broadcast({ type: "voice/error", error: "Sign in with GitHub to use voice." });
              flashVoiceError();
              setVoiceState("idle");
              return;
            }
            await handleChat(target, liveId, text, "voice");
            // Speaking→idle transition is driven by voice/speaking:false
            // below when TTS playback ends. Leaving state alone here.
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            broadcast({ type: "voice/error", error: errMsg });
            flashVoiceError();
          }
        },
        onError: (err) => {
          broadcast({ type: "wake/state", active: false });
          broadcast({ type: "voice/error", error: err });
          flashVoiceError();
        },
      },
      threshold
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    broadcast({ type: "voice/error", error: errMsg });
  }
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
  mode: "text" | "voice" | "voice-dialogue" | "teaching",
  contextMessages?: ChatMessage[]
) {
  // --- Explicit "teach me X" short-circuit (fork chip redundant) ---
  // When the user unambiguously says "teach me X", skip the verifier
  // clarifier dance and the fork chip — they told us what they want.
  // Auto-fire `protege.learning.start`; Learning panel takes over.
  //
  // Gates: text input only (voice-mode Learning is a separate UX),
  // active editor present, not a clarifier reply to a prior question
  // (that would cause a double-start), message isn't a synthetic
  // "just do it" turn (suppressNextFork already in flight).
  const voiceInput =
    mode === "voice" || mode === "voice-dialogue" || mode === "teaching";
  const hasActiveEditorForShortcut =
    !!vscode.window.activeTextEditor &&
    vscode.window.activeTextEditor.document.uri.scheme === "file";
  const isClarifierReply =
    pendingClarifier !== null && pendingClarifier.expiresAt > Date.now();
  if (
    isExplicitTeachAsk(message) &&
    !voiceInput &&
    hasActiveEditorForShortcut &&
    !isClarifierReply &&
    !suppressNextFork
  ) {
    const { log } = await import("../log.js");
    log("learning", `auto-start on explicit teach-me: "${message.slice(0, 80)}"`);
    // Persist the user's message + show a one-line assistant ack so the
    // chat thread still has a coherent record of what happened. The
    // Learning panel takes over the sidebar content, but the chat is
    // still there behind it.
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: message,
      createdAt: new Date().toISOString(),
      source: "text",
    };
    appendMessage(userMsg);
    const ack: ChatMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: `Starting Learning Mode — I'll walk you through this step by step.`,
      createdAt: new Date().toISOString(),
      source: "text",
    };
    broadcast({ type: "chat/append", message: ack });
    appendMessage(ack);
    // Fire the command. It does its own active-editor / enabled /
    // concurrency-guard checks; if any fail it shows its own error.
    await vscode.commands.executeCommand("protege.learning.start", {
      goal: message,
    });
    return; // short-circuit — no runChat, no fork, no verify
  }

  // --- Task-shaping classifier (plans/task-shaping.md Phase 1) ---
  // Runs BEFORE the chat pipeline. Its output decides routing: whether
  // to promote modes, whether to offer a fork chip later, etc. Cheap —
  // regex covers the common case with sub-ms latency; LLM tier only
  // fires on ambiguous messages.
  const shapeContext = buildShapeContext({
    history: getHistory(),
    currentMode: mode,
    wakeActive: isWakeWordListening(),
  });
  const shape = await shapeTask(message, shapeContext);

  // --- Understanding Check (plans/understanding-check.md) ---
  // If the previous turn sent a clarifier and it's still live, combine
  // original + clarifier + this reply into a single context string so
  // the verifier sees the full thread — not just the two-word reply.
  let verifyMessage = message;
  let verifyForceProceed = false;
  const now = Date.now();
  if (pendingClarifier && pendingClarifier.expiresAt > now) {
    verifyMessage =
      `(User originally asked: ${pendingClarifier.originalMessage})\n` +
      `(Protege clarified: ${pendingClarifier.clarifier})\n` +
      `User reply: ${message}`;
    verifyForceProceed = true;
    pendingClarifier = null; // consume
  } else if (pendingClarifier) {
    // Expired — drop it so it doesn't hijack unrelated future turns.
    pendingClarifier = null;
  }
  const understanding = await verifyUnderstanding(
    verifyMessage,
    shape,
    shapeContext,
    { forceProceed: verifyForceProceed }
  );

  // Auto-promote to teaching mode when the user asks to be taught — but
  // only when we're already in a voice channel (teaching is a voice-only
  // UX; it requires TTS to pace the highlights). Both "voice" and the
  // new "voice-dialogue" can graduate to teaching on the right intent.
  let effectiveMode: "text" | "voice" | "voice-dialogue" | "teaching" = mode;
  if ((mode === "voice" || mode === "voice-dialogue") && TEACH_INTENT_RE.test(message)) {
    effectiveMode = "teaching";
  }
  // If the user typed but wake is listening, the reply will be spoken.
  // Promote to voice-dialogue so the prompt pulls a short, ear-friendly
  // reply instead of a multi-paragraph TEXT_MODE answer the TTS has to
  // read aloud for 40 seconds.
  if (effectiveMode === "text" && isWakeWordListening()) {
    effectiveMode = "voice-dialogue";
  }

  // Wipe any lingering highlight decorations from a previous turn. The
  // model may paint new ones during this run via highlight_code, but we
  // always start each turn on a fresh canvas — fixes the "highlights stay
  // forever" UX bug.
  clearAllHighlights().catch(() => {});

  // Create the user message for persistence. Stamp source from the
  // ORIGINAL mode (not effectiveMode) so voice-dialogue promotions don't
  // mislabel a typed message as "voice" in the chat history — the mic
  // glyph should only appear when the user actually spoke.
  const userMsg: ChatMessage = {
    id: crypto.randomUUID(),
    role: "user",
    content: message,
    createdAt: new Date().toISOString(),
    source:
      mode === "voice" || mode === "voice-dialogue" || mode === "teaching"
        ? "voice"
        : "text",
  };

  // Broadcast the user message ONLY for voice turns. In text mode, the
  // webview already appended the user's message optimistically when
  // sendMessage() was called — broadcasting here would duplicate it.
  // Voice transcripts originate host-side with no local append, so the
  // webview needs this broadcast to show them.
  //
  // Use `broadcast` (not `post` to a single webview) because voice can
  // originate without the user having any specific panel in focus —
  // `ensureWebviewMounted` returns the first mounted webview, which may
  // not be the one the user is looking at when multiple Protege views
  // are open (sidebar + editor tab). Broadcasting makes the conversation
  // visible wherever the user is.
  const isVoiceTurn = mode === "voice" || mode === "voice-dialogue" || mode === "teaching";
  if (isVoiceTurn) {
    broadcast({ type: "chat/append", message: userMsg });
  }

  // Persist the user's question IMMEDIATELY — before the AI call, not
  // after. Historically `appendMessage(userMsg)` lived in the success
  // branch of the try block below, which meant any AI error (network,
  // timeout, rate limit) OR any reload mid-call silently dropped the
  // user's message from globalState even though the webview had
  // already shown it optimistically. On reload, the chat history
  // panel looked like the user never asked the question.
  appendMessage(userMsg);

  // --- Understanding Check: clarify branch ---
  // Verifier decided one clarifying question would materially improve
  // the answer. Send it as a regular assistant bubble, persist it,
  // park state in `pendingClarifier` so the NEXT turn is treated as
  // the reply. Skip the entire chat pipeline — no runChat, no fork.
  if (understanding.action === "clarify" && understanding.clarifier) {
    const clarifierMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: understanding.clarifier,
      createdAt: new Date().toISOString(),
      source:
        mode === "voice" || mode === "voice-dialogue" || mode === "teaching"
          ? "voice"
          : "text",
    };
    broadcast({ type: "chat/append", message: clarifierMsg });
    appendMessage(clarifierMsg);
    pendingClarifier = {
      originalMessage: message,
      clarifier: understanding.clarifier,
      expiresAt: Date.now() + CLARIFIER_TTL_MS,
    };
    // Speak it in voice contexts — voice users expect a conversational
    // flow, not a silent text clarifier they never see. Treat this
    // exactly like a full voice reply: pre-suspend wake (so the bot's
    // spoken clarifier can't self-trigger through the speakers), flip
    // the status bar to "speaking", and arm conversational follow-up
    // so the user can speak their reply without saying "protege" again.
    const clarifierVoice =
      mode === "voice" ||
      mode === "voice-dialogue" ||
      mode === "teaching" ||
      isWakeWordListening();
    if (clarifierVoice) {
      if (isWakeWordListening()) {
        setWakeSuspended(true);
        setStrictWakeMode(true);
        setVoiceState("speaking");
        // Arm the follow-up trigger so the mic auto-opens when the
        // clarifier audio ends. Without this, the user would need to
        // say "protege" again to reply to a clarifier — exact UX bug
        // we fixed earlier for regular voice replies.
        pendingFollowUpMode = "voice-dialogue";
      }
      broadcast({ type: "voice/playExplain", text: understanding.clarifier });
    }
    broadcast({ type: "chat/loading", loading: false });
    if (!clarifierVoice && isWakeWordListening()) {
      // Text-only clarifier while wake is still listening — return the
      // status bar to idle so the user knows we're waiting on them.
      setVoiceState("idle");
    }
    return; // short-circuit the rest of handleChat
  }

  // Broadcast loading state so the typing indicator appears on every
  // mounted Protege view, not just `webview`. Same rationale as the
  // chat/append broadcast above.
  broadcast({ type: "chat/loading", loading: true });

  // Context window for the AI. Prefer `contextMessages` from the
  // webview when provided — that's the current session's visible
  // messages and respects the "New chat" clear-view-but-keep-history
  // flow. Falls back to globalState's last N when the caller doesn't
  // pass one (voice turns, watcher/engage, etc. that originate
  // host-side with no webview context snapshot).
  const HISTORY_WINDOW = 20;
  const recentHistory = (contextMessages ?? getHistory())
    .slice(-HISTORY_WINDOW)
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));

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
      { mode: effectiveMode, history: recentHistory }
    );
    // Voice / voice-dialogue always speak the terminal reply. Teaching
    // mode normally drives TTS per teach_step, but if the original turn
    // came through a voice channel (wake active OR user spoke it) AND
    // the reply has text (teach_step may not have been called at all —
    // e.g. "teach me Swiper" when Swiper isn't in the codebase, bot
    // just explains in prose), speak the terminal reply too. Without
    // this, user hears silence after asking a "teach me" question in
    // voice mode and thinks the bot is broken.
    const voiceChannel = isVoiceTurn || isWakeWordListening();
    const replyHasText = reply.trim().length > 0;
    const shouldSpeak =
      effectiveMode === "voice" ||
      effectiveMode === "voice-dialogue" ||
      (effectiveMode === "teaching" && voiceChannel && replyHasText);
    // Learning-fork reconciliation: keep the LLM honest.
    //   - If the user's message had build/teach intent AND the reply has
    //     NO <learningFork> tag AND gate conditions pass, inject one
    //     (fallback: LLM forgot).
    //   - If gate conditions FAIL (no active editor, session already
    //     running, voice turn, synthetic suppress flag set), strip any
    //     fork tag the LLM emitted.
    //   - If the user's message had NO build/teach intent but the reply
    //     DOES have a fork tag, strip it (LLM over-emitted).
    const FORK_TAG_RE = /\s*<learningFork\s+goal="[^"]+"\s*(?:\/\s*>|><\/learningFork>)/i;
    let finalReply = reply;
    // Understanding-Check takes precedence over the classifier for fork
    // eligibility: its `offer-learn` / `offer-do` / `answer` verdict is
    // more specific (it saw the goal + context). Classifier is the
    // fallback when verify was skipped or failed open.
    //   - offer-learn → force fork on (refined goal is ready)
    //   - offer-do    → force fork OFF (bot just does it)
    //   - answer / skip → defer to classifier's existing logic
    const verifyOfferLearn = understanding.action === "offer-learn";
    const verifyOfferDo = understanding.action === "offer-do";
    // Classifier is the source of truth for fork eligibility when it's
    // confident; fall back to the legacy regex only at low confidence.
    // "debug" is deferred to Phase 2's own chip, so it's excluded here.
    const userHasBuildIntent =
      verifyOfferLearn
        ? true
        : verifyOfferDo
          ? false
          : shape.confidence >= 0.7
            ? shape.needsRoadmap &&
              (shape.shape === "build" ||
                shape.shape === "teach" ||
                shape.shape === "refactor")
            : hasBuildOrTeachIntent(message);
    const replyHasFork = FORK_TAG_RE.test(finalReply);
    // Voice-input = user SPOKE this turn (wake word or manual voice mode).
    // We only suppress fork chips when input was voice, because spoken
    // "say learn or just do it" is awkward. Text-input with wake merely
    // listening — the user TYPED — should still get fork chips; skipping
    // them was the root cause of "teach me X always just does it for me"
    // on users who keep wake on by default.
    const voiceInputTurn =
      mode === "voice" || mode === "voice-dialogue" || mode === "teaching";
    // Fork gate — kept deliberately narrow. Used to also include
    // `!sessionRunning`, but that blocked fork chips on every subsequent
    // "teach me X" ask when a prior session was still open in the panel.
    // Clicking "Learn it with me" calls `endSession("abandoned")` before
    // starting the new one, so replacing is safe. Only hard no-gos left:
    //   (a) input was voice (spoken "say learn or just do it" is awkward)
    //   (b) no active code file (nowhere to build into)
    //   (c) transient suppress-fork flag set (by synthetic "just do it"
    //       turns, so the confirmation reply doesn't re-offer the fork)
    const hasActiveEditor =
      !!vscode.window.activeTextEditor &&
      vscode.window.activeTextEditor.document.uri.scheme === "file";
    const forkAllowed =
      !voiceInputTurn && hasActiveEditor && !suppressNextFork;
    // Log gate decision — when fork doesn't appear on a "teach me" ask,
    // this tells us exactly which predicate vetoed it.
    if (userHasBuildIntent && !forkAllowed) {
      const why = [
        voiceInputTurn && "voice-input",
        !hasActiveEditor && "no-active-editor",
        suppressNextFork && "suppress-flag",
      ].filter(Boolean).join(", ");
      const { log } = await import("../log.js");
      log("fork", `gate blocked fork for "${message.slice(0, 60)}" — ${why}`);
    }
    if (suppressNextFork) suppressNextFork = false; // consume
    // When verify gave us a refined goal AND the LLM also emitted a fork
    // tag, replace the LLM's goal with the refined one. The refined goal
    // is what seeds the learning session's plan — using the LLM's
    // guess would lose the clarifier context.
    if (
      forkAllowed &&
      verifyOfferLearn &&
      replyHasFork &&
      understanding.goal
    ) {
      const safeGoal = understanding.goal.replace(/"/g, "'").slice(0, 200);
      finalReply = finalReply.replace(
        FORK_TAG_RE,
        ` <learningFork goal="${safeGoal}" />`
      );
    } else if (!forkAllowed && replyHasFork) {
      finalReply = finalReply.replace(FORK_TAG_RE, "").trimEnd();
    } else if (forkAllowed && userHasBuildIntent && !replyHasFork && replyHasText) {
      // Prefer the verifier's refined goal ("Add swipe-to-delete on todo
      // cards using Swiper") over the raw message ("teach me swiper").
      // The refined goal is what seeds the learning-session plan, so a
      // crisp one = a crisp plan. Falls back to raw message when verify
      // skipped or failed open.
      const rawGoal =
        understanding.goal && understanding.goal !== message
          ? understanding.goal
          : message;
      const safeGoal = rawGoal.replace(/"/g, "'").slice(0, 200);
      finalReply = `${finalReply.trimEnd()}\n\n<learningFork goal="${safeGoal}" />`;
    } else if (forkAllowed && !userHasBuildIntent && replyHasFork) {
      finalReply = finalReply.replace(FORK_TAG_RE, "").trimEnd();
    }
    const assistant: ChatMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: finalReply,
      createdAt: new Date().toISOString(),
      source: shouldSpeak ? "voice" : "text",
    };
    // Broadcast the assistant message so every mounted Protege view
    // shows it, regardless of which one initiated the turn. `post`
    // would only hit the specific webview argument — if the user has
    // the sidebar AND an editor-tab panel open, only one would update.
    // Voice turns especially need this: they originate host-side and
    // pick an arbitrary mounted webview as `target`. Text turns already
    // saw the user's own message locally (optimistic append) so a
    // duplicate assistant render across panels is harmless.
    broadcast({ type: "chat/append", message: assistant });
    if (shouldSpeak) {
      const spoken = finalReply.trim();
      // Pre-suspend wake BEFORE the broadcast. Otherwise the chain is
      // broadcast → webview → fetch /tts → onplaying → post :true → host
      // suspend — that's 100–300ms of latency during which the bot's
      // first syllables are already in the speakers and can self-trigger
      // wake. Suspending here closes the window. voice/speaking:true
      // from onplaying is a no-op (already suspended); :false from
      // onended unsuspends normally.
      if (spoken.length > 0 && isWakeWordListening()) {
        setWakeSuspended(true);
        setStrictWakeMode(true);
        setVoiceState("speaking");
        // Arm conversational follow-up — when audio ends, we'll auto-
        // open the mic instead of waiting for the user to say "protege"
        // again. Only for dialogue-style turns; pure "voice" (single
        // wake → reply → done) behaves the classic way.
        pendingFollowUpMode =
          effectiveMode === "voice-dialogue" ? "voice-dialogue" : "voice";
      }
      console.log(
        `[protege] voice reply → broadcast voice/playExplain: ${spoken.length} chars, ${mountedWebviews.size} webviews, effectiveMode=${effectiveMode}, wakeOn=${isWakeWordListening()}`
      );
      if (spoken.length > 0) {
        broadcast({ type: "voice/playExplain", text: spoken });
      }
    } else {
      console.log(
        `[protege] voice reply skipped — effectiveMode=${effectiveMode}, wakeOn=${isWakeWordListening()}`
      );
      // No TTS for this turn — the state bar was sitting on "thinking"
      // (from the STT→chat phase) or "listening" (from a prior wake).
      // Without this, it'd stay there forever because voice/speaking:false
      // never fires. Bring it back to "idle" so the user knows the turn
      // is complete and wake listening is live again.
      if (isWakeWordListening()) {
        setVoiceState("idle");
      } else {
        setVoiceState("off");
      }
    }

    // Persist the assistant's reply. userMsg was already persisted
    // above (before the AI call) so it survives AI errors and reloads.
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
    // Chat errored — state was at "thinking" from the earlier onWake
    // path. Without explicit reset, status bar hangs there indefinitely.
    if (isWakeWordListening()) {
      setVoiceState("idle");
    } else {
      setVoiceState("off");
    }
  } finally {
    broadcast({ type: "chat/loading", loading: false });
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
  const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline' https://fonts.googleapis.com; script-src 'nonce-${nonce}' 'wasm-unsafe-eval' 'strict-dynamic'; img-src ${webview.cspSource} data: blob: https://avatars.githubusercontent.com; font-src ${webview.cspSource} https://fonts.gstatic.com; connect-src ${webview.cspSource} http://localhost:8787 http://127.0.0.1:8787; media-src ${webview.cspSource} blob: data: http://localhost:8787 http://127.0.0.1:8787;`;

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
