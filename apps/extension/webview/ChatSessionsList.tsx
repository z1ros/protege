import React, { useState } from "react";
import type { ChatSession } from "@protege/types";

interface Props {
  sessions: ChatSession[];
  currentSessionId: string | null;
  onSwitch: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}

function groupByDay(sessions: ChatSession[]) {
  const byDay = new Map<string, ChatSession[]>();
  for (const s of sessions) {
    const d = s.lastMessageAt.slice(0, 10);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d)!.push(s);
  }
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  return [...byDay.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, list]) => ({
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
      sessions: list.sort((a, b) =>
        b.lastMessageAt.localeCompare(a.lastMessageAt),
      ),
    }));
}

export function ChatSessionsList({
  sessions,
  currentSessionId,
  onSwitch,
  onRename,
  onDelete,
}: Props) {
  const groups = groupByDay(sessions);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  if (groups.length === 0) {
    return (
      <div className="chp-empty">
        <p className="chp-empty-title">No conversations yet</p>
        <p className="chp-empty-sub">
          Start a chat and it'll land here, grouped by day.
        </p>
      </div>
    );
  }

  return (
    <>
      {groups.map((g) => (
        <section key={g.date} className="chp-day">
          <div className="chp-day-head">
            <span className="chp-day-label">{g.label}</span>
            <span className="chp-day-count">
              {g.sessions.length}{" "}
              {g.sessions.length === 1 ? "conversation" : "conversations"}
            </span>
          </div>
          <ul className="chp-sessions">
            {g.sessions.map((s) => {
              const time = new Date(s.lastMessageAt).toLocaleTimeString(
                undefined,
                { hour: "numeric", minute: "2-digit" },
              );
              const isActive = s.id === currentSessionId;
              const isEditing = editingId === s.id;
              return (
                <li
                  key={s.id}
                  className={`chp-session ${isActive ? "is-active" : ""}`}
                >
                  {isEditing ? (
                    <input
                      autoFocus
                      className="chp-session-edit"
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onBlur={() => {
                        if (draft.trim() && draft !== s.title)
                          onRename(s.id, draft.trim());
                        setEditingId(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter")
                          (e.target as HTMLInputElement).blur();
                        if (e.key === "Escape") setEditingId(null);
                      }}
                    />
                  ) : (
                    <button
                      className="chp-session-main"
                      onClick={() => onSwitch(s.id)}
                      onDoubleClick={() => {
                        setEditingId(s.id);
                        setDraft(s.title);
                      }}
                    >
                      <div className="chp-session-head">
                        <span className="chp-session-title">{s.title}</span>
                        <span className="chp-session-time">{time}</span>
                      </div>
                      <p className="chp-session-meta">
                        {s.messageCount}{" "}
                        {s.messageCount === 1 ? "message" : "messages"}
                      </p>
                    </button>
                  )}
                  <div className="chp-session-actions">
                    <button
                      className="chp-session-action"
                      title="Rename"
                      onClick={() => {
                        setEditingId(s.id);
                        setDraft(s.title);
                      }}
                      aria-label="Rename conversation"
                    >
                      ✎
                    </button>
                    <button
                      className="chp-session-action chp-session-action-danger"
                      title="Delete"
                      onClick={() => {
                        if (
                          confirm(
                            `Delete "${s.title}"? This cannot be undone.`,
                          )
                        ) {
                          onDelete(s.id);
                        }
                      }}
                      aria-label="Delete conversation"
                    >
                      🗑
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </>
  );
}
