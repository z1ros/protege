/**
 * Pure decision: should the chat turn's terminal reply be spoken via TTS?
 *
 * Extracted from handleChat (webviewHost.ts) so it's unit-testable in
 * isolation. The handler still passes the same inputs and reads the same
 * boolean; behavior is preserved.
 *
 * Inputs:
 *   - effectiveMode    — what mode the chat ran in after voice-dialogue
 *                        promotions ("voice" | "voice-dialogue" |
 *                        "teaching" | "teaching-text" | "text")
 *   - teachStepWasCalled — true if the model used the teach_step tool
 *                          this turn (each step plays its own narration)
 *   - voiceChannel     — true if the input came through a voice channel
 *                        OR the wake-word listener is live; the user is
 *                        in a voice context even on typed turns
 *   - reply            — the assistant's terminal reply text
 *
 * Decision (in order):
 *   1. If teach_step was NOT called → speak iff mode is voice / voice-dialogue,
 *      OR teaching/teaching-text with a live voice channel and non-empty reply.
 *   2. If teach_step WAS called → suppress to avoid stacking voices over the
 *      per-step narrations, EXCEPT when the reply is a short closing
 *      question (≤280 chars, ends in `?`). Those are interactive follow-ups
 *      ("What are you trying to build — X or Y?"), not redundant summaries,
 *      and silencing them produced the "voice during explanation, text on
 *      the closer" UX bug the user reported.
 */
export interface ShouldSpeakInput {
  effectiveMode:
    | "text"
    | "voice"
    | "voice-dialogue"
    | "teaching"
    | "teaching-text";
  teachStepWasCalled: boolean;
  voiceChannel: boolean;
  reply: string;
}

export function decideShouldSpeak(input: ShouldSpeakInput): boolean {
  const trimmed = input.reply.trim();
  const replyHasText = trimmed.length > 0;

  const isShortClosingQuestion =
    replyHasText && trimmed.length <= 280 && /[?]\s*$/.test(trimmed);
  const teachStepBlocks =
    input.teachStepWasCalled && !isShortClosingQuestion;

  if (teachStepBlocks) return false;

  if (input.effectiveMode === "voice") return true;
  if (input.effectiveMode === "voice-dialogue") return true;
  if (
    input.effectiveMode === "teaching" &&
    input.voiceChannel &&
    replyHasText
  ) {
    return true;
  }
  if (
    input.effectiveMode === "teaching-text" &&
    input.voiceChannel &&
    replyHasText
  ) {
    return true;
  }
  return false;
}
