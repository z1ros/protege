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
  // read_pattern_observed → reads-before-writes evidence
  // Replaces the pre-F3 file_opened/text_change windowed matcher. The
  // extension observes the open→nav→edit sequence locally and ships a
  // single rollup with the verdict pre-computed. matchKey strings are
  // byte-identical to the originals so HMM likelihoods are unchanged.
  (e) => {
    if (e.type !== "read_pattern_observed") return [];
    const pattern = (e as any).pattern;
    if (pattern === "deep") {
      return ["file_opened.then.navigations>=2.then.first_text_change.afterMs>30s"];
    }
    if (pattern === "jump-in") {
      return ["file_opened.then.first_text_change.withinMs<5s"];
    }
    return [];
  },

  // paste_outcome_observed → authorship-self evidence
  // Replaces the pre-F3 paste_classified "no_edit_within_60s" matcher
  // which tried to look forward in time using the recent buffer (broken
  // because future events haven't arrived yet at ingest time). The
  // extension now waits the 60s window locally and emits the verdict.
  (e) => {
    if (e.type !== "paste_outcome_observed") return [];
    const source = (e as any).source as string;
    const chars = (e as any).chars ?? 0;
    const isAi = typeof source === "string" && source.startsWith("ai-");
    if (!isAi || chars < 6000) return [];
    if ((e as any).outcome === "kept-as-is") {
      return ["paste_classified.source=ai.size>=80lines.no_edit_within_60s"];
    }
    return [];
  },

  // ai_accept_outcome_observed → authorship-self evidence
  // Replaces the pre-F3 ai_suggestion_accepted "withoutEdit / thenEdit"
  // matcher which had the same broken-future-lookup pattern. Extension
  // observes the 30s window and ships outcome + editFraction.
  (e) => {
    if (e.type !== "ai_accept_outcome_observed") return [];
    const outcome = (e as any).outcome;
    const editFraction = (e as any).editFraction ?? 0;
    if (outcome === "no-edit") {
      return ["ai_suggestion_accepted.afterMs<2000.withoutEdit"];
    }
    if (outcome === "iterated" && editFraction >= 0.3) {
      return ["ai_suggestion_accepted.thenEditWithin30s.editFraction>=0.3"];
    }
    return [];
  },

  // commit detected — message-quality matchers
  // Producer-side variant (packages/types/src/index.ts) emits the field as
  // `message: string`. Earlier matcher used `msg`/`msgChars` which never
  // existed on the wire, so commit quality was mis-scored.
  (e) => {
    if (e.type !== "commit_detected") return [];
    const out: string[] = [];
    const message = (e as any).message ?? "";
    const msgChars = message.length;
    if (msgChars >= 80 && /\b(because|since|to fix|due to|so that)\b/i.test(message)) {
      out.push("commit_detected.msg_chars>=80.contains_why_keyword");
    }
    if (msgChars < 20) out.push("commit_detected.msg_chars<20");
    if (/^[a-z]+(\(.+?\))?:\s/.test(message)) {
      out.push("commit_detected.msg_matches_conventional");
    }
    if (/^(wip|fix|update)$/i.test(message.trim())) {
      out.push("commit_detected.msg_matches_wip_or_fix_only");
    }
    return out;
  },

  // chat_turn — prompt-quality matchers
  (e) => {
    if (e.type !== "chat_turn") return [];
    const out: string[] = [];
    const charCount = (e as any).charCount ?? 0;
    const intent = (e as any).intent;
    if (intent === "specific" && charCount >= 120) {
      out.push("chat_turn.intent=specific.charCount>=120");
    }
    if (intent === "vague" && charCount < 40) {
      out.push("chat_turn.intent=vague.charCount<40");
    }
    if (intent === "debug" && (e as any).containsStackTraceOrLineRef) {
      out.push("chat_turn.intent=debug.contains_stack_trace_or_line_ref");
    }
    if (intent === "plan" && (e as any).containsConstraintWords) {
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

const AI_RELATED = new Set<string>([
  "chat_turn",
  "ai_suggestion_accepted",
  "paste_classified",
  "paste_outcome_observed",
  "ai_accept_outcome_observed",
]);

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

/** @internal Exposed for unit tests of individual matcher predicates.
 *  Do not import from production code paths. */
export const _MATCHERS_FOR_TEST: ReadonlyArray<Matcher> = MATCHERS;
