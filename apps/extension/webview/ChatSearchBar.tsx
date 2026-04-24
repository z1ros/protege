import React from "react";

/**
 * Chat toolbar — sits above the messages area.
 *
 * Layout (left spacer → buttons right-aligned):
 *   - "+ New chat" pill (clears the current chat view; preserves history)
 *   - Clock icon (opens the full-height ChatHistoryPanel with its own
 *     search input inside)
 *
 * History: the old inline search input was removed (2026-04-22). The
 * input only made sense after you had messages to search AND when the
 * main chat view was visible — users hit a dead-end after "New chat"
 * (toolbar hidden because the chat was empty) and couldn't find the
 * history icon. Search now lives inside the history panel where it
 * belongs, and this toolbar stays lean: two buttons that are ALWAYS
 * visible in chat mode so the history icon is always reachable.
 *
 * Filename kept (`ChatSearchBar`) to avoid disturbing every import
 * site; the component is now effectively a toolbar.
 */

interface Props {
  onOpenHistory: () => void;
  onNewChat: () => void;
}

export function ChatSearchBar({ onOpenHistory, onNewChat }: Props) {
  return (
    <div className="chat-search-wrap">
      <div className="chat-search-row">
        <div className="chat-toolbar-spacer" />
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
    </div>
  );
}
