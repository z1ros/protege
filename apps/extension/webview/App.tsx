import React, { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type {
  ChatMessage,
  ClusterSummary,
  ConceptRow,
  DailyIqPoint,
  Finding,
  GainEvent,
  MilestoneSummary,
  Recommendation,
  StreakInfo,
  UnpromptedNudge,
} from "@protege/types";
import { vscode, onHostMessage } from "./vscode.js";
import { VoiceMode } from "./VoiceMode.js";
import { ConceptsTab } from "./ConceptsTab.js";
import { CinematicPlate } from "./CinematicPlate.js";
import { Overlay } from "./Overlay.js";
// Overlay pages are heavy (cinematic hero + dashboard widgets) and only
// render when the user explicitly opens them via the header icons. Splitting
// them into their own chunks keeps the initial bundle lean.
const ProfilePage = lazy(() =>
  import("./ProfilePage.js").then((m) => ({ default: m.ProfilePage }))
);
const SettingsPage = lazy(() =>
  import("./SettingsPage.js").then((m) => ({ default: m.SettingsPage }))
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

type Mode = "chat" | "concepts";
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
  const [toast, setToast] = useState<GainEvent | null>(null);
  const [overlay, setOverlay] = useState<"profile" | "settings" | "subscription" | null>(null);
  const [nudges, setNudges] = useState<UnpromptedNudge[]>([]);

  const endRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const off = onHostMessage((msg) => {
      if (msg.type === "chat/append") {
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
      } else if (msg.type === "watcher/nudge") {
        setNudges((n) => [...n.slice(-4), msg.nudge]);
      } else if (msg.type === "watcher/dismiss") {
        setNudges((n) => n.filter((x) => x.id !== msg.id));
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
          <div className="brand-mark">
            <img src={protegeLogoUrl} alt="Protege" />
          </div>
          <div className="brand-text">
            <div className="brand-name">Protege</div>
            <div className="brand-tag">AI Mentor</div>
          </div>
          <div className="brand-spacer" />
          {streak.current > 0 && (
            <div
              className="streak-chip"
              title={`Longest: ${streak.longest} day${streak.longest === 1 ? "" : "s"}`}
            >
              <span className="streak-flame"><IconFlame size={12} /></span>
              <span className="streak-value">{streak.current}d</span>
            </div>
          )}
          <div
            className="iq-chip"
            title={`${totalConcepts} / ${ruleCount || "?"} concepts · max ${maxIq}${bonusIq > 0 ? ` · +${bonusIq} from milestones` : ""}`}
            style={{
              ["--iq-progress" as never]: `${Math.min(
                100,
                maxIq > 0 ? (codeIq / maxIq) * 100 : 0
              )}%`,
            }}
          >
            <span className="iq-label">Code IQ</span>
            <span className="iq-value">{codeIq}</span>
            <span className="iq-max">/ {maxIq}</span>
          </div>
          <div className="header-actions">
            <button
              className="header-icon-btn"
              onClick={() => setOverlay("profile")}
              title="Profile"
              aria-label="Profile"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <circle cx="12" cy="8" r="4" />
                <path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" strokeLinecap="round" />
              </svg>
            </button>
            <button
              className="header-icon-btn"
              onClick={() => setOverlay("subscription")}
              title="Subscription"
              aria-label="Subscription"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v10M9 10h5a2 2 0 010 4h-4a2 2 0 000 4h5" strokeLinecap="round" />
              </svg>
            </button>
            <button
              className="header-icon-btn"
              onClick={() => setOverlay("settings")}
              title="Settings"
              aria-label="Settings"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <circle cx="12" cy="12" r="3" />
                <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" strokeLinecap="round" />
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
            className={`tab ${mode === "chat" ? "active" : ""}`}
            onClick={() => setMode("chat")}
          >
            {mode === "chat" && <span className="tab-dot" />}
            Chat
          </button>
          <button
            className={`tab ${mode === "concepts" ? "active" : ""}`}
            onClick={() => setMode("concepts")}
          >
            {mode === "concepts" && <span className="tab-dot" />}
            Concepts
          </button>
        </div>

      </header>

      {mode === "chat" && chatInputMode === "text" ? (
        <>
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
                  <div key={m.id} className={`msg msg-${m.role}`}>
                    <div className="role">
                      {m.role === "user" ? "You" : "Protege"}
                    </div>
                    <div className="content">{clean}</div>
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
              {nudges.map((n) => (
                <div
                  key={n.id}
                  className={`nudge nudge-${n.severity}`}
                  data-trigger={n.triggerId}
                >
                  <div className="nudge-label">Protege · unprompted</div>
                  <div className="nudge-text">{n.text}</div>
                  <div className="nudge-actions">
                    {n.canEscalate && (
                      <button
                        className="nudge-btn nudge-engage"
                        onClick={() => {
                          vscode.postMessage({
                            type: "watcher/engage",
                            nudgeId: n.id,
                            triggerId: n.triggerId,
                            context: n.context,
                          });
                          setNudges((x) => x.filter((y) => y.id !== n.id));
                        }}
                      >
                        <IconCheck size={12} strokeWidth={2.6} />
                        <span>Help me</span>
                      </button>
                    )}
                    <button
                      className="nudge-btn nudge-dismiss"
                      onClick={() => {
                        vscode.postMessage({
                          type: "watcher/dismiss",
                          nudgeId: n.id,
                        });
                        setNudges((x) => x.filter((y) => y.id !== n.id));
                      }}
                    >
                      <IconX size={12} strokeWidth={2.6} />
                      <span>Dismiss</span>
                    </button>
                  </div>
                </div>
              ))}
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

      <Overlay
        open={overlay === "profile"}
        onClose={() => setOverlay(null)}
        animKey="profile"
      >
        <Suspense fallback={<div className="page-loading microcaps">Loading…</div>}>
          <ProfilePage
            userName="Yura"
            memberSince="Apr 2026"
            codeIq={codeIq}
            maxIq={maxIq}
            totalConcepts={totalConcepts}
            ruleCount={ruleCount}
            streak={streak}
            milestones={milestones}
            recentGains={recentGains}
          />
        </Suspense>
      </Overlay>

      <Overlay
        open={overlay === "settings"}
        onClose={() => setOverlay(null)}
        animKey="settings"
      >
        <Suspense fallback={<div className="page-loading microcaps">Loading…</div>}>
          <SettingsPage />
        </Suspense>
      </Overlay>

      <Overlay
        open={overlay === "subscription"}
        onClose={() => setOverlay(null)}
        animKey="subscription"
      >
        <Suspense fallback={<div className="page-loading microcaps">Loading…</div>}>
          <SubscriptionPage
            plan="free"
            chatMessagesUsed={47}
            chatMessagesLimit={200}
            toolCallsUsed={128}
            toolCallsLimit={500}
          />
        </Suspense>
      </Overlay>
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
