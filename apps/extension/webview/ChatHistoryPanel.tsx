import React, { useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage } from "@protege/types";

/** Debounce window for search filtering. 220ms is the sweet spot: short
 *  enough that it feels instant when you pause, long enough that a
 *  medium-speed typer ("fiberoptic" at 5-6 chars/sec) doesn't trigger
 *  a re-filter on every keystroke. Anything below ~150ms started to
 *  feel like no debounce at all in testing; anything above ~350ms had
 *  a noticeable "wait, did my search register?" lag. */
const SEARCH_DEBOUNCE_MS = 220;

/** Infinite-scroll pagination. Show PAGE_SIZE turns initially; each
 *  scroll-to-bottom reveals PAGE_SIZE more. The data is already in
 *  memory (we fetched the full history up-front via chat/getFullHistory),
 *  so "loading" is synthetic — LOAD_DELAY_MS spreads the render cost
 *  and gives the user a real loading cue instead of an instant flash. */
const PAGE_SIZE = 15;
const LOAD_DELAY_MS = 280;

/**
 * Full-height chat history browser.
 *
 * Design (2026-04-22): groups consecutive user→assistant messages into
 * conversation "turn cards" so the list reads like past conversations —
 * not a flat log of individual messages. Each card shows the user's
 * question prominently and the assistant's reply as a muted two-line
 * preview. Click a card → jump to that turn in the chat.
 *
 * Messages are grouped by day first, then by turn within the day.
 * Search filters the underlying messages (either role matches).
 */

interface Props {
  messages: ChatMessage[];
  onJumpTo: (messageId: string) => void;
  onClose: () => void;
  onClearAll: () => void;
  onNewChat: () => void;
}

interface Turn {
  /** id of the first message in this turn — used as the scroll target */
  id: string;
  user: ChatMessage | null;
  assistant: ChatMessage | null;
  /** the createdAt of whichever message came first in this turn */
  createdAt: string;
}

/**
 * Collapse a flat message list into conversation turns. A turn starts
 * at a user message and extends through the following assistant reply.
 * Orphan assistants (reply without preceding user) or orphan users
 * (question without reply — common after an AI error) each form their
 * own single-role turn so nothing is hidden from the browser.
 */
