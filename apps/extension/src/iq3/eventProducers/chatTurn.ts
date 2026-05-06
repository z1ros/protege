import type { Iq3ChatTurnEvent } from "@protege/types";

/** Lightweight rule-based intent classifier. */
function classifyIntent(text: string): Iq3ChatTurnEvent["intent"] {
  const t = text.toLowerCase().trim();
  if (t.length < 20 && /^(fix|why|help|broken|ok|do)/.test(t)) return "vague";
  if (/\b(line\s+\d|stack\s+trace|error|exception|crash|why does)\b/.test(t)) return "debug";
  if (/\b(plan|design|architecture|approach|how should i|trade.?off)\b/.test(t)) return "plan";
  if (t.length >= 80 && /[?:]/.test(t)) return "specific";
  if (t.length >= 80) return "request";
  return "vague";
}

/**
 * Build a chat_turn event from an outgoing user message. Intended to be
 * called from wherever the chat panel currently dispatches the user
 * turn (search webviewHost.ts for the user-message branch).
 */
export function buildChatTurnEvent(text: string, ts = Date.now()): Iq3ChatTurnEvent {
  return {
    type: "chat_turn",
    ts,
    text,
    intent: classifyIntent(text),
    charCount: text.length,
    acceptedAi: false,
  };
}
