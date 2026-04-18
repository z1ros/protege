import React, { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type {
  ChatMessage,
  ClusterSummary,
  ConceptRow,
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
import { ChatSearchBar } from "./ChatSearchBar.js";
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
  IconFlame,
  IconZap,
  IconBug,
  IconSparkles,
  IconBook,
  IconCheck,
  IconX,
  IconPencil,
  IconStar,
  IconPlus,
} from "./icons.js";
import protegeLogoUrl from "./protege-logo.svg";

type Mode = "chat" | "concepts" | "live";
type ChatInputMode = "text" | "voice";

const QUICK_PROMPTS: Array<{ icon: React.ReactNode; label: string }> = [
  { icon: <IconZap size={14} />, label: "Explain this file to me" },
  { icon: <IconBug size={14} />, label: "Find bugs and issues" },
  { icon: <IconSparkles size={14} />, label: "How can I improve this code?" },
  { icon: <IconBook size={14} />, label: "Teach me something new" },
];

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
  const [streakOpen, setStreakOpen] = useState(false);
  const [modelStatus, setModelStatus] = useState<{
    ready: boolean;
    loading: boolean;
    error: string | null;
    downloadProgress: number;
  }>({ ready: false, loading: false, error: null, downloadProgress: 0 });
  const [tipDetail, setTipDetail] = useState<TipDetail | null>(null);
  // Theme state — "dark" (default) | "light" | "auto" (respects OS)
  // Persisted to localStorage so it survives reloads. The actual DOM
  // attribute update happens in a useEffect below; everything else in
  // the app reads theme via CSS variables (see styles/tokens.css).
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    const stored = typeof localStorage !== "undefined" ? localStorage.getItem("protege:theme") : null;
    return stored === "light" ? "light" : "dark";
  });

  const endRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const off = onHostMessage((msg) => {
      if (msg.type === "chat/history") {
        // Restore persisted history on mount — conversations survive reloads
        setMessages(msg.messages);
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
      }
    });
    vscode.postMessage({ type: "ready" });
    return off;
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

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

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("protege:theme", theme);
  }, [theme]);

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
    };
    setMessages((m) => [...m, user]);
    setError(null);
    vscode.postMessage({ type: "chat/send", message: trimmed, mode: chatInputMode });
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

  const lastAssistant = useMemo(
    () =>
      [...messages].reverse().find((m) => m.role === "assistant")?.content ??
      "",
    [messages]
  );

  const isEmpty = messages.length === 0;

  return (
    <div className="app">
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
            title={`Code IQ ${codeIq} / ${maxIq}${streak.current > 0 ? ` · ${streak.current}d streak (longest ${streak.longest}d)` : ""}`}
            onClick={() => streak.current > 0 && setStreakOpen((o) => !o)}
            style={{ cursor: streak.current > 0 ? "pointer" : "default" }}
          >
            {streak.current > 0 && (
              <>
                <span className="status-flame"><IconFlame size={11} /></span>
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
            <button
              className="header-icon-btn theme-toggle-btn"
              onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
              title={theme === "dark" ? "Switch to light" : "Switch to dark"}
              aria-label="Toggle theme"
            >
              {theme === "dark" ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <circle cx="12" cy="12" r="4" />
                  <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" strokeLinecap="round" />
                </svg>
              )}
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
        </div>

      </header>

      {mode === "chat" && chatInputMode === "text" ? (
        <>
          {/* ---- Chat search bar + history toggle ---- */}
          {!isEmpty && (
            <ChatSearchBar
              messages={messages}
              onJumpTo={(id: string) => {
                const el = document.getElementById(`msg-${id}`);
                if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
              }}
              onClearHistory={() => {
                if (confirm("Clear all chat history? This cannot be undone.")) {
                  setMessages([]);
                  vscode.postMessage({ type: "chat/clearHistory" });
                }
              }}
            />
          )}
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
                const { clean, followups } =
                  m.role === "assistant"
                    ? parseFollowups(m.content)
                    : { clean: m.content, followups: [] as string[] };
                return (
                  <div key={m.id} id={`msg-${m.id}`} className={`msg msg-${m.role}`}>
                    <div className="role">
                      {m.role === "user" ? "You" : "Protege"}
                    </div>
                    <div className="content">
                      {m.role === "assistant" ? (
                        <AssistantMarkdown content={clean} />
                      ) : (
                        clean
                      )}
                    </div>
                    {followups.length > 0 && !loading && (
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

          <footer className="composer">
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
              placeholder="Ask about your code…"
              rows={1}
            />
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
                    aria-selected={false}
                    className="mode-mini-opt"
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
                  {loading ? "thinking…" : "↵ send · ⇧↵ newline"}
                </span>
              </div>
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
            </div>
          </footer>
        </>
      ) : streakOpen ? (
        <div className="streak-inline">
          <StreakJournal
            currentStreak={streak.current}
            longestStreak={streak.longest}
          />
        </div>
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
        />
      ) : (
        <div className="voice-wrap">
          <VoiceMode
            onSend={sendMessage}
            latestReply={lastAssistant}
            loading={loading}
            error={error}
          />
          <div className="voice-mode-footer">
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
          </div>
        </div>
      )}

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
 * Extract <followups>…</followups> block from an assistant message.
 * Returns the cleaned message (without the block) and an array of chip labels.
 */
function parseFollowups(content: string): { clean: string; followups: string[] } {
  const match = content.match(/<followups>([\s\S]*?)<\/followups>/i);
  if (!match || match.index === undefined) {
    return { clean: content, followups: [] };
  }
  const followups = match[1]
    .split("\n")
    .map((s) => s.replace(/^[-*•·]\s*/, "").trim())
    .filter((s) => s.length > 0 && s.length <= 120)
    .slice(0, 4);
  const clean = (content.slice(0, match.index) + content.slice(match.index + match[0].length))
    .trim();
  return { clean, followups };
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