function groupIntoTurns(msgs: ChatMessage[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;
  for (const m of msgs) {
    if (m.role === "user") {
      if (current) turns.push(current);
      current = { id: m.id, user: m, assistant: null, createdAt: m.createdAt };
    } else {
      if (current && !current.assistant) {
        current.assistant = m;
      } else {
        if (current) turns.push(current);
        current = {
          id: m.id,
          user: null,
          assistant: m,
          createdAt: m.createdAt,
        };
      }
    }
  }
  if (current) turns.push(current);
  return turns;
}

function compactSnippet(content: string, max: number): string {
  // Turn preview text — the panel shows two lines per card. Raw chat
  // content often contains triple-backtick fences and inline code;
  // slicing them raw produces ugly "```jsx\\nimport…" snippets. Two
  // transforms before length trimming:
  //   1. Replace fenced code blocks with a compact [code] marker.
  //   2. Strip inline backticks but keep their contents.
  // Full markdown still renders inside the chat itself — this is
  // purely preview text.
  let cleaned = content.replace(/```[\s\S]*?```/g, " [code] ");
  cleaned = cleaned.replace(/`([^`]+)`/g, "$1");
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  return cleaned.length > max ? cleaned.slice(0, max) + "…" : cleaned;
}

export function ChatHistoryPanel({
  messages,
  onJumpTo,
  onClose,
  onClearAll,
  onNewChat,
}: Props) {
  // Two states: `query` is what the user is typing (bound to the input
  // so every keystroke is visible), `debouncedQuery` is what drives
  // the actual filter. This keeps the filter from re-running on every
  // keystroke — results only update once the user has paused typing
  // for SEARCH_DEBOUNCE_MS, which feels way calmer than a jumpy list
  // that reshuffles on every keypress.
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");

  useEffect(() => {
    // Skip the debounce entirely when clearing — an empty query means
    // "show everything" and waiting 220ms for that feels unresponsive.
    if (query === "") {
      setDebouncedQuery("");
      return;
    }
    const handle = setTimeout(() => {
      setDebouncedQuery(query);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [query]);

  // Detect "user is still typing" state: they've typed something but
  // the debounced version hasn't caught up yet. Used to show a subtle
  // "…" hint in the header so they know a filter is about to apply.
  const isTyping = query !== debouncedQuery;

  const filtered = useMemo(() => {
    const q = debouncedQuery.trim().toLowerCase();
    if (!q) return messages;
    return messages.filter((m) => m.content.toLowerCase().includes(q));
  }, [messages, debouncedQuery]);

  // Day → list of turns (newest day first; turns also newest first).
  const dayGroups = useMemo(() => {
    const byDay = new Map<string, ChatMessage[]>();
    for (const m of filtered) {
      const date = m.createdAt.slice(0, 10);
      if (!byDay.has(date)) byDay.set(date, []);
      byDay.get(date)!.push(m);
    }
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    return [...byDay.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([date, msgs]) => {
        const turns = groupIntoTurns(msgs).reverse(); // newest turn first
        return {
          date,
          label:
            date === today
              ? "Today"
              : date === yesterday
                ? "Yesterday"
                : new Date(date + "T00:00:00").toLocaleDateString(undefined, {
                    weekday: "long",
                    month: "short",
                    day: "numeric",
                  }),
          turns,
        };
      });
  }, [filtered]);

  const totalMessages = messages.length;
  const totalTurns = useMemo(
    () => dayGroups.reduce((sum, d) => sum + d.turns.length, 0),
    [dayGroups]
  );
  // `isFiltering` keyed on the DEBOUNCED query so the empty-state
  // ("no matches for 'x'") doesn't flash during active typing while
  // the last debounced value was still empty. Pairs with `isTyping`
  // above which covers the "waiting for you to finish" state.
  const isFiltering = debouncedQuery.trim().length > 0;

  // ---- Pagination ----
  // `visibleCount` is how many turns we've revealed so far. We trim
  // the day groups in `visibleGroups` to fit within that budget,
  // preserving day headers but dropping turns beyond it.
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [loadingMore, setLoadingMore] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  // Reset the paging window whenever the underlying data or filter
  // changes — otherwise a search query filtered down to 3 results
  // would still show a "loading more" sentinel because visibleCount
  // was still carrying last session's 45.
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
    setLoadingMore(false);
    // Scroll the body back to the top when the filter shifts, so the
    // user sees the top match instead of staying halfway down.
    scrollContainerRef.current?.scrollTo({ top: 0 });
  }, [debouncedQuery, messages.length]);

  const hasMore = visibleCount < totalTurns;

  // IntersectionObserver — when the sentinel enters the viewport,
  // kick off a short "loading" state and then extend visibleCount by
  // one page. The delay is synthetic but matters: users perceive
  // instant reveal as "why is the list jumping?" — a brief spinner
  // makes the scroll feel paced.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const container = scrollContainerRef.current;
    if (!sentinel || !container || !hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry?.isIntersecting) return;
        if (loadingMore) return;
        setLoadingMore(true);
        const t = window.setTimeout(() => {
          setVisibleCount((c) => c + PAGE_SIZE);
          setLoadingMore(false);
        }, LOAD_DELAY_MS);
        return () => window.clearTimeout(t);
      },
      { root: container, threshold: 0.1, rootMargin: "120px" }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loadingMore]);

  // Slice day groups to fit within visibleCount. Days are consumed in
  // order (newest first); partial days keep their header but only
  // render their first N turns. Days entirely beyond the budget are
  // dropped — they'll come in as the user scrolls.
  const visibleGroups = useMemo(() => {
    let remaining = visibleCount;
    const out: typeof dayGroups = [];
    for (const g of dayGroups) {
      if (remaining <= 0) break;
      const slice = g.turns.slice(0, remaining);
      if (slice.length === 0) break;
      out.push({ ...g, turns: slice });
      remaining -= slice.length;
    }
    return out;
  }, [dayGroups, visibleCount]);

  return (
    <div className="chp">
      <header className="chp-head">
        <div className="chp-head-main">
          <h2 className="chp-title">Chat history</h2>
          <span className="chp-meta">
            {isTyping
              ? "Searching…"
              : isFiltering
                ? `${totalTurns} ${totalTurns === 1 ? "match" : "matches"}`
                : `${totalTurns} ${totalTurns === 1 ? "conversation" : "conversations"} · ${totalMessages} ${totalMessages === 1 ? "message" : "messages"}`}
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

      <div className="chp-body" ref={scrollContainerRef}>
        {dayGroups.length === 0 ? (
          isFiltering ? (
            <div className="chp-empty">
              <div className="chp-empty-mark">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <circle cx="11" cy="11" r="7" />
                  <path d="M21 21l-4.3-4.3" />
                </svg>
              </div>
              <p className="chp-empty-title">No matches for "{debouncedQuery}"</p>
              <p className="chp-empty-sub">
                Try a different keyword, or clear the search to see all history.
              </p>
            </div>
          ) : (
            <div className="chp-empty">
              <div className="chp-empty-mark">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  <path d="M8 11h8M8 15h5" />
                </svg>
              </div>
              <p className="chp-empty-title">No conversations yet</p>
              <p className="chp-empty-sub">
                Start a chat and it'll land here, grouped by day.
              </p>
            </div>
          )
        ) : (
          visibleGroups.map((group) => (
            <section key={group.date} className="chp-day">
              <div className="chp-day-head">
                <span className="chp-day-label">{group.label}</span>
                <span className="chp-day-count">
                  {group.turns.length}{" "}
                  {group.turns.length === 1 ? "conversation" : "conversations"}
                </span>
              </div>
              <ul className="chp-turns">
                {group.turns.map((t) => {
                  const time = new Date(t.createdAt).toLocaleTimeString(
                    undefined,
                    { hour: "numeric", minute: "2-digit" }
                  );
                  // Title-picking heuristic: if the user's message is
                  // a short confirmation ("yes", "ok", "got it", etc.)
                  // it makes a useless title — every reply card looks
                  // identical. In that case, swap the title and the
                  // preview: headline becomes the assistant's content
                  // (which has actual context like "Let's render the
                  // views with an index prefix"), and the muted preview
                  // line becomes the user's "yes". Long user messages
                  // keep the original layout.
                  const userText = t.user?.content?.trim() ?? "";
                  const wordCount = userText.split(/\s+/).filter(Boolean)
                    .length;
                  const userIsTooShort =
                    !userText ||
                    wordCount < 4 ||
                    /^(yes|yeah|yep|yup|no|nope|ok|okay|sure|cool|nice|right|exactly|perfect|great|got it|thanks|thx|ty|fine)\b[\s.!?]*$/i.test(
                      userText
                    );
                  const swapForTitle =
                    userIsTooShort && !!t.assistant?.content;
                  const title = swapForTitle
                    ? compactSnippet(t.assistant!.content, 110)
                    : t.user
                      ? compactSnippet(t.user.content, 110)
                      : "(assistant reply)";
                  const reply = swapForTitle
                    ? `You: ${compactSnippet(userText || "(empty)", 100)}`
                    : t.assistant
                      ? compactSnippet(t.assistant.content, 140)
                      : t.user
                        ? "No reply yet."
                        : "";
                  const variant = !t.user
                    ? "chp-turn--orphan"
                    : !t.assistant
                      ? "chp-turn--pending"
                      : "chp-turn--complete";
                  return (
                    <li key={t.id}>
                      <button
                        className={`chp-turn ${variant}`}
                        onClick={() => onJumpTo(t.id)}
                      >
                        <div className="chp-turn-head">
                          <span className="chp-turn-title">{title}</span>
                          <span className="chp-turn-time">{time}</span>
                        </div>
                        {reply && (
                          <p className="chp-turn-reply">
                            <span className="chp-turn-reply-label">
                              Protege
                            </span>
                            {reply}
                          </p>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}

        {/* Sentinel + pager footer. Shows one of three states:
            1. Loading next batch (spinner + label)
            2. More to load (invisible sentinel; IntersectionObserver
               triggers the load when the user scrolls near it)
            3. End of history (muted label, only when we've actually
               reached the bottom of a non-empty list) */}
        {dayGroups.length > 0 && (
          <div className="chp-pager">
            {loadingMore ? (
              <div className="chp-pager-loading" role="status" aria-live="polite">
                <span className="chp-spinner" aria-hidden="true" />
                <span>Loading more…</span>
              </div>
            ) : hasMore ? (
              <div
                ref={sentinelRef}
                className="chp-pager-sentinel"
                aria-hidden="true"
              />
            ) : (
              <div className="chp-pager-end">
                <span className="chp-pager-rule" aria-hidden="true" />
                <span>End of history</span>
                <span className="chp-pager-rule" aria-hidden="true" />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
