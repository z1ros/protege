import React, { useMemo } from "react";
import type { ChatMessage } from "@protege/types";

/**
 * Full-height chat history browser. Takes over the chat body area when
 * the user clicks the "history" button — NOT a dropdown — so browsing
 * past conversations gets the full space it needs.
 *
 * Messages are grouped by day, newest first. Inside each day we show a
 * compact list of message previews (role · first 80 chars). Click any
 * row → jumps to that message in the chat and closes the panel.
 */

interface Props {
  messages: ChatMessage[];
  onJumpTo: (messageId: string) => void;
  onClose: () => void;
  onClearAll: () => void;
  onNewChat: () => void;
}

export function ChatHistoryPanel({
  messages,
  onJumpTo,
  onClose,
  onClearAll,
  onNewChat,
}: Props) {
  const dayGroups = useMemo(() => {
    const groups = new Map<string, ChatMessage[]>();
    for (const m of messages) {
      const date = m.createdAt.slice(0, 10);
      if (!groups.has(date)) groups.set(date, []);
      groups.get(date)!.push(m);
    }
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    return [...groups.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([date, msgs]) => ({
        date,
        label:
          date === today
            ? "Today"
            : date === yesterday
              ? "Yesterday"
              : new Date(date + "T00:00:00").toLocaleDateString(undefined, {
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                }),
        messages: msgs,
      }));
  }, [messages]);

  const totalMessages = messages.length;
  const totalDays = dayGroups.length;

  return (
    <div className="chat-history-panel">
      <header className="chp-head">
        <div className="chp-head-main">
          <h2 className="chp-title">Chat history</h2>
          <span className="chp-meta microcaps">
            {totalMessages} {totalMessages === 1 ? "message" : "messages"}
            {totalDays > 0 && (
              <>
                {" · "}
                {totalDays} {totalDays === 1 ? "day" : "days"}
              </>
            )}
          </span>
        </div>
        <div className="chp-head-actions">
          <button
            className="chp-action chp-action-primary"
            onClick={onNewChat}
            title="Start a new chat"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 4v16M4 12h16" />
            </svg>
            <span>New chat</span>
          </button>
          <button
            className="chp-action chp-action-danger"
            onClick={onClearAll}
            title="Delete all history"
            aria-label="Delete all"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
            </svg>
          </button>
          <button
            className="chp-action chp-action-close"
            onClick={onClose}
            title="Back to chat"
            aria-label="Close history"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      </header>

      <div className="chp-body">
        {dayGroups.length === 0 ? (
          <div className="chp-empty">
            <p className="chp-empty-title">No chat history yet</p>
            <p className="chp-empty-sub">
              Your past conversations will appear here once you start chatting.
            </p>
          </div>
        ) : (
          dayGroups.map((group) => (
            <section key={group.date} className="chp-day">
              <header className="chp-day-head">
                <span className="chp-day-label">{group.label}</span>
                <span className="chp-day-count microcaps">
                  {group.messages.length}{" "}
                  {group.messages.length === 1 ? "msg" : "msgs"}
                </span>
              </header>
              <ul className="chp-day-list">
                {group.messages.map((m) => {
                  const snippet = m.content
                    .replace(/\s+/g, " ")
                    .trim()
                    .slice(0, 120);
                  const time = new Date(m.createdAt).toLocaleTimeString(
                    undefined,
                    { hour: "numeric", minute: "2-digit" }
                  );
                  return (
                    <li key={m.id}>
                      <button
                        className={`chp-msg chp-msg-${m.role}`}
                        onClick={() => onJumpTo(m.id)}
                      >
                        <span className="chp-msg-role microcaps">
                          {m.role === "user" ? "You" : "Protege"}
                        </span>
                        <span className="chp-msg-snippet">
                          {snippet}
                          {m.content.length > 120 ? "…" : ""}
                        </span>
                        <span className="chp-msg-time microcaps">{time}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  );
}
