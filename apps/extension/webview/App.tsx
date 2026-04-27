import React, { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type {
  ChatMessage,
  ClusterSummary,
  ConceptRow,
  TourState,
  ExplainBackSession,
  LearningSession,
  LearningSessionTrace,
  DailyIqPoint,
  Finding,
  GainEvent,
  IqBreakdown,
  IqPillars,
  IqV2,
  LevelInfo,
  MilestoneSummary,
  Recommendation,
  StreakInfo,
  SynergyResult,
  VelocityInfo,
} from "@protege/types";
import { vscode, onHostMessage } from "./vscode.js";
import { VoiceMode } from "./VoiceMode.js";
import { ConceptsTab } from "./ConceptsTab.js";
import { LiveTab } from "./LiveTab.js";
import { MapTab } from "./MapTab.js";
import { EchoTab } from "./EchoTab.js";
import { SessionStrip } from "./SessionStrip.js";
import { ExplainBackPanel } from "./ExplainBackPanel.js";
import { LearningSessionPanel } from "./LearningSessionPanel.js";
import { ChatSearchBar } from "./ChatSearchBar.js";
import { ChatHistoryPanel } from "./ChatHistoryPanel.js";
import { CinematicPlate } from "./CinematicPlate.js";
import { AssistantMarkdown } from "./AssistantMarkdown.js";
import { Overlay } from "./Overlay.js";
import { StreakJournal } from "./StreakJournal.js";
import { TipDetailOverlay, type TipDetail } from "./TipDetailOverlay.js";
// Overlay pages are heavy (cinematic hero + dashboard widgets) and only
// render when the user explicitly opens them via the header icons. Splitting
// them into their own chunks keeps the initial bundle lean.
const ProfilePage = lazy(() =>
  import("./ProfilePage.js").then((m) => ({ default: m.ProfilePage }))
);
const SubscriptionPage = lazy(() =>
  import("./SubscriptionPage.js").then((m) => ({ default: m.SubscriptionPage }))
);
import {
  IconZap,
  IconBug,
  IconSparkles,
  IconBook,
  IconCheck,
  IconX,
  IconPencil,
  IconStar,
  IconPlus,
  IconMic,
} from "./icons.js";
import protegeLogoUrl from "./protege-logo.svg";

type Mode = "chat" | "concepts" | "live" | "map" | "echo";
type ChatInputMode = "text" | "voice";

// Legacy Code IQ route is hidden behind a dev flag — see the "Archive CodeIQ"
// block in the Echo plan. Vite inlines process.env.* at build time.
const SHOW_CODEIQ_TAB: boolean =
  typeof process !== "undefined" &&
  (process as unknown as { env?: Record<string, string | undefined> })?.env
    ?.PROTEGE_SHOW_CODEIQ === "1";

const QUICK_PROMPTS: Array<{ icon: React.ReactNode; label: string }> = [
  { icon: <IconZap size={14} />, label: "Explain this file to me" },
  { icon: <IconBug size={14} />, label: "Find bugs and issues" },
  { icon: <IconSparkles size={14} />, label: "How can I improve this code?" },
  { icon: <IconBook size={14} />, label: "Teach me something new" },
];

// ---- Voice Explain playback ----
//
// Persistent Audio element so browser autoplay policy keeps trust across
// multiple clips — mirrors the pattern VoiceMode.tsx uses.
//
// IMPORTANT: the hover's 🎙 Explain click happens in the *editor*, not
// inside this webview. By the time `audio.play()` runs here, the webview
// sees no gesture context and blocks it ("user didn't gesture, can't
// play audio"). Fix: unlock the audio element on the FIRST click anywhere
// inside the webview (opening the Protege panel, switching tabs, etc.).
// After that, programmatic `.play()` calls triggered by host broadcasts
// work without further interaction.
//
// This mirrors VoiceMode.tsx's `unlockAudio()` but wires it globally so
// every surface that plays a /tts clip benefits from the same grant.

const EXPLAIN_BACKEND_URL =
  // @ts-expect-error — injected at build time if set, else undefined.
  (typeof __PROTEGE_BACKEND_URL__ !== "undefined" && __PROTEGE_BACKEND_URL__) ||
  "http://localhost:8787";

let explainAudio: HTMLAudioElement | null = null;
let audioUnlocked = false;
// Monotonic playback generation. Every playExplainAudio call increments this
// and stamps its handlers; stale handlers (from a previous clip that got
// interrupted by audio.src=newUrl) compare and no-op. Without this, an old
// onended fires after we've started the next clip and sends a phantom
// voice/speaking:false to the host — which resumes the wake listener while
// the bot is mid-sentence, and reports playbackDone to the wrong requestId.
let playbackGen = 0;

/**
 * Prime the Audio element inside a user gesture so later programmatic
 * plays (triggered by host broadcasts) aren't blocked by autoplay policy.
 * Idempotent — safe to call on every click.
 */
function unlockExplainAudio(): void {
  if (audioUnlocked) return;
  audioUnlocked = true;
  try {
    // Create + play a tiny silent WAV inside the gesture. The browser
    // "blesses" the element; future `.play()` calls on it succeed even
    // when triggered async by a host message.
    const silentWav =
      "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=";
    const persistent = new Audio(silentWav);
    persistent.volume = 0.01;
    explainAudio = persistent;
    persistent.play().catch(() => {
      // Silent clip may still reject in some environments — that's fine,
      // the element was still created inside a gesture so it's blessed.
    });
    console.log("[protege-audio] unlocked explainAudio element");
  } catch {}
}

// Also unlock on any key press or pointerdown inside the webview window.
// Just clicking the textarea's contenteditable area or pressing Enter
// already qualifies as a user gesture — we shouldn't need the user to
// hit the exact root div. This fires the unlock on the very first key
// stroke they make.
if (typeof window !== "undefined") {
  const onFirstGesture = () => {
    if (audioUnlocked) return;
    unlockExplainAudio();
  };
  window.addEventListener("keydown", onFirstGesture, { capture: true });
  window.addEventListener("pointerdown", onFirstGesture, { capture: true });
  window.addEventListener("touchstart", onFirstGesture, { capture: true });
}

async function playExplainAudio(
  text: string,
  voice: "female" | "male",
  requestId?: string
): Promise<void> {
  const myGen = ++playbackGen;
  const isCurrent = () => myGen === playbackGen;

  // Every exit path must tell the host what happened — otherwise the
  // Protege speaking chip hangs on the editor until the 15s safety
  // timer clears it. Previously, TTS fetch failures and autoplay blocks
  // just warned to console and the chip lingered silently.
  // Gated on isCurrent(): if a newer clip already took over, a late
  // reportDone from this (now stale) invocation would prematurely
  // resume the wake listener and misresolve teach_step awaiters.
  const reportDone = (reason: "ended" | "error") => {
    if (!isCurrent()) return;
    vscode.postMessage({ type: "voice/playbackDone", reason, requestId });
  };
  // Error exits must also clear the host's speaking flag — host now
  // pre-suspends wake the moment it broadcasts voice/playExplain (to
  // close the race where the bot's first syllables self-trigger wake
  // through the speakers). If /tts fails and we never start playback,
  // voice/speaking:true → :false from onplaying/onended never fires,
  // so wake would stay suspended until the 30s deadman.
  const clearSpeaking = () => {
    if (!isCurrent()) return;
    vscode.postMessage({ type: "voice/speaking", active: false });
  };

  console.log(
    `[protege-audio] playExplainAudio start · gen=${myGen} · ${text.length} chars · unlocked=${audioUnlocked} · voice=${voice}`
  );

  if (!text || !text.trim()) {
    console.warn("[protege-audio] empty text, nothing to speak");
    reportDone("error");
    return;
  }

  try {
    const res = await fetch(`${EXPLAIN_BACKEND_URL}/tts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, voice }),
    });
    if (!isCurrent()) {
      console.log(`[protege-audio] gen=${myGen} superseded during fetch, dropping`);
      return;
    }
    if (res.status === 503) {
      console.warn("[protege] voice/playExplain: tts 503 — Kokoro warming up");
      clearSpeaking();
      reportDone("error");
      return;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(
        `[protege] voice/playExplain: tts HTTP ${res.status} — ${body.slice(0, 200)}`
      );
      clearSpeaking();
      reportDone("error");
      return;
    }
    const blob = await res.blob();
    if (!isCurrent()) {
      console.log(`[protege-audio] gen=${myGen} superseded during blob, dropping`);
      return;
    }
    if (blob.size === 0) {
      console.warn("[protege] voice/playExplain: /tts returned empty blob");
      clearSpeaking();
      reportDone("error");
      return;
    }
    const url = URL.createObjectURL(blob);

    if (!explainAudio) explainAudio = new Audio();
    const audio = explainAudio;
    const prevUrl = audio.src;

    // Hard stop whatever's currently on the shared element before we
    // reassign src — otherwise the old clip's internal state machine can
    // still fire onended after we've loaded the new blob, even though
    // we null out handlers below. Pause + src clear forces a clean reset.
    try {
      audio.pause();
    } catch {}
    audio.onplaying = null;
    audio.onended = null;
    audio.onerror = null;

    audio.src = url;
    audio.volume = 0.9;

    audio.onplaying = () => {
      if (!isCurrent()) return;
      vscode.postMessage({ type: "voice/speaking", active: true });
    };
    audio.onended = () => {
      if (!isCurrent()) return;
      vscode.postMessage({ type: "voice/speaking", active: false });
      if (url.startsWith("blob:")) URL.revokeObjectURL(url);
      reportDone("ended");
    };
    audio.onerror = () => {
      if (!isCurrent()) return;
      vscode.postMessage({ type: "voice/speaking", active: false });
      console.warn("[protege] voice/playExplain: audio element error", audio.error);
      reportDone("error");
    };

    try {
      await audio.play();
    } catch (playErr) {
      if (!isCurrent()) return;
      vscode.postMessage({ type: "voice/speaking", active: false });
      console.warn(
        "[protege] voice/playExplain: audio.play() rejected — likely autoplay block or missing audio codec:",
        playErr
      );
      reportDone("error");
      return;
    }

    if (prevUrl && prevUrl.startsWith("blob:")) URL.revokeObjectURL(prevUrl);
  } catch (err) {
    if (!isCurrent()) return;
    console.warn("[protege] voice/playExplain failed:", err);
    clearSpeaking();
    reportDone("error");
  }
}

export function App() {
  const [mode, setMode] = useState<Mode>("chat");
  const [chatInputMode, setChatInputMode] = useState<ChatInputMode>("text");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toolActivity, setToolActivity] = useState<
    { name: string; args: Record<string, unknown>; status: "running" | "done" | "error" }[]
  >([]);

  const [fileName, setFileName] = useState<string | null>(null);
  const [codeIq, setCodeIq] = useState(0);
  const [maxIq, setMaxIq] = useState(1000);
  const [bonusIq, setBonusIq] = useState(0);
  const [totalConcepts, setTotalConcepts] = useState(0);
  const [ruleCount, setRuleCount] = useState(0);
  const [topConcepts, setTopConcepts] = useState<ConceptRow[]>([]);
  const [clusters, setClusters] = useState<ClusterSummary[]>([]);
  const [recentGains, setRecentGains] = useState<GainEvent[]>([]);
  const [streak, setStreak] = useState<StreakInfo>({
    current: 0,
    longest: 0,
    lastSaveDate: null,
  });
  const [dailyIq, setDailyIq] = useState<DailyIqPoint[]>([]);
  const [milestones, setMilestones] = useState<MilestoneSummary[]>([]);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [pillars, setPillars] = useState<IqPillars | null>(null);
  const [level, setLevel] = useState<LevelInfo | null>(null);
  const [synergies, setSynergies] = useState<SynergyResult | null>(null);
  const [velocityInfo, setVelocityInfo] = useState<VelocityInfo | null>(null);
  const [breakdown, setBreakdown] = useState<IqBreakdown | null>(null);
  const [iqV2, setIqV2] = useState<IqV2 | null>(null);
  const [toast, setToast] = useState<GainEvent | null>(null);
  const [overlay, setOverlay] = useState<"profile" | "subscription" | null>(null);
  const [authUser, setAuthUser] = useState<{
    githubId: string;
    login: string;
    email: string | null;
    avatarUrl: string | null;
  } | null>(null);
  const [scanning, setScanning] = useState(false);
  const [liveMode, setLiveMode] = useState(false);
  // Hoisted here (not in LiveTab) so tab switches don't remount the state
  // to the default. Hydrated via `explainMode/state` on every mount + any
  // config change. Passed down to LiveTab as a controlled prop.
  const [explainMode, setExplainMode] = useState<"text" | "voice" | "both">("text");
  // Architecture Tour (A2) session state. Hoisted here so the strip
  // survives tab switches. Host is the source of truth — we mirror
  // whatever `tour/state` comes in, and partial updates via
  // `tour/narrationReady` mutate the steps array in place.
  const [tour, setTour] = useState<TourState | null>(null);
  // Explain-back (B1) session. Same pattern as `tour` — host owns
  // truth, we mirror. `null` means no session active.
  const [explainBack, setExplainBack] = useState<ExplainBackSession | null>(
    null
  );
  // Learning Mode session. Same ownership pattern — host drives, panel
  // reflects. When non-null, LearningSessionPanel takes over the sidebar.
  const [learning, setLearning] = useState<LearningSession | null>(null);
  // Dev-mode trace — host broadcasts `learning/devTrace` when the
  // `protege.learning.devLogging` setting is on. Null = setting off or
  // no active session. Passed through to the panel's Dev drawer.
  const [learningTrace, setLearningTrace] =
    useState<LearningSessionTrace | null>(null);
  const [streakOpen, setStreakOpen] = useState(false);
  const [chatHistoryOpen, setChatHistoryOpen] = useState(false);
  // Separate from `messages`: this is the full persisted history the
  // host returns when the panel opens. `messages` represents the
  // current chat view (can be cleared by "New chat"); this represents
  // "everything ever persisted to globalState" so the panel can browse
  // old conversations even after the view has been cleared.
  const [historyPanelMessages, setHistoryPanelMessages] = useState<
    ChatMessage[]
  >([]);
  const [modelStatus, setModelStatus] = useState<{
    ready: boolean;
    loading: boolean;
    error: string | null;
    downloadProgress: number;
  }>({ ready: false, loading: false, error: null, downloadProgress: 0 });
  const [tipDetail, setTipDetail] = useState<TipDetail | null>(null);
  // Message IDs whose learning-fork chips have been clicked (either path).
  // Scoped per-render so rehydrated history doesn't re-offer stale forks
  // across reloads; the user can always ask again to get a fresh fork.
  const [forkResolved, setForkResolved] = useState<Record<string, true>>({});

  const endRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const off = onHostMessage((msg) => {
      if (msg.type === "chat/history") {
        // Restore persisted history on mount — conversations survive reloads.
        // Strip <learningFork> tags from historical replies: the fork was
        // a one-shot affordance at the moment the reply arrived; a reload
        // later is not the right time to re-offer it (check #8 in
        // learning-mode-fork-integration §11). A fresh ask in the current
        // session regenerates the fork.
        const FORK_STRIP_RE = /\s*<learningFork\s+goal="[^"]+"\s*(?:\/\s*>|><\/learningFork>)/gi;
        const cleaned = msg.messages.map((m) =>
          m.role === "assistant"
            ? { ...m, content: m.content.replace(FORK_STRIP_RE, "").trimEnd() }
            : m
        );
        setMessages(cleaned);
      } else if (msg.type === "chat/fullHistory") {
        // Read-only snapshot for the browse panel. Does NOT touch the
        // main `messages` state — the panel needs to see everything
        // even when the current chat view has been cleared.
        setHistoryPanelMessages(msg.messages);
      } else if (msg.type === "chat/append") {
        setMessages((m) => [...m, msg.message]);
        setToolActivity([]);
      } else if (msg.type === "chat/loading") {
        setLoading(msg.loading);
        if (msg.loading) setToolActivity([]);
      } else if (msg.type === "chat/error") setError(msg.error);
      else if (msg.type === "chat/tool") {
        setToolActivity((prev) => {
          // If this tool is already running, update it; else append
          const idx = prev.findIndex(
            (t) => t.name === msg.name && JSON.stringify(t.args) === JSON.stringify(msg.args)
          );
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = { ...next[idx], status: msg.status };
            return next;
          }
          return [...prev, { name: msg.name, args: msg.args, status: msg.status }];
        });
      } else if (msg.type === "iq/update") {
        setCodeIq(msg.codeIq);
        setMaxIq(msg.maxIq);
        setBonusIq(msg.bonusIq);
        setTotalConcepts(msg.totalConcepts);
        setRuleCount(msg.ruleCount);
        setTopConcepts(msg.topConcepts);
        setClusters(msg.clusters);
        setRecentGains(msg.recentGains);
        setStreak(msg.streak);
        setDailyIq(msg.dailyIq);
        setMilestones(msg.milestones);
        setRecommendations(msg.recommendations);
        setPillars(msg.pillars);
        setLevel(msg.level);
        setSynergies(msg.synergies);
        setVelocityInfo(msg.velocity);
        setBreakdown(msg.breakdown);
        setIqV2(msg.iqV2);
      } else if (msg.type === "iq/gain") {
        setCodeIq(msg.codeIq);
        const top = [...msg.gains].sort((a, b) => b.deltaIq - a.deltaIq)[0];
        if (top && top.deltaIq > 0) {
          setToast(top);
          if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
          toastTimerRef.current = setTimeout(() => setToast(null), 3500);
        }
      } else if (msg.type === "file/active") {
        setFileName(msg.file ? msg.file.path : null);
      } else if (msg.type === "teach/finding") {
        teachFinding(msg.finding);
      } else if (msg.type === "chat/autoSend") {
        // Triggered from a highlight hover's "Teach me more" link.
        // Ensure we're in the chat tab, then send the prompt as if
        // the user typed it.
        setMode("chat");
        setChatInputMode("text");
        sendMessage(msg.message);
      } else if (msg.type === "voice/primeConversation") {
        // Teaching Thread's "Ask" button. Swaps the chat into voice input
        // mode before priming so the reply streams back in voice-tuned
        // prose (short, no markdown) and the user can continue the
        // conversation by just speaking again.
        setMode("chat");
        setChatInputMode("voice");
        sendMessage(msg.message);
      } else if (msg.type === "voice/playExplain") {
        // Ghost Lens "Explain" fired in voice mode. The host has already
        // trimmed the text; we just fetch /tts and play. Uses a single
        // persistent Audio element so browser autoplay policy keeps trust
        // across clips (same pattern as VoiceMode).
        // requestId threads through so teach_step can await a specific clip.
        void playExplainAudio(msg.text, msg.voice ?? "female", msg.requestId);
      } else if (msg.type === "liveReview/state") {
        setLiveMode(msg.active);
      } else if (msg.type === "ai/modelStatus") {
        setModelStatus({
          ready: msg.ready,
          loading: msg.loading,
          error: msg.error,
          downloadProgress: msg.downloadProgress,
        });
      } else if (msg.type === "tip/detail") {
        setTipDetail(msg.tip);
      } else if (msg.type === "scan/started") {
        setScanning(true);
      } else if (msg.type === "scan/done") {
        setScanning(false);
        if (msg.summary) {
          setMode("chat");
          setChatInputMode("text");
          const now = new Date().toISOString();
          setMessages((m) => [
            ...m,
            {
              id: crypto.randomUUID(),
              role: "assistant",
              content: msg.summary,
              createdAt: now,
            },
          ]);
        }
      } else if (msg.type === "auth/user") {
        setAuthUser(msg.user);
      } else if (msg.type === "watcher/nudge") {
        // Watcher nudges are no longer rendered in chat — they looked bad
        // inline with user messages. Keeping the handler as a no-op so any
        // future surface (status bar, inlay, etc.) can re-subscribe here.
      } else if (msg.type === "watcher/dismiss") {
        // same as above — no-op
      } else if (msg.type === "explainMode/state") {
        setExplainMode(msg.mode);
      } else if (msg.type === "tour/state") {
        setTour(msg.state);
      } else if (msg.type === "tour/narrationReady") {
        // Patch the narration into the current tour without losing
        // position / other already-landed narrations.
        setTour((prev) => {
          if (!prev) return prev;
          if (msg.index < 0 || msg.index >= prev.steps.length) return prev;
          const steps = prev.steps.map((s, i) =>
            i === msg.index ? { ...s, narration: msg.narration } : s
          );
          return { ...prev, steps };
        });
      } else if (msg.type === "explainBack/state") {
        setExplainBack(msg.state);
      } else if (msg.type === "learning/state") {
        setLearning(msg.state);
        // If the session cleared, drop the trace too — `learning/devTrace`
        // also broadcasts null on session end, but wiping here is a
        // cheap safety net against drift if a trace lingers.
        if (!msg.state) setLearningTrace(null);
      } else if (msg.type === "learning/devTrace") {
        setLearningTrace(msg.trace);
      }
    });
    vscode.postMessage({ type: "ready" });
    return off;
  }, []);

  // Auto-scroll the messages list to the bottom whenever a new turn or
  // tool activity arrives. Smooth scroll can get cut off mid-flight when
  // content grows during streaming, so we:
  //   1. wait for the next paint (requestAnimationFrame) so layout is
  //      final, and
  //   2. scroll the actual .messages container to `scrollHeight`
  //      rather than scrollIntoView on a ref (which fights with parent
  //      overflow when the endRef div happens to be just barely in view).
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const end = endRef.current;
      if (!end) return;
      const container = end.closest(".messages") as HTMLElement | null;
      if (container) {
        container.scrollTop = container.scrollHeight;
      } else {
        end.scrollIntoView({ block: "end" });
      }
    });
    return () => cancelAnimationFrame(id);
  }, [messages, loading, toolActivity]);

  // Sync --header-h to the real measured header height so the overlay starts
  // exactly below it regardless of content (streak chip, tab padding, etc.).
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const apply = () => {
      document.documentElement.style.setProperty(
        "--header-h",
        `${Math.ceil(el.getBoundingClientRect().height)}px`
      );
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Auto-grow textarea — like Cursor/Claude. Resets to 0 first so shrinking works.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "0px";
    const max = 220;
    el.style.height = `${Math.min(max, el.scrollHeight)}px`;
  }, [input]);

  const sendMessage = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || loading) return;
    const user: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: trimmed,
      createdAt: new Date().toISOString(),
      source: chatInputMode === "voice" ? "voice" : "text",
    };
    // Snapshot the current visible messages BEFORE adding the user's
    // new one — that's the AI's short-term context for this turn.
    // After "New chat" the array is empty → AI starts fresh. If we
    // sent messages after adding `user`, the host would receive its
    // own just-sent prompt twice (once as context, once as the new
    // message).
    const contextMessages = messages;
    setMessages((m) => [...m, user]);
    setError(null);
    // Flip loading optimistically so the typing-dots bubble appears in
    // the SAME paint as the user message, not 200–500ms later when
    // chat/loading round-trips back from the host. The host will still
    // send chat/loading=true → the value stays true → no flicker.
    setLoading(true);
    vscode.postMessage({
      type: "chat/send",
      message: trimmed,
      mode: chatInputMode,
      contextMessages,
    });
  };

  const teachFinding = (f: Finding) => {
    setMode("chat");
    setChatInputMode("text");
    const prompt = `I saw a ${f.type} on line ${f.line}: "${f.title}". Can you teach me about it and show me how to fix it properly?`;
    sendMessage(prompt);
  };

  const handleSend = () => {
    sendMessage(input);
    setInput("");
  };

  /** User clicked one of the two fork chips under an assistant message.
   *  Mark the fork as resolved so the chips disappear, then tell the host
   *  what the user picked. Host decides what to do with it (learn →
   *  `protege.learning.start`, just-do-it → synthetic follow-up turn). */
  const handleForkChoice = (
    choice: "just-do-it" | "learn",
    goal: string,
    messageId: string
  ) => {
    setForkResolved((prev) => ({ ...prev, [messageId]: true }));
    vscode.postMessage({
      type: "learning/forkChosen",
      choice,
      goal,
      messageId,
    });
  };

  const lastAssistant = useMemo(
    () =>
      [...messages].reverse().find((m) => m.role === "assistant")?.content ??
      "",
    [messages]
  );

  const isEmpty = messages.length === 0;

  // Login-first gate. The host warms the GitHub session at activation; if
  // the user has signed in to VS Code's GitHub provider, `authUser` will
  // arrive within ~50ms of `ready` and we render the full UI. Otherwise we
  // show a sign-in wall and refuse to render the chat / Echo / live tabs.
  // The gate is the ONLY surface that can hit the backend pre-auth.
  if (authUser === null) {
    return (
      <div className="app auth-gate">
        <div className="auth-gate-card">
          <div className="auth-gate-brand">
            <img src={protegeLogoUrl} alt="Protege" />
            <div className="auth-gate-wordmark">Protege</div>
          </div>
          <div className="auth-gate-title">Sign in to get started</div>
          <div className="auth-gate-body">
            Protege keeps your Code IQ, concepts, and Echo activity tied to
            your GitHub account. We use it for sign-in only — no repo access,
            no posts, nothing else.
          </div>
          <button
            type="button"
            className="auth-gate-button"
            onClick={() => vscode.postMessage({ type: "auth/login" })}
          >
            <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
              <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
            </svg>
            Sign in with GitHub
          </button>
          <div className="auth-gate-foot">
            VS Code's built-in GitHub provider handles the OAuth flow. Your
            token never touches our servers — we verify it via GitHub's API.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="app"
      // Prime audio autoplay on the first click anywhere in the webview.
      // Required for the hover's 🎙 Explain button to play a voice clip:
      // that click happens in the editor (outside this webview), so the
      // audio element needs a prior in-webview gesture to be "blessed"
      // by the browser. Idempotent — subsequent clicks are no-ops.
      onMouseDown={unlockExplainAudio}
      onTouchStart={unlockExplainAudio}
    >
      {toast && (
        <div
          className={`iq-toast toast-${toast.kind ?? "concept"}`}
          key={toast.ts + toast.concept}
        >
          <span className="iq-toast-delta">
            <span className="iq-toast-icon">
              {toast.kind === "milestone" ? (
                <IconStar size={11} strokeWidth={2.2} />
              ) : toast.kind === "fix" ? (
                <IconCheck size={11} strokeWidth={2.6} />
              ) : (
                <IconPlus size={11} strokeWidth={2.6} />
              )}
            </span>
            {toast.deltaIq} IQ
          </span>
          <span className="iq-toast-concept">{toast.concept}</span>
          {toast.kind !== "milestone" && (
            <span className="iq-toast-file">· {toast.file}</span>
          )}
        </div>
      )}
      <header ref={headerRef} className="header">
        <div className="brand-row">
          <button
            type="button"
            className="brand-home"
            onClick={() => {
              setOverlay(null);
              setMode("chat");
            }}
            title="Home"
            aria-label="Back to chat"
          >
            <div className="brand-mark">
              <img src={protegeLogoUrl} alt="Protege" />
            </div>
            <div className="brand-name">Protege</div>
          </button>
          <div className="brand-spacer" />
          <div
            className="status-chip"
            title={`Code IQ ${codeIq} / ${maxIq}${streak.current > 0 ? ` · ${streak.current}d streak (longest ${streak.longest}d)` : ""} — click for history`}
            onClick={() => setStreakOpen((o) => !o)}
            style={{ cursor: "pointer" }}
          >
            {streak.current > 0 && (
              <>
                <span className="status-flame"><IconZap size={11} /></span>
                <span className="status-streak">{streak.current}d</span>
                <span className="status-sep" aria-hidden>·</span>
              </>
            )}
            <span className="status-iq">{codeIq}</span>
            <span className="status-iq-label microcaps">IQ</span>
          </div>
          <div className="header-actions">
            <button
              className={`header-icon-btn scan-btn ${liveMode ? "active" : ""} ${scanning ? "scanning" : ""}`}
              onClick={() => {
                if (!liveMode) {
                  setLiveMode(true);
                  // Tell extension host to start live review
                  vscode.postMessage({ type: "liveReview/toggle", active: true });
                } else {
                  setLiveMode(false);
                  vscode.postMessage({ type: "liveReview/toggle", active: false });
                }
              }}
              title={liveMode ? "Live Review ON — reviewing as you type" : "Start Live Review"}
              aria-label={liveMode ? "Stop live review" : "Start live review"}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="7" />
                <path d="M21 21l-4.3-4.3" />
                <path d="M11 8v3l2 2" />
              </svg>
            </button>
            {authUser ? (
              <button
                className={`header-icon-btn header-avatar-btn ${overlay === "profile" ? "active" : ""}`}
                onClick={() => setOverlay(overlay === "profile" ? null : "profile")}
                title={`${authUser.login} — ${overlay === "profile" ? "Close profile" : "Open profile"}`}
                aria-label="Profile"
              >
                {authUser.avatarUrl ? (
                  <img src={authUser.avatarUrl} alt={authUser.login} className="header-avatar" />
                ) : (
                  <span className="header-avatar-letter">{authUser.login[0].toUpperCase()}</span>
                )}
              </button>
            ) : (
              <button
                className="header-sign-in"
                onClick={() => vscode.postMessage({ type: "auth/login" })}
                title="Sign in with GitHub"
              >
                <svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13">
                  <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/>
                </svg>
                Sign in
              </button>
            )}
            <button
              className={`header-icon-btn ${overlay === "subscription" ? "active" : ""}`}
              onClick={() => setOverlay(overlay === "subscription" ? null : "subscription")}
              title={overlay === "subscription" ? "Close subscription" : "Subscription"}
              aria-label="Subscription"
              aria-pressed={overlay === "subscription"}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v10M9 10h5a2 2 0 010 4h-4a2 2 0 000 4h5" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </div>

        {fileName && (
          <div className="context-pill" title={fileName}>
            <span className="dot" />
            {shortPath(fileName)}
          </div>
        )}

        <div className="tabs">
          <button
            className={`tab ${mode === "chat" && !overlay && !streakOpen ? "active" : ""}`}
            onClick={() => {
              setMode("chat");
              setOverlay(null);
              setStreakOpen(false);
            }}
          >
            {mode === "chat" && !overlay && !streakOpen && <span className="tab-dot" />}
            Chat
          </button>
          <button
            className={`tab ${mode === "echo" && !overlay && !streakOpen ? "active" : ""}`}
            onClick={() => {
              setMode("echo");
              setOverlay(null);
              setStreakOpen(false);
            }}
          >
            {mode === "echo" && !overlay && !streakOpen && <span className="tab-dot" />}
            Echo
          </button>
          {SHOW_CODEIQ_TAB && (
            <button
              className={`tab ${mode === "concepts" && !overlay && !streakOpen ? "active" : ""}`}
              onClick={() => {
                setMode("concepts");
                setOverlay(null);
                setStreakOpen(false);
              }}
            >
              {mode === "concepts" && !overlay && !streakOpen && <span className="tab-dot" />}
              Code IQ
            </button>
          )}
          <button
            className={`tab ${mode === "live" && !overlay && !streakOpen ? "active" : ""}`}
            onClick={() => {
              setMode("live");
              setOverlay(null);
              setStreakOpen(false);
            }}
          >
            {mode === "live" && !overlay && !streakOpen && <span className="tab-dot" />}
            Live
          </button>
          <button
            className={`tab ${mode === "map" && !overlay && !streakOpen ? "active" : ""}`}
            onClick={() => {
              setMode("map");
              setOverlay(null);
              setStreakOpen(false);
            }}
            title="Project Map — what matters in this codebase"
          >
            {mode === "map" && !overlay && !streakOpen && <span className="tab-dot" />}
            Map
          </button>
        </div>

      </header>

      {/* Architecture-tour session strip. Renders between header and
          tab content, visible on every tab so the user can switch to
          Chat to ask a question mid-tour without losing the session. */}
      <SessionStrip tour={tour} />

      {/* Explain-back (B1) overlay — takes over the sidebar content
          while active. Host is the single source of truth; closing
          posts `explainBack/stop` which clears session server-side and
          broadcasts `explainBack/state: null`, unmounting this panel. */}
      {explainBack && (
        <ExplainBackPanel
          session={explainBack}
          onClose={() => vscode.postMessage({ type: "explainBack/stop" })}
        />
      )}

      {/* Learning Mode overlay — same takeover pattern. Stop posts
          `learning/stop`, host broadcasts `learning/state: null`,
          this unmounts. */}
      {learning && (
        <LearningSessionPanel
          session={learning}
          devTrace={learningTrace}
          onClose={() => vscode.postMessage({ type: "learning/stop" })}
        />
      )}

      {streakOpen ? (
        <div className="streak-inline">
          <StreakJournal
            currentStreak={streak.current}
            longestStreak={streak.longest}
          />
        </div>
      ) : mode === "chat" && chatInputMode === "text" && chatHistoryOpen ? (
        <ChatHistoryPanel
          messages={
            historyPanelMessages.length > 0
              ? historyPanelMessages
              : messages
          }
          onJumpTo={(id: string) => {
            // If the clicked message is already in the current chat
            // view, just scroll to it. If it's NOT (e.g. it belongs to
            // a previous session the user had cleared via "New chat"),
            // restore the full persisted history into the view first
            // so the scroll target exists, then scroll.
            const inView = messages.some((m) => m.id === id);
            if (!inView && historyPanelMessages.length > 0) {
              setMessages(historyPanelMessages);
            }
            setChatHistoryOpen(false);
            // Wait one paint for the chat body to remount, then scroll
            requestAnimationFrame(() => {
              const el = document.getElementById(`msg-${id}`);
              if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
            });
          }}
          onClose={() => setChatHistoryOpen(false)}
          onClearAll={() => {
            if (confirm("Delete all chat history? This cannot be undone.")) {
              setMessages([]);
              vscode.postMessage({ type: "chat/clearHistory" });
              setChatHistoryOpen(false);
            }
          }}
          onNewChat={() => {
            // "New chat" clears the current view but PRESERVES history.
            // The trash-icon button (onClearAll) is the only path that
            // wipes globalState — and it gates behind a confirm dialog.
            // Previous behavior nuked everything on "New chat" click,
            // which was indistinguishable from a delete-all by accident.
            setMessages([]);
            setChatHistoryOpen(false);
          }}
        />
      ) : mode === "chat" ? (
        <>
          {/* ---- Chat toolbar (always shown in chat mode so the history
               icon is reachable even after "New chat" emptied the view).
               Search moved INTO ChatHistoryPanel — it only appears when
               the user has actually opened the history. */}
          <ChatSearchBar
            onOpenHistory={() => {
              // Fetch fresh persisted history from the host whenever
              // the panel opens. Pre-fix this used `messages` state,
              // which meant "New chat" (which now only clears the
              // view) also hid all historical chats from the panel
              // until reload — this round-trip fixes that.
              vscode.postMessage({ type: "chat/getFullHistory" });
              setChatHistoryOpen(true);
            }}
            onNewChat={() => {
              // Preserve history — see ChatHistoryPanel handler above.
              setMessages([]);
            }}
          />
          {isEmpty ? (
            <div className="messages">
              <div className="empty">
                <CinematicPlate
                  image="electricRoses"
                  caption="WHERE KNOWLEDGE BEGINS"
                  ratio="4:3"
                  intensity={0.6}
                  headline={
                    <>
                      What do you want<br />
                      to <span className="accent">learn</span> today?
                    </>
                  }
                />
                <div className="empty-sub">
                  Ask about the file you have open, or pick one below.
                </div>
                <div className="prompts">
                  {QUICK_PROMPTS.map((p) => (
                    <button
                      key={p.label}
                      className="prompt-btn"
                      onClick={() => sendMessage(p.label)}
                    >
                      <span className="prompt-icon">{p.icon}</span>
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="messages">
              {messages.map((m) => {
                const { clean, followups, fork } =
                  m.role === "assistant"
                    ? parseAssistantExtras(m.content)
                    : { clean: m.content, followups: [] as string[], fork: null };
                const forkAvailable =
                  fork && !forkResolved[m.id] && m.role === "assistant";
                return (
                  <div key={m.id} id={`msg-${m.id}`} className={`msg msg-${m.role}`}>
                    <div className="role">
                      {m.role === "user" ? "You" : "Protege"}
                      {m.source === "voice" && (
                        <span
                          className="msg-source-voice"
                          title={
                            m.role === "user"
                              ? "You said this (voice input)"
                              : "Protege spoke this reply"
                          }
                          aria-label="voice"
                        >
                          <IconMic size={11} />
                        </span>
                      )}
                    </div>
                    <div className="content">
                      {/* Both roles get full markdown rendering — user
                          prompts often contain inline backticks, **bold**,
                          and fenced code (especially when they originate
                          from gutter buttons like "Fix it"). Rendering
                          plain text dropped all of that to literal chars. */}
                      <AssistantMarkdown content={clean} />
                    </div>
                    {forkAvailable && fork && (
                      <div className="learning-fork">
                        <button
                          className="fork-btn fork-btn--primary"
                          onClick={() =>
                            handleForkChoice("just-do-it", fork.goal, m.id)
                          }
                          disabled={loading}
                          title="Protege writes the code; you skim the diff"
                        >
                          ◎ Just do it
                        </button>
                        <button
                          className="fork-btn fork-btn--secondary"
                          onClick={() =>
                            handleForkChoice("learn", fork.goal, m.id)
                          }
                          disabled={loading}
                          title="Step-by-step plan; you write each step, Protege validates"
                        >
                          ✿ Learn it with me
                        </button>
                      </div>
                    )}
                    {followups.length > 0 && !loading && !forkAvailable && (
                      <div className="followups">
                        {followups.map((f, i) => (
                          <button
                            key={i}
                            className="followup-chip"
                            onClick={() => sendMessage(f)}
                            disabled={loading}
                          >
                            {f}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
              {loading && (
                <div className="msg msg-assistant">
                  <div className="role">Protege</div>
                  <div className="content">
                    {toolActivity.length > 0 ? (
                      <div className="tool-activity">
                        {toolActivity.map((t, i) => (
                          <div
                            key={i}
                            className={`tool-row tool-${t.status} tool-kind-${toolKind(t.name)}`}
                          >
                            <span className="tool-icon">
                              {t.status === "running" ? (
                                <span className="tool-dots">···</span>
                              ) : t.status === "done" ? (
                                toolKind(t.name) === "write" ? (
                                  <IconPencil size={11} strokeWidth={2.2} />
                                ) : (
                                  <IconCheck size={11} strokeWidth={2.6} />
                                )
                              ) : (
                                <IconX size={11} strokeWidth={2.6} />
                              )}
                            </span>
                            <span className="tool-name">{toolLabel(t.name, t.args)}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <span className="typing">
                        <span className="typing-dot" />
                        <span className="typing-dot" />
                        <span className="typing-dot" />
                      </span>
                    )}
                  </div>
                </div>
              )}
              {error && <div className="error">{error}</div>}
              <div ref={endRef} />
            </div>
          )}

          {/* Unified footer (2026-04-22): voice mode no longer takes over
              the entire bottom section with its own "PREPARING VOICE
              ENGINE" card. Instead, the SAME composer card hosts both —
              the textarea and the voice controls share the same rounded
              bordered box, the same focus ring, the same padding. Only
              the BODY swaps: textarea ↔ compact voice row. The actions
              row (mode toggle + hint + send) stays consistent so the
              user always has one-click access to switch back. */}
          <footer className={`composer composer-mode-${chatInputMode}`}>
            {chatInputMode === "voice" ? (
              <VoiceMode
                inline
                onSend={sendMessage}
                latestReply={lastAssistant}
                loading={loading}
                error={error}
                onSwitchToText={() => setChatInputMode("text")}
              />
            ) : (
              <textarea
                ref={inputRef}
                className="composer-input"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                placeholder={loading ? "Protege is thinking…" : "Ask about your code…"}
                rows={1}
                disabled={loading}
              />
            )}
            <div className="composer-actions">
              <div className="composer-actions-left">
                <div
                  className="mode-mini"
                  role="tablist"
                  aria-label="Chat modality"
                >
                  <button
                    role="tab"
                    aria-selected={chatInputMode === "text"}
                    className={`mode-mini-opt ${chatInputMode === "text" ? "active" : ""}`}
                    onClick={() => setChatInputMode("text")}
                    title="Text input"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z" />
                    </svg>
                  </button>
                  <button
                    role="tab"
                    aria-selected={chatInputMode === "voice"}
                    className={`mode-mini-opt ${chatInputMode === "voice" ? "active" : ""}`}
                    onClick={() => setChatInputMode("voice")}
                    title="Voice input"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="9" y="3" width="6" height="12" rx="3" />
                      <path d="M5 11a7 7 0 0014 0" />
                      <path d="M12 18v3" />
                    </svg>
                  </button>
                </div>
                <span className="microcaps composer-hint">
                  {loading
                    ? "thinking…"
                    : chatInputMode === "voice"
                      ? "tap orb · or say \"Protege\""
                      : "↵ send · ⇧↵ newline"}
                </span>
              </div>
              {chatInputMode === "text" && (
                <button
                  className="send-btn"
                  onClick={handleSend}
                  disabled={loading || !input.trim()}
                  aria-label="Send"
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M7 17L17 7" />
                    <path d="M9 7h8v8" />
                  </svg>
                </button>
              )}
            </div>
          </footer>
        </>
      ) : mode === "concepts" ? (
        <ConceptsTab
          codeIq={codeIq}
          maxIq={maxIq}
          bonusIq={bonusIq}
          totalConcepts={totalConcepts}
          ruleCount={ruleCount}
          concepts={topConcepts}
          clusters={clusters}
          recentGains={recentGains}
          streak={streak}
          dailyIq={dailyIq}
          milestones={milestones}
          recommendations={recommendations}
          pillars={pillars}
          iqV2={iqV2}
        />
      ) : mode === "live" ? (
        <LiveTab
          fileName={fileName}
          liveReviewOn={liveMode}
          onToggleLiveReview={() => {
            setLiveMode((m) => {
              const next = !m;
              vscode.postMessage({ type: "liveReview/toggle", active: next });
              return next;
            });
          }}
          modelStatus={modelStatus}
          explainMode={explainMode}
          onExplainModeChange={(mode) => {
            setExplainMode(mode);
            vscode.postMessage({ type: "explainMode/set", mode });
          }}
        />
      ) : mode === "map" ? (
        <MapTab
          activeTourPath={
            tour && tour.steps[tour.currentIndex]?.path
              ? tour.steps[tour.currentIndex].path
              : null
          }
        />
      ) : mode === "echo" ? (
        <EchoTab />
      ) : null}

      {/* Single persistent overlay — the backdrop stays mounted across panel
          switches so only the inner content cross-fades. Keyed by the current
          overlay value so page-in animation retriggers on panel change. */}
      <Overlay
        open={overlay !== null}
        onClose={() => setOverlay(null)}
      >
        <div className="overlay-panel" key={overlay ?? "none"}>
          <Suspense fallback={<div className="page-loading microcaps">Loading…</div>}>
            {overlay === "profile" && (
              <ProfilePage
                userName={authUser?.login ?? "User"}
                avatarUrl={authUser?.avatarUrl ?? null}
                memberSince="Apr 2026"
                codeIq={codeIq}
                maxIq={maxIq}
                totalConcepts={totalConcepts}
                ruleCount={ruleCount}
                streak={streak}
                milestones={milestones}
                recentGains={recentGains}
              />
            )}
            {overlay === "subscription" && (
              <SubscriptionPage
                plan="trial"
                trialDaysLeft={2}
                chatMessagesUsed={32}
                chatMessagesLimit={50}
                toolCallsUsed={3}
                toolCallsLimit={5}
                voiceMinutesUsed={6}
                voiceMinutesLimit={10}
              />
            )}
          </Suspense>
        </div>
      </Overlay>

      {tipDetail && (
        <TipDetailOverlay tip={tipDetail} onClose={() => setTipDetail(null)} />
      )}

    </div>
  );
}

function shortPath(full: string): string {
  const parts = full.split(/[\\/]/);
  return parts[parts.length - 1] || full;
}

/**
 * Extract <followups>…</followups> and <learningFork goal="…" /> blocks
 * from an assistant message. Returns the cleaned message (both tags
 * stripped) plus the parsed extras.
 */
function parseAssistantExtras(content: string): {
  clean: string;
  followups: string[];
  fork: { goal: string } | null;
} {
  let working = content;
  const followupsMatch = working.match(/<followups>([\s\S]*?)<\/followups>/i);
  let followups: string[] = [];
  if (followupsMatch && followupsMatch.index !== undefined) {
    followups = followupsMatch[1]
      .split("\n")
      .map((s) => s.replace(/^[-*•·]\s*/, "").trim())
      .filter((s) => s.length > 0 && s.length <= 120)
      .slice(0, 4);
    working =
      working.slice(0, followupsMatch.index) +
      working.slice(followupsMatch.index + followupsMatch[0].length);
  }
  // Self-closing `<learningFork goal="..." />` OR paired form (LLM may
  // close it either way). Goal attr is required; the tag without it is
  // meaningless so we ignore it.
  const forkMatch = working.match(
    /<learningFork\s+goal="([^"]+)"\s*(?:\/\s*>|><\/learningFork>)/i
  );
  let fork: { goal: string } | null = null;
  if (forkMatch && forkMatch.index !== undefined) {
    fork = { goal: forkMatch[1] };
    working =
      working.slice(0, forkMatch.index) +
      working.slice(forkMatch.index + forkMatch[0].length);
  }
  return { clean: working.trim(), followups, fork };
}

function toolLabel(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "read_file":
      return `Reading ${args.path ?? "file"}`;
    case "list_files":
      return `Listing files${args.pattern ? ` ${args.pattern}` : ""}`;
    case "grep":
      return `Searching${args.glob ? ` in ${args.glob}` : ""} for /${args.pattern}/`;
    case "show_code":
      return `Showing ${args.path} L${args.startLine}–${args.endLine}`;
    case "highlight_code": {
      const regions = (args.regions as Array<{ path?: string; kind?: string }> | undefined) ?? [];
      if (regions.length === 0) return "Highlighting code";
      if (regions.length === 1)
        return `Highlighting ${regions[0].kind ?? "focus"} in ${regions[0].path}`;
      return `Highlighting ${regions.length} regions`;
    }
    case "clear_highlights":
      return "Clearing highlights";
    case "edit_file":
      return `Editing ${args.path}`;
    case "create_file":
      return `Creating ${args.path}`;
    case "create_scratch_file":
      return `Writing lesson — ${args.name}`;
    case "run_file":
      return `Running ${args.path}`;
    default:
      return name;
  }
}

export function toolKind(name: string): "read" | "write" | "nav" | "teach" {
  if (name === "edit_file" || name === "create_file") return "write";
  if (name === "create_scratch_file" || name === "run_file") return "teach";
  if (name === "highlight_code" || name === "clear_highlights" || name === "show_code")
    return "nav";
  return "read";
}
