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

const STACK_RX = /\b(line\s+\d|stack\s+trace|error|exception|undefined|null|crash)\b/i;
const CONSTRAINT_RX = /\b(must|should|cannot|requires|constraint)\b/i;

/**
 * Build a chat_turn event from an outgoing user message. The raw prompt
 * text is NEVER persisted — only classifier output + boolean flags. This
 * is by design (PII / secret leakage prevention).
 */
export function buildChatTurnEvent(text: string, ts = Date.now()): Iq3ChatTurnEvent {
  return {
    type: "chat_turn",
    ts,
    intent: classifyIntent(text),
    charCount: text.length,
    containsStackTraceOrLineRef: STACK_RX.test(text),
    containsConstraintWords: CONSTRAINT_RX.test(text),
    acceptedAi: false,
  };
}
