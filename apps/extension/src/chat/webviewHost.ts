import * as vscode from "vscode";
import type {
  WebviewToHost,
  HostToWebview,
  ChatMessage,
  Finding,
} from "@protege/types";
import { BACKEND_URL, authedFetch, currentUserIdOrNull, fetchMe } from "../user/protegeClient.js";
import { getGitHubUser, isSignedIn, onAuthChange, signOut } from "../user/auth.js";
import { isOptedOut } from "../user/authState.js";
import { runChat } from "./chatRunner.js";
import { isTeachingMessage } from "../intent/teachingTrigger.js";
import { getActiveFileEditor } from "../workspace/activeFile.js";
import { classifyResponse, dispatchRouterActions } from "./responseRouter.js";
import { getHistory, appendMessage, searchHistory, clearHistory } from "./chatHistory.js";
import { clearAllHighlights, setLessonActive, resetConversationLineMemory } from "../ai/tools.js";
import { decideShouldSpeak } from "./shouldSpeak.js";
import { isLiveReviewActive } from "../review/liveReview.js";
import {
  startRecording,
  stopRecording,
  transcribe,
  isRecording,
  collectAutoStopAudio,
  startWakeWordListener,
  stopWakeWordListener,
  isWakeWordListening,
  isWakeSuspended,
  collectWakeAudio,
  setStrictWakeMode,
  setWakeSuspended,
  setRequestInFlight,
  triggerFollowUp,
} from "../voice/voiceCapture.js";
import {
  getStoredWakeThreshold,
  getWakeEnabled,
  setWakeEnabled,
} from "../voice/wakeWordCalibration.js";
import { setVoiceState, flashVoiceError, getVoiceGender } from "../voice/voiceStatusBar.js";
import { trimForVoice, trimForText } from "../teaching/explainMode.js";
import { shapeTask, buildShapeContext, verifyUnderstanding } from "../intent/index.js";
import { devPortMapping, isDevMode, renderDevHtml } from "../devMode.js";
import {
  handleEchoRpc,
  registerEchoBroadcastTarget,
  type PanelState as EchoPanelState,
} from "../echo/panel.js";
import { getBatcher } from "../echo/batcher.js";
import { buildChatTurnEvent } from "../iq3/eventProducers/chatTurn.js";
import type { EchoHostToWebview } from "@protege/types";

// Audited allowlist for webview-initiated `command:` URIs. Adding a button
// in the webview that dispatches a new command requires adding the id here.
// Keep this set small — every entry is a trusted execution path.
const ALLOWED_WEBVIEW_COMMANDS = new Set<string>([
  "protege.applyReviewFix",
  "protege.teachConcept",
]);

// Schemes the webview is allowed to open via vscode.env.openExternal. `https`
// covers normal links; `x-apple.systempreferences` is the macOS Settings
// deeplink used by the microphone-permissions flow.
const ALLOWED_EXTERNAL_SCHEMES = new Set<string>([
  "http",
  "https",
  "mailto",
  "x-apple.systempreferences",
]);

/**
 * Registry so outside code (analyzer, status bar) can broadcast messages
 * (like "iq/update") into every mounted Protege webview.
 */
const mountedWebviews = new Set<vscode.Webview>();
let speakingDeadman: ReturnType<typeof setTimeout> | null = null;
// Pending audio-playback watchdogs. When the host broadcasts a voice
// reply we add an id; when the webview confirms `voice/speaking:true`
// we delete it so the watchdog no-ops. If still present at +4s the
// webview never started — surface a popup so the user can react.
const playbackAckPending = new Set<string>();

/** Audio-blocked hint retired 2026-04-30 — the in-panel banner inside
 *  the webview (App.tsx → `voice-unlock-banner`) replaces this VS Code
 *  toast. The banner is closer to the action: clicking it IS the
 *  activation gesture the browser needs, so one click both dismisses
 *  the prompt AND unlocks audio. The toast was redundant + the user
 *  was getting two simultaneous popups. Stub kept so existing
 *  callsites compile during cleanup; remove when callsites are gone. */
export function surfaceAudioBlockedHintOnce(): void {
  // intentional no-op — see comment above.
}
// Tracks whether the turn that just spoke was a voice-channel turn — drives
// the conversational follow-up (auto-open mic after bot stops). Set in
// handleChat when shouldSpeak fires, consumed when voice/speaking:false
// arrives. Reset afterwards so text-mode turns that happen between voice
// sessions don't spuriously trigger follow-ups.
let pendingFollowUpMode: "voice" | "voice-dialogue" | null = null;

/** Sticky voice-dialogue session flag. When true, every reply re-arms
 *  the conversational follow-up — the mic auto-opens after each bot
 *  turn so the user can keep talking like a phone call. Turns ON when
 *  the user enters voice-dialogue mode (typed text with wake on, or
 *  voice mode toggled in the panel). Turns OFF when:
 *    - The user says a closure keyword ("thanks", "got it", "done", …).
 *    - Wake is toggled off.
 *    - The user explicitly switches input channels.
 *  Without this flag, voice-dialogue conversations died after one
 *  follow-up because binary-triggered turns came in as plain "voice"
 *  mode and didn't re-arm the loop. */
let voiceDialogueSessionActive = false;

/** Closure keywords that end the sticky session. Compared
 *  case-insensitively against the FULL user transcript (after trim).
 *  Single-word responses dominate so we keep the regex tight — we
 *  don't want "thanks for explaining, but…" to terminate. The bare
 *  closing line is the signal. */
const VOICE_CLOSURE_RE =
  /^(thanks?|thx|ty|got it|i got it|makes sense|i see|perfect|nice|cool|done|that'?s all|i'?m good|stop|bye|gotcha|ok cool|ok thanks?|all good|good)[\s.!?]*$/i;

export function endVoiceDialogueSession(): void {
  voiceDialogueSessionActive = false;
}
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
/** Should the mic auto-open after the bot's reply finishes? True only
 *  for explicit "voice-dialogue" turns (user typed text while wake was
 *  on, OR voice mode is engaged for back-and-forth chat). Single-shot
 *  wake-triggered "voice" turns do NOT auto-open the mic — the user
 *  said "Protege …" once expecting a one-and-done answer; auto-opening
 *  feels intrusive ("the chip flipped to Listening even though I didn't
 *  say Protege"). They can say "Protege" again to start another turn. */
function shouldTriggerFollowUp(): boolean {
  const mode = pendingFollowUpMode;
  pendingFollowUpMode = null; // always consume
  if (mode !== "voice-dialogue") return false;
  return isWakeWordListening();
}

// Live broadcast of quota changes — every fetchQuota result fans out
// to all mounted webviews so the Live tab's "Today's usage" panel
// updates without the user having to click refresh. Registered once
// per process; the import is lazy so the extension's activation order
// doesn't depend on quotaClient being loaded.
let quotaBroadcasterInstalled = false;
function ensureQuotaBroadcaster(): void {
  if (quotaBroadcasterInstalled) return;
  quotaBroadcasterInstalled = true;
  void (async () => {
    const { onQuotaChange } = await import("../user/quotaClient.js");
    onQuotaChange((snapshot) => {
      broadcast({ type: "quota/snapshot", snapshot });
    });
  })();
}

