import React, { useState, useMemo } from "react";
import type { ChatMessage } from "@protege/types";

/**
 * Chat search bar — sits above the messages area.
 *
 * Layout (left → right):
 *   - Search input (filters messages in real-time; dropdown shows matches)
 *   - "+ New chat" pill (starts a fresh chat; preserves history)
 *   - Clock icon (opens the full-height history panel)
 *
 * Design choice: the old inline history-browse dropdown was removed. The
 * history button now signals up via `onOpenHistory` so the PARENT can
 * render a full-height `ChatHistoryPanel` in place of the messages +
 * composer — way more room to browse past conversations.
 */

interface Props {
  messages: ChatMessage[];
  onJumpTo: (id: string) => void;
  onOpenHistory: () => void;
  onNewChat: () => void;
}

export function ChatSearchBar({
  messages,
  onJumpTo,
  onOpenHistory,
  onNewChat,
}: Props) {
  const [query, setQuery] = useState("");

  const results = useMemo(() => {
    if (!query.trim()) return [];
    const q = query.toLowerCase();
    return messages
      .filter((m) => m.content.toLowerCase().includes(q))
      .map((m) => {
        const idx = m.content.toLowerCase().indexOf(q);
        const start = Math.max(0, idx - 30);
        const end = Math.min(m.content.length, idx + query.length + 30);
        let snippet = m.content.slice(start, end);
        if (start > 0) snippet = "..." + snippet;
        if (end < m.content.length) snippet += "...";
        return { message: m, snippet };
      })
      .reverse()
      .slice(0, 20);
  }, [query, messages]);

  return (
    <div className="chat-search-wrap">
      <div className="chat-search-row">
        <div className="chat-search-input-wrap">
          <svg
            className="chat-search-icon"
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
            className="chat-search-input"
            type="text"
            placeholder="Search chat history..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button
              className="chat-search-clear"
              onClick={() => setQuery("")}
              title="Clear search"
            >
              &times;
            </button>
          )}
        </div>
        <button
          className="chat-new-btn"
          onClick={onNewChat}
          title="Start a new chat"
          aria-label="New chat"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 4v16M4 12h16" />
          </svg>
          <span>New chat</span>
        </button>
        <button
          className="chat-history-btn"
          onClick={onOpenHistory}
          title="Browse chat history"
          aria-label="Open history"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 6v6l4 2" />
          </svg>
        </button>
      </div>

      {/* Search results dropdown — inline, brief, jump-to-message */}
      {query && results.length > 0 && (
        <div className="chat-search-results">
          <div className="chat-search-count microcaps">
            {results.length} result{results.length === 1 ? "" : "s"}
          </div>
          {results.map((r) => (
            <button
              key={r.message.id}
              className="chat-search-result"
              onClick={() => {
                onJumpTo(r.message.id);
                setQuery("");
              }}
            >
              <span className="chat-search-role microcaps">
                {r.message.role === "user" ? "You" : "Protege"}
              </span>
              <span className="chat-search-snippet">{r.snippet}</span>
            </button>
          ))}
        </div>
      )}

      {query && results.length === 0 && (
        <div className="chat-search-results">
          <div className="chat-search-empty">No results for "{query}"</div>
        </div>
      )}
    </div>
  );
}
