import React, { useEffect, useMemo, useState } from "react";
import type { ChatSession } from "@protege/types";
import { ChatSessionsList } from "./ChatSessionsList";

const SEARCH_DEBOUNCE_MS = 220;

interface Props {
  sessions: ChatSession[];
  currentSessionId: string | null;
  onSwitchSession: (id: string) => void;
  onRenameSession: (id: string, title: string) => void;
  onDeleteSession: (id: string) => void;
  onClose: () => void;
  onClearAll: () => void;
  onNewChat: () => void;
}

export function ChatHistoryPanel({
  sessions,
  currentSessionId,
  onSwitchSession,
  onRenameSession,
  onDeleteSession,
  onClose,
  onClearAll,
  onNewChat,
}: Props) {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");

  useEffect(() => {
    if (query === "") {
      setDebouncedQuery("");
      return;
    }
    const h = setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(h);
  }, [query]);

  const filtered = useMemo(() => {
    const q = debouncedQuery.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) => s.title.toLowerCase().includes(q));
  }, [sessions, debouncedQuery]);

  return (
    <div className="chp">
      <header className="chp-head">
        <div className="chp-head-main">
          <h2 className="chp-title">Chat history</h2>
          <span className="chp-meta">
            {filtered.length}{" "}
            {filtered.length === 1 ? "conversation" : "conversations"}
          </span>
        </div>
        <div className="chp-head-actions">
          <button
            className="chp-pill chp-pill-primary"
            onClick={onNewChat}
            title="Start a new chat"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
            <span>New chat</span>
          </button>
          <button
            className="chp-icon chp-icon-danger"
            onClick={onClearAll}
            title="Delete all history"
            aria-label="Delete all"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
            </svg>
          </button>
          <button
            className="chp-icon"
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

      <div className="chp-search">
        <div className="chp-search-box">
          <svg
            className="chp-search-icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.3-4.3" />
          </svg>
          <input
            className="chp-search-input"
            type="text"
            placeholder="Search your conversations"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          {query && (
            <button
              className="chp-search-clear"
              onClick={() => setQuery("")}
              title="Clear search"
              aria-label="Clear search"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      <div className="chp-body">
        <ChatSessionsList
          sessions={filtered}
          currentSessionId={currentSessionId}
          onSwitch={onSwitchSession}
          onRename={onRenameSession}
          onDelete={onDeleteSession}
        />
      </div>
    </div>
  );
}