export function broadcast(msg: HostToWebview) {
  ensureQuotaBroadcaster();
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

/** Voice-mode chat sanitizer. The whole point of voice mode is that the
 *  user can CLOSE the sidebar — they're listening to prose and watching
 *  their editor. Code goes through edit_file (lands as a diff in the
 *  file), explanations are spoken aloud. So any code that leaks into the
 *  chat reply is dead weight: the user can't read it (sidebar closed)
 *  and the bot can't speak it intelligibly. Strip it.
 *
 *  - Fenced blocks (```...```) → removed
 *  - Inline backticks (`foo`) → removed (just the ticks AND content)
 *  - Lines that look like code (braces, `let`/`while`/`function`/`=>`/
 *    `console.log`/etc.) → removed
 *  - Collapse the resulting whitespace so the bubble doesn't look gappy. */
function stripCodeForVoice(text: string): string {
  // STRUCT signals = unambiguous code patterns that DON'T appear in
  // ordinary English prose:
  //   - braces and semicolons (`{`, `}`, `;`)
  //   - arrow functions (`=>`)
  //   - increment/decrement operators (`++`, `--`)
  //   - assignment (`x = y` where both sides look like tokens, NOT `==`)
  //   - function calls with arguments (`foo(arg`, not bare `foo()`)
  // Bare keywords like "while" / "return" / "for" are excluded — they
  // appear in legitimate prose ("the loop will return when…").
  const STRUCT = new RegExp(
    [
      "[{};]",                   // braces / semicolon
      "=>",                      // arrow function
      "\\+\\+|--",              // ++ or --
      "\\b\\w+\\s*=(?!=)\\s*\\S", // assignment: x = something
      "\\b\\w+\\.\\w+\\(",       // method call: foo.bar(
      "\\b\\w+\\(\\s*[^)\\s]",  // function call with arg: foo(x
    ].join("|")
  );
  // STRONG keyword signal — appears alongside structural cues most of
  // the time, so by itself isn't enough, but combined with a colon-
  // terminated line ("Add this:") it's a tell that the next chunk is code.
  const STRONG_KW = /\b(const|let|var|function|import|export)\b/;
  const out: string[] = [];
  // Remove fenced blocks first so the inline pass doesn't have to
  // worry about contents.
  const fenceless = text.replace(/```[\s\S]*?```/g, "");
  let inCodeRegion = false;
  for (const raw of fenceless.split("\n")) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      // Blank line ends a "code region" run — next non-empty line is
      // re-evaluated from scratch.
      inCodeRegion = false;
      out.push(raw);
      continue;
    }
    const hasStruct = STRUCT.test(trimmed);
    const hasStrongKw = STRONG_KW.test(trimmed);
    // Three drop conditions:
    //  (a) Line has unambiguous structural code (braces, ;, =>, x=y, foo(arg).
    //  (b) Line has a strong keyword AND no sentence-ending punctuation
    //      (real prose sentences end in . / ? / ! — code declarations don't).
    //  (c) We're already in a multi-line code region (entered via prior
    //      drop) and this line still looks more like code than prose.
    const endsSentence = /[.!?][")\]]?$/.test(trimmed);
    const isCode =
      hasStruct ||
      (hasStrongKw && !endsSentence) ||
      (inCodeRegion && !endsSentence && /^[a-z\s\W]/.test(trimmed));
    if (isCode) {
      inCodeRegion = true;
      continue;
    }
    inCodeRegion = false;
    // Strip inline backtick spans entirely — voice users don't see them
    // and the spoken pass already ate them.
    out.push(raw.replace(/`[^`\n]+`/g, "").replace(/[ \t]+$/g, ""));
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function findLastAssistantReply(): string | null {
  const hist = getHistory();
  for (let i = hist.length - 1; i >= 0; i--) {
    if (hist[i].role === "assistant") return hist[i].content;
  }
  return null;
}

/** Detect when Whisper's transcript is really the bot's last reply
 *  echoing back through the speakers OR a context-steered hallucination
 *  that continues the bot's topic. Uses Jaccard similarity on normalized
 *  word sets — self-echo lands 0.8–1.0, lesson-context hallucinations
 *  ("Exactly that is why JavaScript…" after the bot just talked about
 *  JavaScript) overlap ~0.3-0.5 with the assistant text, real
 *  follow-ups like "yes, do it" sit well under 0.2.
 *
 *  Threshold 0.3 (was 0.5 — bumped down 2026-05-02 after real test
 *  caught a lesson-context hallucination at jaccard ≈ 0.4 that the
 *  old threshold let through and the bot replied to as if real).
 *
 *  Short transcripts (<20 chars) bypass so quick "yes"/"no"/"stop"
 *  commands always get through. Continuation-word starters
 *  ("exactly", "yes that's why", "and also") are caught even on short
 *  transcripts because those are the highest-likelihood phantom shapes
 *  in lesson context. */
function looksLikeEcho(transcript: string, lastAssistant: string): boolean {
  // Continuation-starter guard — these are the shapes that fire when
  // Whisper hallucinates content that "agrees with" the bot's last
  // reply. Drops phantom turns regardless of similarity.
  const trimmed = transcript.trim().toLowerCase();
  const continuationStarters = [
    /^exactly\b/,
    /^yes,?\s*(that('?s| is)?\s+why|exactly)/,
    /^that('?s| is)?\s+(right|why|exactly|correct)/,
    /^right,?\s+(and|so|that|because)/,
    /^and\s+(also|that|so)/,
    /^so\s+(that|yeah|right)/,
  ];
  if (continuationStarters.some((re) => re.test(trimmed))) return true;

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
  return jaccard >= 0.3;
}

export function mountProtegeWebview(
  webview: vscode.Webview,
  context: vscode.ExtensionContext
) {
  webview.options = {
    enableScripts: true,
    localResourceRoots: [
      vscode.Uri.joinPath(context.extensionUri, "dist", "webview"),
    ],
    ...(isDevMode(context.extensionMode) ? { portMapping: devPortMapping() } : {}),
  };
  webview.html = renderHtml(webview, context.extensionUri, context.extensionMode);
  mountedWebviews.add(webview);

  // Replay the last cached IQ headline so the dashboard hydrates
  // instantly instead of sitting on "Loading IQ…" until the next 30s
  // poll lands. Dynamic import avoids the activation-order coupling we
  // already swallow elsewhere when the bridge isn't started yet.
  void (async () => {
    try {
      const { getIq3Bridge } = await import("../extension.js");
      const last = getIq3Bridge?.()?.getLast?.();
      if (last) {
        try {
          webview.postMessage({
            type: "iq/headline",
            payload: last,
          } satisfies HostToWebview);
        } catch {
          /* webview disposed between mount and replay */
        }
      }
    } catch {
      /* bridge not yet started — webview will hydrate on next poll */
    }
  })();

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

  // Active abort controller for the in-flight chat turn. The "stop"
  // button in the composer fires chat/abort → we abort this controller
  // → fetch + tool-loop bail out → loading clears and the user can type
  // again. Replaced (and aborted) at the start of every new chat turn
  // so stale aborts can't poison a fresh request.
  let activeAbort: AbortController | null = null;

  const sub = webview.onDidReceiveMessage(async (msg: WebviewToHost) => {
    if (msg.type === "chat/typing") {
      // Stamp the freshness marker so the wake-recording handler can
      // tell "user was just typing" from "user is idle / using voice".
      // No reply, no broadcast — pure side-effect on lastTypedAt.
      noteUserTyping();
      return;
    }
    if (msg.type === "chat/abort") {
      // Abort the in-flight turn so the user can interrupt a long
      // generation. Doesn't clear the user's message — only kills the
      // pending response.
      //
      // Two distinct things to stop, depending on what's currently
      // happening:
      //   1. fetch + tool loop in flight → activeAbort.abort()
      //      ("stop generating")
      //   2. TTS playback in progress → stopHostAudio()
      //      ("stop talking" — the chat call already returned, audio is
      //       playing host-side via afplay/aplay/powershell, separate
      //       from the abort controller)
      // Both can happen back-to-back; we fire both unconditionally so
      // the button reliably stops EVERYTHING the bot is doing.
      let didStop = false;
      if (activeAbort) {
        activeAbort.abort();
        activeAbort = null;
        broadcast({ type: "chat/loading", loading: false });
        didStop = true;
      }
      try {
        const { stopHostAudio, isHostAudioPlaying } = await import(
          "../voice/hostAudio.js"
        );
        if (isHostAudioPlaying()) {
          stopHostAudio();
          // Clear loading explicitly. stopHostAudio's preemption guard
          // skips the onEnd hook (it's designed for "preempted by NEW
          // playback" where the new caller owns state), so the
          // chat/loading=false broadcast in onEnd never fires after
          // a user-initiated abort. Without this explicit clear, the
          // stop button would remain visible after the audio dies.
          broadcast({ type: "chat/loading", loading: false });
          // Restore chip to its resting state — stopHostAudio doesn't
          // call setVoiceState because it's also used as a no-op step
          // before kicking off a NEW playback (where flipping to idle
          // would flicker). On a user-initiated abort, we want the
          // chip to drop out of "speaking" immediately.
          setVoiceState(isWakeWordListening() ? "idle" : "off");
          // Clear any post-reply follow-up trigger so we don't auto-
          // open the mic right after the user just told us to shut up.
          pendingFollowUpMode = null;
          setStrictWakeMode(false);
          // Also unsuspend wake — TTS path had set it true; without
          // this, the user would have to wait for a stale 500ms decay
          // timer before "Protege" worked again.
          if (isWakeWordListening()) setWakeSuspended(false);
          didStop = true;
        }
      } catch (err) {
        console.warn(
          `[protege] chat/abort: stopHostAudio failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      if (didStop) {
        console.log("[protege] chat aborted by user");
      }
      return;
    }
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
      // Wire up cancel for the composer Stop button. activeAbort was
      // declared above but historically nothing assigned to it, so
      // chat/abort silently no-op'd and the response landed anyway.
      // We pre-empt any prior in-flight turn (defensive — UI usually
      // disables send) so a fresh request always owns activeAbort.
      if (activeAbort) activeAbort.abort();
      const ac = new AbortController();
      activeAbort = ac;
      try {
        await handleChat(
          webview,
          sendId,
          msg.message,
          msg.mode ?? "text",
          msg.contextMessages,
          msg.userMsgId,
          ac.signal
        );
      } finally {
        if (activeAbort === ac) activeAbort = null;
      }
    } else if (msg.type === "ready") {
      sendInitialState(webview, resolveUserId());

      // Hand the host's backend URL to the webview so its /tts and /log
      // fetches match whichever server we're hitting (prod, staging,
      // local). Without this, the webview falls back to its hardcoded
      // localhost:8787 default and silently fails when host is on prod.
      const { BACKEND_URL } = await import("../user/protegeClient.js");
      post(webview, { type: "config/backend", url: BACKEND_URL });

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
      // Push the Live Review master-switch state so the webview can
      // bop a red dot on the Live tab when 24/7 review is OFF.
      const liveReviewEnabled = vscode.workspace
        .getConfiguration("protege")
        .get<boolean>("codeReview.liveReview", true);
      post(webview, {
        type: "liveReview/enabled",
        enabled: liveReviewEnabled !== false,
      });

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

      // Auto-resume policy (2026-04-29): if VS Code already has a
      // cached GitHub session AND the user hasn't explicitly signed
      // out, skip the gate and broadcast the user directly so the
      // chat surface mounts immediately. Only when the silent probe
      // returns null (or the user has opted out) do we hand back
      // null and let the gate take over.
      //
      // The earlier "always show gate" experiment forced an explicit
      // click every panel mount, which the user found annoying — most
      // VS Code extensions just resume.
      const ghUser = isOptedOut() ? null : await getGitHubUser(false);
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
      // User clicked "Continue as <login>" / "Sign in" on the gate.
      //
      // Try the silent probe first — if VS Code already has a GitHub
      // session this returns the user without any UI dialog. The
      // probe also calls setSession() internally, which fires
      // onAuthChange listeners that broadcast `auth/user` to every
      // mounted webview (so the launcher + main panel both flip past
      // the gate at the same time). Only fall through to OAuth when
      // the silent probe genuinely returns null.
      let ghUser = await getGitHubUser(false);
      if (!ghUser) {
        ghUser = await getGitHubUser(true);
      }
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
      // Wipe the cross-turn highlight-line memory too — a fresh chat
      // means the user can re-see lines they'd already been shown.
      // (Mid-conversation `clearAllHighlights` doesn't touch this; only
      // an explicit chat reset does.)
      resetConversationLineMemory();
      post(webview, { type: "chat/history", messages: [] });
    } else if (msg.type === "notes/list") {
      const { listNotes } = await import("../notes/notesStore.js");
      post(webview, { type: "notes/state", notes: listNotes() });
    } else if (msg.type === "notes/create") {
      const { createNote, listNotes } = await import("../notes/notesStore.js");
      createNote(msg.title);
      post(webview, { type: "notes/state", notes: listNotes() });
    } else if (msg.type === "notes/update") {
      const { updateNote, listNotes } = await import("../notes/notesStore.js");
      updateNote(msg.id, { title: msg.title, body: msg.body });
      post(webview, { type: "notes/state", notes: listNotes() });
    } else if (msg.type === "notes/delete") {
      const { deleteNote, listNotes } = await import("../notes/notesStore.js");
      deleteNote(msg.id);
      post(webview, { type: "notes/state", notes: listNotes() });
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
    } else if (msg.type === "quota/get") {
      // Live tab requesting today's usage. Refetch from backend, then
      // post the snapshot. On auth/network failure post the last-known
      // cached value if we have one — better than the panel staying
      // blank.
      const { fetchQuota, getCachedQuota } = await import(
        "../user/quotaClient.js"
      );
      const snap = (await fetchQuota()) ?? getCachedQuota();
      if (snap) post(webview, { type: "quota/snapshot", snapshot: snap });
    } else if (msg.type === "ai/setBackend") {
      const { setAiBackend } = await import("../ai/aiBackend.js");
      setAiBackend("cloud");
      post(webview, { type: "ai/backend", backend: "cloud" });
    } else if (msg.type === "explainMode/set") {
      // Persist to the `protege.explainMode` VS Code setting. The
      // onDidChangeConfiguration listener in extension.ts will broadcast
      // `explainMode/state` back to ALL mounted webviews so any open
      // sidebar mirrors the change.
      await vscode.workspace
        .getConfiguration("protege")
        .update("explainMode", msg.mode, vscode.ConfigurationTarget.Global);
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
    } else if (msg.type === "openExternal") {
      // Webview can't call openExternal itself — bounce through the host.
      // Used for jumping to macOS Settings → Privacy → Microphone.
      // Also detects "command:<id>" URIs from the Quick Actions buttons and
      // runs them as VS Code commands (openExternal can't execute commands).
      //
      // Security: a webview-initiated `command:` dispatch is a sandbox-escape
      // surface — any XSS in rendered chat or prompt-injected file content
      // could pivot into arbitrary command execution. We restrict to a
      // small, audited allowlist of commands the Quick Actions UI actually
      // emits. Add new entries here when adding new buttons; do not relax
      // the allowlist to a `protege.*` prefix match.
      try {
        if (msg.url.startsWith("command:")) {
          const rest = msg.url.slice("command:".length);
          const qIdx = rest.indexOf("?");
          const commandId = qIdx === -1 ? rest : rest.slice(0, qIdx);
          if (!ALLOWED_WEBVIEW_COMMANDS.has(commandId)) {
            console.warn(
              "[protege] blocked webview command dispatch:",
              commandId
            );
            return;
          }
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
          const parsed = vscode.Uri.parse(msg.url);
          if (!ALLOWED_EXTERNAL_SCHEMES.has(parsed.scheme)) {
            console.warn(
              "[protege] blocked openExternal scheme:",
              parsed.scheme
            );
            return;
          }
          await vscode.env.openExternal(parsed);
        }
      } catch (err) {
        console.warn("[protege] openExternal failed:", err);
      }
    } else if (msg.type === "voice/setGender") {
      // VoiceMode's voice picker is the canonical UI now. Persist to the
      // workspace config so host-side TTS broadcasts (Ghost Lens explain,
      // teach narrations, file-open greeter) read the same value via
      // getVoiceGender(). Global target so the choice follows the user
      // across workspaces.
      try {
        await vscode.workspace
          .getConfiguration("protege")
          .update(
            "voice.gender",
            msg.gender,
            vscode.ConfigurationTarget.Global
          );
      } catch (err) {
        console.warn("[protege] voice/setGender persist failed:", err);
      }
    } else if (msg.type === "voice/openInBrowser") {
      const id = requireUserIdOrToast();
      if (!id) return;
      const url = `${BACKEND_URL}/voice?userId=${encodeURIComponent(id)}`;
      try {
        await vscode.env.openExternal(vscode.Uri.parse(url));
      } catch (err) {
        console.warn("[protege] voice/openInBrowser failed:", err);
      }
    } else if (msg.type === "voice/ttsRequest") {
      // Webview asks for TTS audio. Proxy through authedFetch so the
      // GitHub token never leaves the host process. Reply with base64-
      // encoded WAV bytes (or an error) tagged with the requestId.
      const reqId = msg.requestId;
      try {
        const res = await authedFetch(`${BACKEND_URL}/tts`, {
          method: "POST",
          body: JSON.stringify({ text: msg.text, voice: msg.voice }),
        });
        if (res.status === 503) {
          post(webview, {
            type: "voice/ttsResponse",
            requestId: reqId,
            error: "kokoro-warming-up",
          });
        } else if (!res.ok) {
          post(webview, {
            type: "voice/ttsResponse",
            requestId: reqId,
            error: `tts HTTP ${res.status}`,
          });
        } else {
          const buf = Buffer.from(await res.arrayBuffer());
          post(webview, {
            type: "voice/ttsResponse",
            requestId: reqId,
            audioBase64: buf.toString("base64"),
          });
        }
      } catch (err) {
        post(webview, {
          type: "voice/ttsResponse",
          requestId: reqId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else if (msg.type === "voice/ttsStatusRequest") {
      const reqId = msg.requestId;
      try {
        const res = await authedFetch(`${BACKEND_URL}/tts/status`);
        if (!res.ok) {
          post(webview, {
            type: "voice/ttsStatusResponse",
            requestId: reqId,
            ready: false,
            warmupError: null,
            networkError: `status HTTP ${res.status}`,
          });
        } else {
          const data = (await res.json()) as {
            ready: boolean;
            warmupError: string | null;
            stage?: "idle" | "downloading" | "loading" | "ready" | "error";
            progress?: number;
            loadedBytes?: number;
            totalBytes?: number;
          };
          post(webview, {
            type: "voice/ttsStatusResponse",
            requestId: reqId,
            ready: data.ready,
            warmupError: data.warmupError,
            stage: data.stage,
            progress: data.progress,
            loadedBytes: data.loadedBytes,
            totalBytes: data.totalBytes,
          });
        }
      } catch (err) {
        post(webview, {
          type: "voice/ttsStatusResponse",
          requestId: reqId,
          ready: false,
          warmupError: null,
          networkError: err instanceof Error ? err.message : String(err),
        });
      }
    } else if (msg.type === "voice/start") {
      try {
        // Suspend the wake listener while the orb-tap mic is open. Both
        // paths spawn the same native mic binary; if both run in parallel
        // they fight for the microphone and the resulting recordings are
        // corrupted (Whisper then hallucinates garbage like "EMEMHAM").
        // Suspending the wake stdin layer drops its WAKE/RECORDING events
        // for the duration without killing the process — cheaper than a
        // full restart.
        if (isWakeWordListening()) setWakeSuspended(true);
        // Auto-stop callback: when the binary detects silence and exits
        // on its own, run the same transcribe→chat flow as manual stop.
        const autoStop = async () => {
          try {
            const wav = collectAutoStopAudio();
            post(webview, { type: "voice/recording", active: false });
            // Resume the wake listener now that we're done capturing.
            if (isWakeWordListening()) setWakeSuspended(false);
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
            if (isWakeWordListening()) setWakeSuspended(false);
            const stopErr = err instanceof Error ? err.message : String(err);
            post(webview, { type: "voice/error", error: stopErr });
          }
        };
        await startRecording(context.extensionUri.fsPath, autoStop);
        post(webview, { type: "voice/recording", active: true });
      } catch (err) {
        if (isWakeWordListening()) setWakeSuspended(false);
        const startErr = err instanceof Error ? err.message : String(err);
        post(webview, { type: "voice/error", error: startErr });
      }
    } else if (msg.type === "voice/stop") {
      try {
        const wav = await stopRecording();
        post(webview, { type: "voice/recording", active: false });
        // Resume the wake listener — orb-tap recording is done.
        if (isWakeWordListening()) setWakeSuspended(false);
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
        if (isWakeWordListening()) setWakeSuspended(false);
        const stopErr = err instanceof Error ? err.message : String(err);
        post(webview, { type: "voice/error", error: stopErr });
      }
    } else if (msg.type === "voice/playbackDone") {
      console.log(
        `[protege] voice/playbackDone reason=${msg.reason}${msg.requestId ? ` requestId=${msg.requestId}` : " (no requestId — ghost lens / direct)"}`
      );
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
      console.log(
        `[protege] voice/speaking active=${msg.active} (from webview audio.${msg.active ? "onplaying" : "onended"})`
      );
      // Audio actually started — clear ALL pending watchdogs. The set
      // could hold stale ids from prior turns whose acks raced; clearing
      // wholesale is safe because each broadcast adds its own id and
      // only the most recent matters for "did this reply play?"
      if (msg.active) playbackAckPending.clear();
      // Bot starts speaking → fully suspend the wake listener. No wake
      // events, no recordings. Bot voice bleeding back through the mic
      // cannot self-trigger the loop ("Oh yeah you brought the book…").
      // Bot finishes → wait 1500ms for speaker decay, then un-suspend.
      // Bumped from 500ms 2026-05-02: real test caught a self-loop
      // where the bot's own TTS tail re-triggered wake at the 500ms
      // mark, recorded the user's silence, transcribed bot bleed, and
      // queued a phantom user turn. 1500ms gives speaker reverb +
      // mic gain settle time enough to die out before wake re-arms.
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
        }, 1500);
      }
    } else if (msg.type === "wake/toggle") {
      const id = requireUserIdOrToast();
      if (!id) return;
      await toggleGlobalWake(context, id);
    } else if (msg.type === "iq/onboardingComplete") {
      // Webview finished the 5-question probe flow. Forward to the
      // backend so the matchKeys + self-declared field land in the
      // user's Iq3 state, then trigger an immediate Iq3 bridge
      // refresh so the dashboard stops showing the cold-start
      // branch on the next render.
      const id = currentUserIdOrNull();
      if (!id) return;
      // Whitelist payload shape before forwarding (security audit H2).
      // The webview is the authoritative source for onboarding answers
      // but we still bound the array and reject non-string entries so
      // a compromised webview script can't hand the backend a million
      // keys to chew on.
      const rawPayload = (msg as any).payload;
      const rawKeys = Array.isArray(rawPayload?.matchKeys)
        ? rawPayload.matchKeys
        : [];
      const safeKeys: string[] = [];
      for (const k of rawKeys) {
        if (typeof k !== "string" || k.length > 200) continue;
        safeKeys.push(k);
        if (safeKeys.length >= 50) break;
      }
      const safeField =
        typeof rawPayload?.field === "string" && rawPayload.field.length <= 64
          ? rawPayload.field
          : undefined;
      const safePayload = { matchKeys: safeKeys, field: safeField };
      try {
        await authedFetch(`${BACKEND_URL}/iq/onboarding`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-user-id": id },
          body: JSON.stringify(safePayload),
        });
      } catch {
        // Backend offline / not signed in. Silent — webview already
        // moved past the cold branch via local state, so the user
        // sees the dashboard either way and the next /iq/me poll
        // picks up whatever did persist.
      }
      try {
        const { getIq3Bridge } = await import("../extension.js");
        await getIq3Bridge?.()?.refresh();
      } catch {
        // Bridge not yet started (activation race) — next 30s poll
        // will pick up the new state anyway.
      }
    } else if (msg.type === "iq/selfRating") {
      // Periodic self-rating (Task 25). Forward to backend
      // `POST /iq/self-rating` (Task 17), which records it as a
      // declarative-evidence event. We swallow network errors — the
      // user already saw the prompt commit, and the next /iq/me poll
      // will reflect whichever side persisted.
      const id = currentUserIdOrNull();
      if (!id) return;
      await authedFetch(`${BACKEND_URL}/iq/self-rating`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-user-id": id },
        body: JSON.stringify({
          userId: id,
          rating: msg.payload.rating,
          ratedAt: new Date().toISOString(),
          note: msg.payload.note,
        }),
      }).catch(() => {});
    } else if (msg.type === "iq/feedback") {
      // Anonymous "found something weird?" feedback on Code IQ scoring.
      // Auth gate cuts spam, but the body intentionally omits userId —
      // the backend route refuses to persist any caller-supplied id and
      // stores text + server timestamp only. Errors swallowed: the
      // webview already showed a confirmation toast.
      const id = currentUserIdOrNull();
      if (!id) return;
      const text =
        typeof msg.payload?.text === "string"
          ? msg.payload.text.slice(0, 1000)
          : "";
      if (!text.trim()) return;
      await authedFetch(`${BACKEND_URL}/iq/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-user-id": id },
        body: JSON.stringify({ text }),
      }).catch(() => {});
    } else if (msg.type === "iq/refresh") {
      // Webview asked for a fresh /iq/me fetch — typically the IQ
      // dashboard on mount. Mount-time replay above already covers the
      // common case (host has a cached headline); this path covers
      // first-ever mount before any successful poll, post-sign-in
      // hydration, and any user action that should jump the cadence.
      try {
        const { getIq3Bridge } = await import("../extension.js");
        await getIq3Bridge?.()?.refresh();
      } catch {
        // Bridge not yet started (activation race) — next 30s poll
        // will hydrate the dashboard.
      }
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
      internal: me.internal,
    } satisfies HostToWebview);
  } catch {
    // backend may be offline
  }
}

function post(webview: vscode.Webview | null, msg: HostToWebview) {
  // Null webview = zero-UI mode (sidebar closed, voice still running).
  // No-op silently — UI updates have nowhere to land. The audio path,
  // history persistence, and status-bar chip all run independently and
  // don't go through this function.
  if (!webview) return;
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
    // End any active voice-dialogue session — wake off means the user
    // is opting out of conversation entirely, not pausing mid-thread.
    endVoiceDialogueSession();
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
/** Pending "flip chip to Listening" timer. See onWake/onRecordingDone
 *  for why it exists — defers the state change so background-noise
 *  false positives don't visibly bounce the status bar. */
let wakeListeningTimer: ReturnType<typeof setTimeout> | null = null;
/** Mirrors the wake binary's recording state on the host side. True
 *  between WAKE:detected and RECORDING:stopped. The 600ms listening-
 *  flip timer checks this before painting "Listening" — so if the
 *  binary stopped recording in the gap, we don't paint a fake
 *  Listening chip for a recording that's already over. */
let wakeRecordingActive = false;

/** Last time the user typed in the chat composer (epoch ms). The webview
 *  posts a `chat/typing` message on every keystroke; we use the freshness
 *  of this stamp to suppress wake-recording turns that fire while the
 *  user is actively writing — i.e. the wake word false-fired (or a
 *  voice-dialogue follow-up window stayed open) and ambient room speech
 *  got captured as if it were a Protege command. If the user is typing,
 *  whatever the mic just heard is not their question to Protege. */
let lastTypedAt = 0;
const TYPING_SUPPRESSION_MS = 8000;

export function noteUserTyping(): void {
  lastTypedAt = Date.now();
}

function isUserActivelyTyping(): boolean {
  return Date.now() - lastTypedAt < TYPING_SUPPRESSION_MS;
}

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
          // While the bot is speaking, the mic still picks up "Protege"
          // echoes from the speakers. The wake-suspension layer drops
          // those before they become real recordings — but the status
          // bar update was firing BEFORE that check, so the chip kept
          // flickering "Listening" mid-bot-speech. Skip the chip update
          // when suspended so it stays on whatever real state it had
          // (typically "Speaking" while the bot is talking).
          if (isWakeSuspended()) return;
          // Zero-UI mode (2026-04-30): sidebar stays closed if the user
          // closed it. Audio plays via host-side afplay (hostAudio.ts),
          // status-bar chip carries the visual state, and chat history
          // persists so anything spoken is visible if/when the user
          // opens the panel later. Removed the auto-open that used to
          // force-reveal the sidebar — that was needed when audio went
          // through the webview's <audio> element (autoplay-blocked),
          // not anymore.
          wakeRecordingActive = true;
          broadcast({ type: "voice/recording", active: true });
          broadcast({ type: "wake/state", active: true, status: "recording" });
          // Delay the status-bar flip by 600ms. Background noise often
          // scores above the wake-word threshold, fires WAKE:detected,
          // and produces a sub-second recording that gets discarded as
          // <1000 bytes. Without the delay the chip flashed "Listening"
          // for every false positive, and to the user it looked
          // permanently stuck on "Listening". A real "Protege, …" stays
          // recording past the window so the flip lands normally.
          if (wakeListeningTimer) clearTimeout(wakeListeningTimer);
          wakeListeningTimer = setTimeout(() => {
            wakeListeningTimer = null;
            // Only paint "Listening" if a recording is STILL active.
            // The binary's RECORDING:stopped event might have landed
            // in the 600ms gap (very short audio, race with timer).
            // Without this guard the chip would announce "Listening"
            // for a recording that's already over — exactly the "fake
            // listening" status the user reported.
            if (wakeRecordingActive) {
              setVoiceState("listening");
            }
          }, 600);
        },
        onRecordingDone: async () => {
          // Mirror the binary's state — recording is over. Pending 600ms
          // listening-flip timers will check this flag and skip the
          // chip flip if the recording's already done.
          wakeRecordingActive = false;
          // Suppress further wake fires for this turn — the user said
          // "Protege" once, the wake binary's prob can stay elevated for
          // a moment after their voice fades and re-fire WAKE on its own
          // utterance tail. Without this, a single "Protege keep going"
          // produced two wake events. Cleared in the finally so every
          // bail-out path resets it. Fired BEFORE setVoiceState so the
          // chip transitions don't race with a phantom new wake.
          setRequestInFlight(true);
          try {
            const wav = collectWakeAudio();
            broadcast({ type: "voice/recording", active: false });
            broadcast({ type: "wake/state", active: true, status: "listening" });
            // Cancel any pending listening flip — if recording ended
            // before the 600ms timer, this was a false positive and we
            // should never have surfaced "Listening" at all.
            if (wakeListeningTimer) {
              clearTimeout(wakeListeningTimer);
              wakeListeningTimer = null;
            }
            // Suspended at recording-end means the bot started speaking
            // mid-recording — the audio is bot-bleed, not a real user
            // turn. Resync the chip (so it doesn't stay stuck on
            // "Listening") and drop the buffer instead of sending it
            // to STT. The chip's "no downgrade from speaking/thinking"
            // guard inside setVoiceState handles the case where bot
            // playback is still active.
            if (isWakeSuspended()) {
              setVoiceState("idle");
              return;
            }
            if (wav.length < 1000) {
              setVoiceState("idle");
              return;
            }
            // Typing-mode gate: if the user has typed in the chat
            // composer in the last 8s, treat this wake recording as
            // ambient room noise and drop it. The user reported a
            // case where they were chatting with a friend in the room
            // while typing in Protege; the wake binary false-fired,
            // ~3s of conversation was captured, Whisper produced a
            // grammatical English sentence ("This place turned out
            // very expensive."), every content filter passed it, and
            // it landed as a YOU message in chat. Content-based
            // filtering can't catch full-sentence ambient speech —
            // the only reliable signal is the user's intent, and
            // active typing is a strong "I'm using text right now,
            // not voice" signal.
            if (isUserActivelyTyping()) {
              console.log(
                `[protege] dropped wake recording — user typed ${Date.now() - lastTypedAt}ms ago (typing-mode gate)`,
              );
              setVoiceState("idle");
              return;
            }
            setVoiceState("thinking");
            // "Mm-hmm" filler retired 2026-04-30 — Kokoro renders it as
            // a slurred "ememham" sound that confused the user before
            // every reply. Real reply latency is short enough that the
            // acknowledgment isn't necessary.
            // broadcast({ type: "voice/fillerPlay" });
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
            // Zero-UI mode (2026-04-30): skip the "Open the Protege panel"
            // hard-fail. Audio plays host-side, transcripts persist to
            // global state, and any post(webview, …) inside handleChat
            // either no-ops (no webview) or hits whichever panel is
            // mounted. Look up a webview if one IS open (so direct
            // posts still land), otherwise pass null and let the
            // broadcast paths handle UI.
            const target =
              mountedWebviews.size > 0 ? [...mountedWebviews][0]! : null;
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
          } finally {
            // Always release the wake-suppression flag, regardless of
            // success / early-return / throw — otherwise wake stays
            // disabled forever after one bad turn.
            setRequestInFlight(false);
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
  // Nullable post-2026-04-30 zero-UI work: voice flow can run with no
  // sidebar open. UI-only `post(webview, …)` calls inside this function
  // must guard against null (no panel = nothing to update visually,
  // but everything else still runs and audio still plays).
  webview: vscode.Webview | null,
  userId: string,
  message: string,
  mode: "text" | "voice" | "voice-dialogue" | "teaching" | "teaching-text",
  contextMessages?: ChatMessage[],
  // ID the originating webview already used for its optimistic user
  // message append. When voice turns broadcast `chat/append` back to
  // every mounted panel (sidebar + editor tab), the originating panel
  // dedupes by id so the message doesn't appear twice. Host-originated
  // turns (wake-word, orb-tap, synthetic) leave this undefined and a
  // fresh id is minted.
  userMsgId?: string,
  // Abort signal from the composer Stop button (chat/send path only).
  // When fired, runChat's in-flight fetch throws AbortError and the
  // catch below swaps the would-be reply for an "interrupted" placeholder
  // (ChatGPT-style: user message stays, response area shows the cancel).
  signal?: AbortSignal
) {
  // --- IQ3 chat_turn event (Task 19) ---
  // Observe the prompt BEFORE any short-circuits or LLM calls so the HMM
  // sees every user turn regardless of downstream outcome. The chat→
  // accept correlation is handled in the backend matcher layer via
  // temporal-proximity matchKeys (see iq3Hook.ts), not via a flag on
  // the event itself.
  getBatcher()?.push(buildChatTurnEvent(message));

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
      id: userMsgId ?? crypto.randomUUID(),
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
    // The webview flips loading=true optimistically when the user clicks
    // send (App.tsx:926). The Learning panel takes over the sidebar — no
    // chat reply is coming — so we must explicitly clear chat/loading or
    // the typing-dots ("thinking…") indicator hangs forever. Without this,
    // user reported "it has been thinking for 2 minutes" while the
    // Learning panel was actually running fine.
    broadcast({ type: "chat/loading", loading: false });
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
  let effectiveMode:
    | "text"
    | "voice"
    | "voice-dialogue"
    | "teaching"
    | "teaching-text" = mode;
  if ((mode === "voice" || mode === "voice-dialogue") && TEACH_INTENT_RE.test(message)) {
    effectiveMode = "teaching";
  }
  // Text-channel teaching upgrade — typed "teach me X" / "I don't get this"
  // on the FIRST message of a thread routes through TEACHING_TEXT instead
  // of plain TEXT_MODE. Restricted to first message so short follow-ups
  // ("ok", "got it") don't keep re-evaluating and flipping modes mid-
  // lesson. Distinct mode value from the voice teaching path so the
  // backend prompt picks the right beat structure (typed PAUSE vs.
  // voice agentic teach_step).
  const isFirstMessage = (contextMessages ?? getHistory()).length === 0;
  if (
    effectiveMode === "text" &&
    isFirstMessage &&
    isTeachingMessage(message)
  ) {
    effectiveMode = "teaching-text";
  }
  // If the user typed but wake is listening, the reply will be spoken.
  // NO promotion of typed text → voice-dialogue. Wake-word being
  // active (status-bar mic icon on) does NOT mean the user wants every
  // typed message read aloud — it means "I might say Protege at any
  // time." If they typed it, they want to read it. If they spoke it,
  // the wake binary flips mode to "voice" upstream and the rest of the
  // pipeline (TTS, speaking chip, follow-up arming) fires from there.
  // Removed the auto-promotion 2026-04-30 — user reported "I typed 'hi'
  // and the bot replied with audio" while wake was on but unused.

  // Sticky voice-dialogue session. Once entered (typed text with wake
  // on, or any explicit voice-dialogue turn), the flag stays ON across
  // subsequent binary-triggered "voice" turns so the conversational
  // follow-up keeps re-arming. Turns OFF when the user says a closure
  // keyword ("thanks"/"got it"/"done"/…) on this turn — we'll let the
  // bot's wrap-up line play, but the post-reply auto-mic-open is
  // skipped so the loop ends cleanly.
  if (effectiveMode === "voice-dialogue") {
    voiceDialogueSessionActive = true;
  }
  // Pure-voice (wake-binary) turns inside an active session are ALSO
  // treated as voice-dialogue for follow-up purposes — without this,
  // the loop dies after one back-and-forth because the binary path
  // emits mode="voice".
  if (voiceDialogueSessionActive && effectiveMode === "voice") {
    effectiveMode = "voice-dialogue";
  }
  // Closure detection — if the bare user transcript is a single
  // closure word, end the session NOW. The reply will still play
  // (the bot already responds with a wrap-up line via the prompt
  // guidance), but no follow-up mic-open after it.
  if (
    voiceDialogueSessionActive &&
    VOICE_CLOSURE_RE.test(message.trim())
  ) {
    voiceDialogueSessionActive = false;
    console.log(
      `[protege] voice-dialogue session ended by closure keyword: "${message.trim().slice(0, 30)}"`
    );
  }

  // Highlights persist across turns by default now (2026-05-03). User
  // explicitly asked: "once it highlights something, it'll be there
  // until I click dismiss". Sticky-by-default + the existing per-call
  // replace semantics inside highlightCode mean a NEW highlight_code
  // call still wipes/replaces; the user just doesn't lose their last
  // result by typing a follow-up message. Use the ✘ Dismiss action
  // (CodeLens row above each highlight) or the `clear_highlights`
  // command-palette entry to remove them.

  // Create the user message for persistence. Stamp source from the
  // ORIGINAL mode (not effectiveMode) so voice-dialogue promotions don't
  // mislabel a typed message as "voice" in the chat history — the mic
  // glyph should only appear when the user actually spoke.
  // Reuse the webview's optimistic id when present so voice broadcasts
  // dedupe in the originating panel (see param doc on `userMsgId`).
  const userMsg: ChatMessage = {
    id: userMsgId ?? crypto.randomUUID(),
    role: "user",
    content: message,
    createdAt: new Date().toISOString(),
    source:
      mode === "voice" || mode === "voice-dialogue" || mode === "teaching"
        ? "voice"
        : "text",
  };

  // Broadcast the user message for voice turns so wake-word and orb-tap
  // transcripts (which originate host-side with no webview optimistic
  // append) become visible. For chat/send-originated turns the webview
  // already appended optimistically; the broadcast still fires because
  // OTHER mounted panels (sidebar + editor tab) need it. The originating
  // panel dedupes by id — the host reuses `userMsgId` when present so
  // both copies share the same id (see chat/append handler in App.tsx).
  // Text mode skips the broadcast entirely: text-mode chats only
  // originate from chat/send, so the optimistic append already covers
  // the originating panel and any other open panels stay in sync via
  // the periodic chat-history hydration.
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
      console.log(
        `[protege] clarifier voice broadcast — ${understanding.clarifier.length}ch · webviews=${mountedWebviews.size} · clarifierVoice=${clarifierVoice}`
      );
      // Host-side audio path — see hostAudio.ts for why we bypass the
      // webview's <audio> element. Awaiter-free, fire and forget — the
      // chip transitions back to idle when afplay exits. Streaming
      // variant splits the clarifier into sentences so the first one
      // starts playing after a single TTS round-trip.
      const { playHostAudioStreaming: playHostAudio } = await import(
        "../voice/hostAudio.js"
      );
      void playHostAudio(
        { text: understanding.clarifier, voice: getVoiceGender() },
        {
          onEnd: () => {
            // Strict mode stays ON for 5s post-TTS — see chat-reply
            // onEnd above for full reasoning. Same window so the
            // clarifier path doesn't have a different self-loop bug
            // than the main reply path.
            setTimeout(() => setStrictWakeMode(false), 5000);
            setVoiceState(isWakeWordListening() ? "idle" : "off");
            // 1500ms decay + conversational follow-up trigger — same
            // sequence the chat-reply path uses. The clarifier set
            // pendingFollowUpMode = "voice-dialogue" above; consume
            // it now so the mic auto-opens for the user's answer.
            // Decay bumped from 500ms 2026-05-02 to kill a self-loop
            // where TTS tail tripped wake before speaker reverb died.
            setTimeout(() => {
              setWakeSuspended(false);
              if (shouldTriggerFollowUp()) {
                const ok = triggerFollowUp();
                console.log(
                  `[protege] voice follow-up triggered (clarifier path) ok=${ok}`
                );
              }
            }, 1500);
          },
          // Barge-in fires when the user starts speaking over the
          // clarifier. armBargeIn already killed afplay, flipped the
          // chip, unsuspended wake, and triggered FOLLOW_UP. We just
          // need to clear our local state — strict-mode flag and the
          // pending follow-up consume marker — so the next legit onEnd
          // (or the next user turn) doesn't double-fire anything.
          onBargeIn: () => {
            setStrictWakeMode(false);
            pendingFollowUpMode = null;
          },
        }
      );
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

  // Mirror the loading state on the VS Code status bar so the bottom-of-
  // screen chip reads "thinking" instead of staying on a stale "listening"
  // (left over from wake-word capture). Voice turns already handle this in
  // onRecordingDone, but text turns never touched the status bar — so a
  // user who typed while wake was on saw "Listening" the whole reply.
  // Only flip when wake is enabled — with wake off the chip is "off" and
  // we don't want to repurpose it as a chat-loading indicator.
  if (isWakeWordListening()) {
    setVoiceState("thinking");
  }

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

  // Track whether TTS is in flight at function-end. If so, the finally
  // below DEFERS the chat/loading=false broadcast — the TTS onEnd will
  // do it instead. Without this, the stop button in the composer
  // disappears the moment the chat fetch returns, even though the bot
  // is still speaking for another 10–30 seconds. User reported clicking
  // "stop" did nothing — that's because they were clicking a "send"
  // button (the loading state had already cleared).
  let ttsKickedOff = false;

  try {
    // Track whether teach_step was called this turn. teach_step plays
    // its own TTS narration per step — if it fired, the terminal reply
    // should NOT also be spoken or the user hears two voices stacked
    // ("here's what useState does" → terminal reply repeats). User
    // feedback 2026-05-02: "for instance here it started speaking like
    // 2 times, I mean I heard 2 voices."
    let teachStepWasCalled = false;
    const reply = await runChat(
      userId,
      message,
      {
        onTool: (call, status) => {
          if (call.name === "teach_step") teachStepWasCalled = true;
          post(webview, {
            type: "chat/tool",
            name: call.name,
            args: call.arguments,
            status,
          });
        },
        onLessonState: (state) => {
          // Broadcast — every mounted Protege panel renders the same
          // banner from this state, so we use broadcast() not post().
          broadcast({ type: "lesson/state", state });
          // Flip the codelens-flag so highlights painted during a
          // lesson render with a stripped-down lens (no Teach me /
          // Apply fix buttons — the user is already being taught).
          setLessonActive(state?.phase === "TEACHING");
        },
      },
      { mode: effectiveMode, history: recentHistory, signal }
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
    // Single source of truth for the speak/silence decision lives in
    // `./shouldSpeak.ts`. Pulled out so the closer-question exception
    // and teach_step suppression are unit-testable without a webview
    // harness; behavior is preserved verbatim.
    const shouldSpeak = decideShouldSpeak({
      effectiveMode,
      teachStepWasCalled,
      voiceChannel,
      reply,
    });
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
    // Display rule (revised 2026-05-02): for voice modes, trim the chat-
    // displayed text to ~35 words at a sentence boundary so it matches
    // what the user HEARS via TTS. Without this, gpt-5 routinely
    // produces 60-200 word voice replies despite the persona's HARD
    // 50-word cap. Soft prompts can't enforce length; a deterministic
    // trim can.
    //
    // Cap was 50; tightened to 35 — the persona's stated TARGET is
    // 30 words. 35 leaves breathing room so trimForVoice can land on
    // a sentence boundary instead of trailing off mid-sentence. Real
    // sim 2026-05-02: at 50, ~14/30 voice replies were 31-50 words.
    // At 35, those land at 25-35 — closer to the 30-word goal.
    //
    // Text mode: still trim, just at a much higher ceiling. The model
    // overshoots even the persona's "60-120 word default" — one real
    // case 2026-05-02 had a 600+ word reply with 6 sections and 20
    // bullets on a vanilla "explain in general" question. The persona
    // says HARD CEILING 200 words; this enforces it. If the model
    // genuinely fits under 200 words, this is a no-op.
    //
    // Voice-shape determination — KEY RULE: respect the input channel,
    // not whether wake is listening. The user reported (2026-05-02)
    // typing "Teach me about X" while wake was on and getting back a
    // 30-word voice-trimmed reply with markdown stripped. They typed
    // it; they want to read it. Wake-listening is "I might say Protege
    // later", not "speak everything I type". Use ONLY isVoiceTurn (a
    // boolean derived from the actual `mode` arg passed by the caller
    // — wake binary path = "voice", typed-while-wake-on path stays
    // "text" since 2026-04-30).
    const isVoiceShape = isVoiceTurn;
    const displayReply = isVoiceShape
      ? trimForVoice(finalReply, 35)
      : trimForText(finalReply, 200);
    const assistant: ChatMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: displayReply,
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
    //
    // Skip the broadcast (and persistence) when the model produced no
    // terminal text. Happens when a turn ran entirely as teach_step /
    // highlight_code tool calls and the model's final answer is empty.
    // Without this guard the chat panel paints an empty assistant
    // bubble — user reported it as a bug ("it shows empty response").
    if (displayReply.trim().length > 0) {
      broadcast({ type: "chat/append", message: assistant });
    }
    // Refresh the quota snapshot now that the backend has incremented
    // teach_calls + tool_calls + cost for this turn. `fetchQuota` emits
    // through `onQuotaChange`, which the broadcaster above is wired to —
    // so the Profile panel's usage bars update without polling. Fire and
    // forget: a failed refresh just means the bars reflect the previous
    // value until the next call (or the 30s TTL refetch in the Live tab).
    void (async () => {
      const { fetchQuota } = await import("../user/quotaClient.js");
      void fetchQuota();
    })();
    if (shouldSpeak) {
      // Strip code fences, inline code, bold/italic markdown, and bullets
      // before sending to TTS. Without this, Kokoro reads "let i equals
      // zero curly brace console dot log…" out loud OR chokes on the
      // syntax and produces silence — which is what the user hit when
      // the model emitted a fenced snippet in a voice reply.
      //
      // Word cap stays as a brevity hint, but trimForVoice itself was
      // changed (2026-05-03) to ALWAYS finish the sentence it lands in
      // — it never cuts backwards to a prior period and drops the
      // final sentence. So a reply of 36 words gets spoken in full
      // rather than losing "The effect is fine." off the tail.
      const spoken = trimForVoice(finalReply, 35);
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
        // Host-side audio playback (2026-04-30): bypass the webview's
        // autoplay-locked <audio> element entirely by spawning the OS
        // audio player. afplay on macOS, powershell on Windows, aplay
        // on Linux. The OS has no autoplay policy, so audio plays
        // whether or not the user has clicked inside the panel.
        const { playHostAudioStreaming: playHostAudio } = await import("../voice/hostAudio.js");
        ttsKickedOff = true; // tells the finally to defer chat/loading=false
        void playHostAudio(
          { text: spoken, voice: getVoiceGender() },
          {
            onEnd: (reason) => {
              // Clear chat/loading now — the bot has fully finished
              // talking. While TTS was playing the loading flag stayed
              // true so the composer's "stop" button remained visible
              // and clickable. Now switch back to "send" mode.
              broadcast({ type: "chat/loading", loading: false });
              // Highlights stay until the user dismisses them — see the
              // start-of-turn comment for the sticky-by-default policy.
              // The trailing `← <label>` from a teach_step tour's last
              // beat will now linger until the user hits ✘ Dismiss; the
              // older auto-clear here was removed at user request.
              // Keep STRICT mode on for 5s after TTS ends — only a clearly
              // spoken "Protege" (avg ≥ STRICT_AVG_THRESHOLD = 0.55) can
              // re-trigger wake during this window. Bot speaker reverb,
              // ambient noise, and false-positive prob spikes all fail
              // that bar. Bumped from "clear immediately" 2026-05-02
              // because the user reported "self-loop" — bot's own voice
              // tail kept tripping wake right after suspension lifted.
              // 5s was chosen as: speaker reverb usually dies in ~500ms,
              // headphone+room echoes can last 1-2s, leave 3s margin.
              setTimeout(() => setStrictWakeMode(false), 5000);
              // Chip restoration ("idle"|"off") is owned by hostAudio.ts
              // now — see playHostAudioStreaming cleanup. Calling
              // setVoiceState("idle") here used to clobber the correct
              // "off" state when wake was disabled (text-mode TTS).
              // 1500ms decay before unsuspending wake — same delay the
              // old voice/speaking:false handler used. Lets speaker
              // reverb die down so the bot's last syllable doesn't
              // re-trigger wake through the mic. Bumped from 500ms
              // 2026-05-02 after a confirmed self-loop where bot TTS
              // tail re-triggered wake on the 500ms boundary.
              setTimeout(() => {
                setWakeSuspended(false);
                // Conversational follow-up: if this was a voice or
                // voice-dialogue turn, auto-open the mic so the user
                // can reply without saying "Protege" again. Without
                // this, follow-up dialogues don't work — we used to
                // trigger off the webview's voice/speaking:false post
                // from audio.onended, but host-side audio doesn't
                // post that.
                if (shouldTriggerFollowUp()) {
                  const ok = triggerFollowUp();
                  console.log(
                    `[protege] voice follow-up triggered (host audio path) ok=${ok}`
                  );
                }
              }, 1500);
              if (reason === "error") {
                console.warn(
                  `[protege] host audio: chat reply playback errored (effectiveMode=${effectiveMode})`
                );
              }
            },
            // armBargeIn already killed audio, flipped the chip,
            // unsuspended wake, and triggered FOLLOW_UP. Just clear
            // local state so the next turn starts clean.
            onBargeIn: () => {
              setStrictWakeMode(false);
              pendingFollowUpMode = null;
            },
          }
        );
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
      // Text-path: highlights stay until the user dismisses (or the AI
      // calls highlight_code again, replacing them). Same sticky-by-
      // default policy as the voice path above — particularly relevant
      // for "find bugs" replies where the user wants the highlights to
      // remain visible while they read the bullet list.
    }

    // Persist the assistant's reply. userMsg was already persisted
    // above (before the AI call) so it survives AI errors and reloads.
    // Skip the persist for the same empty-reply case the broadcast
    // skips above — no point storing a blank entry in chat history.
    if (displayReply.trim().length > 0) {
      appendMessage(assistant);
    }

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
    // User clicked the composer Stop button: signal aborted mid-fetch (or
    // between tool rounds). Don't render a red chat/error — that would
    // look like the bot crashed. ChatGPT-style: user message stays put,
    // a quiet italic line takes the response slot. Also persist it so
    // the chat thread reads coherently when the user scrolls back.
    if (
      signal?.aborted ||
      (err instanceof Error && err.name === "AbortError")
    ) {
      const interrupted: ChatMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: "_Response interrupted._",
        createdAt: new Date().toISOString(),
        source: "text",
      };
      broadcast({ type: "chat/append", message: interrupted });
      appendMessage(interrupted);
      if (isWakeWordListening()) setVoiceState("idle");
      else setVoiceState("off");
      return;
    }
    // Daily-quota 429s carry structured fields (kind/used/limit/resetAt)
    // — pass them through so the webview renders a friendly limit-reached
    // banner with a countdown instead of the generic red error line.
    const { QuotaExceededChatError } = await import("./chatRunner.js");
    if (err instanceof QuotaExceededChatError) {
      post(webview, {
        type: "chat/error",
        error: err.message,
        quota: {
          kind: err.kind as never,
          used: err.used,
          limit: err.limit,
          resetAt: err.resetAt,
        },
      });
      // Refresh the snapshot so the Profile/Live usage panels reflect
      // the cap that just tripped (the call would otherwise stay
      // 30s-stale until the next polling tick).
      const { fetchQuota } = await import("../user/quotaClient.js");
      void fetchQuota();
    } else {
      post(webview, {
        type: "chat/error",
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
    // Chat errored — state was at "thinking" from the earlier onWake
    // path. Without explicit reset, status bar hangs there indefinitely.
    if (isWakeWordListening()) {
      setVoiceState("idle");
    } else {
      setVoiceState("off");
    }
  } finally {
    // If TTS started and is still playing, the onEnd hook clears
    // chat/loading; we leave it true here so the stop button stays
    // visible during speech. If the bot didn't speak (text mode, no
    // TTS, or chat errored before TTS fired), clear immediately.
    if (!ttsKickedOff) {
      broadcast({ type: "chat/loading", loading: false });
    }
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
  // EchoTab embeds the dashboard inside the main panel. Vite's per-entry
  // CSS bundling keeps echo styles in echo/echo.css (the standalone Echo
  // panel still needs that path), so the main panel needs to load both
  // stylesheets to paint the .echo-* classes.
  const echoStyleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(base, "echo", "echo.css")
  );
  const nonce = getNonce();
  // `wasm-unsafe-eval` is required for Shiki's Oniguruma grammar engine
  // (TextMate regex compiled to WebAssembly). Without it the webview's
  // CSP silently kills the syntax-highlight pipeline and every code block
  // renders as monochrome plain text.
  //
  // connect-src + media-src include BOTH the local-dev origin
  // (localhost:8787) AND the production backend
  // (protege-backend-production.up.railway.app). The webview itself
  // doesn't know which one it'll talk to — getBackendUrl() is set
  // dynamically by the host via a `backend/url` message — so the CSP has
  // to allowlist both, otherwise the marketplace .vsix gets blocked
  // every time it tries to fetch /tts or /log from prod. (Self-hosted
  // forks pointing at a different origin via PROTEGE_BACKEND_URL or the
  // protege.backendUrl setting will need to edit this constant; that's
  // the same governance boundary as the voice-asset host.)
  const PROD_BACKEND_ORIGIN = "https://protege-backend-production.up.railway.app";
  const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline' https://fonts.googleapis.com; script-src 'nonce-${nonce}' 'wasm-unsafe-eval' 'strict-dynamic'; img-src ${webview.cspSource} data: blob: https://avatars.githubusercontent.com; font-src ${webview.cspSource} https://fonts.gstatic.com; connect-src ${webview.cspSource} http://localhost:8787 http://127.0.0.1:8787 ${PROD_BACKEND_ORIGIN}; media-src ${webview.cspSource} blob: data: http://localhost:8787 http://127.0.0.1:8787 ${PROD_BACKEND_ORIGIN};`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<base href="${baseUri}" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<link rel="stylesheet" href="${styleUri}" />
<link rel="stylesheet" href="${echoStyleUri}" />
<title>Protege</title>
</head>
<body>
<div id="root"></div>
<!-- Cache acquireVsCodeApi() to make it idempotent. The React bundle
     calls it; VS Code throws on the second call. Wrapping here lets
     any other inline scripts share the same handle without crashing. -->
<script nonce="${nonce}">
(function(){
  try {
    if (typeof acquireVsCodeApi === 'function') {
      var orig = acquireVsCodeApi;
      var cached;
      window.acquireVsCodeApi = function(){
        if (!cached) cached = orig();
        return cached;
      };
    }
  } catch (_) { /* ignore */ }
})();
</script>
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
