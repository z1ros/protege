/**
 * Sanitize an assistant reply before it goes to TTS.
 *
 * Even with a voice-tuned system prompt, the model will occasionally slip
 * in markdown, code fences, bullets, or overly long sentences. This runs
 * after the model replies and BEFORE we hand the text to TTS, so the
 * spoken output stays natural no matter what.
 *
 * Safe on non-voice mode too — just use it conditionally in routes/chat.ts.
 */

const MAX_SENTENCE_WORDS = 24;
const CODE_FENCE_REPLACEMENT = "I've highlighted it in the editor.";

export function sanitizeForVoice(raw: string): string {
  if (!raw) return raw;
  let text = raw;

  // Strip <followups> block — text-mode only.
  text = text.replace(/<followups>[\s\S]*?<\/followups>/gi, "").trim();

  // Replace full code fences with a spoken reference.
  text = text.replace(/```[\s\S]*?```/g, ` ${CODE_FENCE_REPLACEMENT} `);

  // Drop inline code backticks — keep the word, lose the marker.
  text = text.replace(/`([^`]+)`/g, "$1");

  // Strip markdown headers (#, ##, ###).
  text = text.replace(/^#{1,6}\s+/gm, "");

  // Strip emphasis markers (**bold**, *italic*, __bold__, _italic_).
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  text = text.replace(/\*([^*]+)\*/g, "$1");
  text = text.replace(/__([^_]+)__/g, "$1");
  text = text.replace(/(^|\s)_([^_]+)_/g, "$1$2");

  // Strip blockquote markers.
  text = text.replace(/^>\s?/gm, "");

  // Turn numbered list markers into clean sentence starts.
  // "1. Open the file" → "Open the file."
  text = text.replace(/^\s*\d+[\.\)]\s+/gm, "");

  // Turn bullet markers into clean sentence starts.
  text = text.replace(/^\s*[-*•]\s+/gm, "");

  // Collapse filename.ext dots → spoken form ("foo dot ts" is ugly, just
  // drop the extension when it's obvious. Keep the stem so "routes/chat.ts"
  // becomes "routes chat").
  text = text.replace(
    /\b([A-Za-z0-9_-]+)\.(ts|tsx|js|jsx|py|md|json|css|html|sh|bash)\b/g,
    "$1"
  );

  // Replace path slashes with the word "slash" is overkill — the model
  // usually says "the chat route" anyway. Just soften bare slashes.
  text = text.replace(/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)/g, "$1 $2");

  // Collapse repeated whitespace and newlines.
  text = text.replace(/\n{2,}/g, ". ");
  text = text.replace(/\n/g, " ");
  text = text.replace(/\s{2,}/g, " ").trim();

  // Split into sentences and trim any that are too long — insert a natural
  // pause by breaking on the nearest comma/conjunction within the first
  // MAX_SENTENCE_WORDS words.
  const sentences = splitSentences(text);
  const trimmed = sentences.flatMap((s) => softenSentence(s));

  return trimmed.join(" ").trim();
}

function splitSentences(text: string): string[] {
  // Very light-weight splitter — good enough for TTS pacing.
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * If a sentence is over MAX_SENTENCE_WORDS, try to break it at the first
 * comma, semicolon, em-dash, or natural conjunction after word 12. Falls
 * back to a hard split if no break point is found.
 */
function softenSentence(sentence: string): string[] {
  const words = sentence.split(/\s+/);
  if (words.length <= MAX_SENTENCE_WORDS) return [sentence];

  const breakers = /^(,|;|—|--|and|but|so|because|while|which|where)$/i;
  for (let i = 12; i < words.length - 3; i++) {
    const w = words[i].replace(/[.,;—]+$/, "");
    if (breakers.test(w) || words[i].endsWith(",")) {
      const left = words.slice(0, i).join(" ").replace(/[,;—]+$/, "") + ".";
      const right = words
        .slice(i + (breakers.test(w) ? 1 : 0))
        .join(" ");
      return [left, ...softenSentence(right)];
    }
  }

  // No break point found — hard split at MAX_SENTENCE_WORDS.
  const left = words.slice(0, MAX_SENTENCE_WORDS).join(" ") + ".";
  const right = words.slice(MAX_SENTENCE_WORDS).join(" ");
  return [left, ...softenSentence(right)];
}
