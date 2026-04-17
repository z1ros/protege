import React, { useState, useMemo } from "react";
import type { ChatMessage } from "@protege/types";

/**
 * Chat search bar + history browser.
 *
 * Sits above the messages area. Features:
 *   - Search input that filters messages in real-time
 *   - Day grouping headers (Today, Yesterday, Apr 14...)
 *   - Result count + jump-to-message on click
 *   - Clear history button
 */

interface Props {
  messages: ChatMessage[];
  onJumpTo: (id: string) => void;
  onClearHistory: () => void;
}

export function ChatSearchBar({ messages, onJumpTo, onClearHistory }: Props) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);

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

  // Group messages by day for the history browser
  const dayGroups = useMemo(() => {
    if (!expanded || query) return [];
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
                  month: "short",
                  day: "numeric",
                }),
        count: msgs.length,
        firstId: msgs[0].id,
      }));
  }, [expanded, query, messages]);

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
            onChange={(e) => {
              setQuery(e.target.value);
              if (e.target.value) setExpanded(false);
            }}
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
          className={`chat-history-btn ${expanded ? "active" : ""}`}
          onClick={() => {
            setExpanded(!expanded);
            setQuery("");
          }}
          title={expanded ? "Close history" : "Browse history"}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 6v6l4 2" />
          </svg>
        </button>
        <button
          className="chat-clear-btn"
          onClick={onClearHistory}
          title="Clear all history"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
          </svg>
        </button>
      </div>

      {/* Search results */}
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

      {/* History browser — grouped by day */}
      {expanded && !query && dayGroups.length > 0 && (
        <div className="chat-search-results">
          <div className="chat-search-count microcaps">
            {messages.length} messages across {dayGroups.length} day{dayGroups.length === 1 ? "" : "s"}
          </div>
          {dayGroups.map((g) => (
            <button
              key={g.date}
              className="chat-history-day"
              onClick={() => {
                onJumpTo(g.firstId);
                setExpanded(false);
              }}
            >
              <span className="chat-history-day-label">{g.label}</span>
              <span className="chat-history-day-count microcaps">
                {g.count} message{g.count === 1 ? "" : "s"}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
