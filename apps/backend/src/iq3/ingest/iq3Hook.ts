import type { EchoEvent } from "@protege/types";
import { applyMatchKeys, initialUserState } from "../hmm.js";
import { autoRepo } from "../persistence.js";

const repo = autoRepo();

interface IngestContext {
  /** rolling window of recent events for the same user (last 4000) */
  recent: EchoEvent[];
}

/** Producer: raw event → matchKey strings. */
type Matcher = (e: EchoEvent, ctx: IngestContext) => string[];

const MATCHERS: Matcher[] = [
  // file_opened then no edit for >30s w/ navigations → reads-before-writes
  (e, ctx) => {
    if ((e.type as string) !== "text_change") return [];
    const sameFile = ctx.recent
      .filter((r) => "path" in r && (r as any).path === (e as any).path)
      .slice(-20);
    const lastOpen = [...sameFile].reverse().find((r) => (r.type as string) === "file_opened");
    if (!lastOpen) return [];
    const elapsed = (e as any).ts - (lastOpen as any).ts;
    const navsBetween = sameFile.filter(
      (r) =>
        (r.type as string) === "editor_navigation" &&
        (r as any).ts > (lastOpen as any).ts &&
        (r as any).ts < (e as any).ts,
    );
    if (elapsed >= 30000 && navsBetween.length >= 2) {
      return ["file_opened.then.navigations>=2.then.first_text_change.afterMs>30s"];
    }
    if (elapsed < 5000) {
      return ["file_opened.then.first_text_change.withinMs<5s"];
    }
    return [];
  },

  // paste classified as AI source, large, unmodified within 60s
  (e, ctx) => {
    if (e.type !== "paste_classified") return [];
    const isLarge = (e as any).size >= 80;
    if ((e as any).source !== "ai" || !isLarge) return [];
    const since = (e as any).ts;
    const followups = ctx.recent.filter((r) => (r as any).ts > since && (r as any).ts < since + 60000);
    const hasEdit = followups.some((r) => (r.type as string) === "text_change");
    if (!hasEdit) return ["paste_classified.source=ai.size>=80lines.no_edit_within_60s"];
    return [];
  },

  // ai_suggestion_accepted with edit within 30s
  (e, ctx) => {
    if (e.type !== "ai_suggestion_accepted") return [];
    const within = ctx.recent.filter(
      (r) => (r.type as string) === "text_change" && (r as any).ts > (e as any).ts && (r as any).ts < (e as any).ts + 30000,
    );
    if (within.length === 0) {
      return ["ai_suggestion_accepted.afterMs<2000.withoutEdit"];
    }
    return ["ai_suggestion_accepted.thenEditWithin30s.editFraction>=0.3"];
  },

  // commit detected — message-quality matchers
  (e) => {
    if (e.type !== "commit_detected") return [];
    const out: string[] = [];
    const msg = (e as any).msg ?? "";
    const msgChars = (e as any).msgChars ?? msg.length;
    if (msgChars >= 80 && /\b(because|since|to fix|due to|so that)\b/i.test(msg)) {
      out.push("commit_detected.msg_chars>=80.contains_why_keyword");
    }
    if (msgChars < 20) out.push("commit_detected.msg_chars<20");
    if (/^[a-z]+(\(.+?\))?:\s/.test(msg)) {
      out.push("commit_detected.msg_matches_conventional");
    }
    if (/^(wip|fix|update)$/i.test(msg.trim())) {
      out.push("commit_detected.msg_matches_wip_or_fix_only");
    }
    return out;
  },

  // chat_turn — prompt-quality matchers
  (e) => {
    if (e.type !== "chat_turn") return [];
    const out: string[] = [];
    const text = (e as any).text ?? "";
    const charCount = (e as any).charCount ?? text.length;
    const intent = (e as any).intent;
    if (intent === "specific" && charCount >= 120) {
      out.push("chat_turn.intent=specific.charCount>=120");
    }
    if (intent === "vague" && charCount < 40) {
      out.push("chat_turn.intent=vague.charCount<40");
    }
    if (intent === "debug" && /\b(line|stack|error|undefined|null|exception)\b/i.test(text)) {
      out.push("chat_turn.intent=debug.contains_stack_trace_or_line_ref");
    }
    if (intent === "plan" && /\b(must|should|cannot|requires|constraint)\b/i.test(text)) {
      out.push("chat_turn.intent=plan.includes_constraints");
    }
    return out;
  },

  // test_run_result — runs-tests-often
  (e, ctx) => {
    if (e.type !== "test_run_result") return [];
    const since = (e as any).ts - 30 * 60 * 1000;
    const recentTests = ctx.recent.filter(
      (r) => r.type === "test_run_result" && (r as any).ts >= since,
    );
    const out: string[] = [];
    if ((e as any).trigger === "manual" && recentTests.length >= 3) {
      out.push("test_run_result.trigger=manual.session_count>=3");
    }
    if ((e as any).trigger === "save" && recentTests.length >= 3) {
      out.push("test_run_result.trigger=save.session_count>=3");
    }
    return out;
  },
];

const AI_RELATED = new Set<string>(["chat_turn", "ai_suggestion_accepted", "paste_classified"]);

const userContexts = new Map<string, IngestContext>();
function getCtx(userId: string): IngestContext {
  let c = userContexts.get(userId);
  if (!c) {
    c = { recent: [] };
    userContexts.set(userId, c);
  }
  return c;
}

/**
 * Process a batch of events for a single user. Loads state, applies all
 * matchers, saves state. Side-effect-only.
 */
export async function ingestForUser(
  userId: string,
  events: EchoEvent[],
): Promise<void> {
  const ctx = getCtx(userId);
  let state = (await repo.load(userId)) ?? initialUserState(userId);

  for (const e of events) {
    ctx.recent.push(e);
    if (ctx.recent.length > 4000) ctx.recent.splice(0, ctx.recent.length - 4000);
    const allKeys: string[] = [];
    for (const m of MATCHERS) allKeys.push(...m(e, ctx));
    if (allKeys.length === 0 && !AI_RELATED.has(e.type as string)) continue;
    state = applyMatchKeys(state, allKeys, {
      isAiEvent: AI_RELATED.has(e.type as string),
    });
  }
  await repo.save(state);
}
