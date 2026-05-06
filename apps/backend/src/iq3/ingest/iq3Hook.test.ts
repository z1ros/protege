import { describe, it, expect } from "vitest";
import type { EchoEvent } from "@protege/types";
import { _MATCHERS_FOR_TEST as MATCHERS } from "./iq3Hook.js";

/**
 * Per-matcher regression coverage for IQ3 ingest. These tests guard against
 * payload-shape drift between event producers (extension) and the matcher
 * predicates that generate matchKey strings consumed by the HMM.
 *
 * MatchKey strings are stable IDs referenced by likelihood tables — the tests
 * assert their exact text. Do not rename without updating likelihoods.
 */

function runMatchers(e: EchoEvent, recent: EchoEvent[] = []): string[] {
  const ctx = { recent };
  return MATCHERS.flatMap((m) => m(e, ctx));
}

describe("matcher: read_pattern_observed", () => {
  it("fires reads-high matchKey for 'deep' pattern", () => {
    const event = {
      type: "read_pattern_observed",
      ts: 1,
      pattern: "deep",
      msToFirstEdit: 35000,
      navCount: 3,
    } as unknown as EchoEvent;
    expect(runMatchers(event)).toContain(
      "file_opened.then.navigations>=2.then.first_text_change.afterMs>30s",
    );
  });

  it("fires reads-low matchKey for 'jump-in' pattern", () => {
    const event = {
      type: "read_pattern_observed",
      ts: 1,
      pattern: "jump-in",
      msToFirstEdit: 2000,
      navCount: 0,
    } as unknown as EchoEvent;
    expect(runMatchers(event)).toContain(
      "file_opened.then.first_text_change.withinMs<5s",
    );
  });

  it("fires neither for 'skim' (intentionally noncommittal)", () => {
    const event = {
      type: "read_pattern_observed",
      ts: 1,
      pattern: "skim",
      msToFirstEdit: 10000,
      navCount: 1,
    } as unknown as EchoEvent;
    const keys = runMatchers(event);
    expect(keys).not.toContain(
      "file_opened.then.navigations>=2.then.first_text_change.afterMs>30s",
    );
    expect(keys).not.toContain(
      "file_opened.then.first_text_change.withinMs<5s",
    );
  });
});

describe("matcher: paste_outcome_observed", () => {
  it("fires AI-paste no-edit matchKey for 'kept-as-is' on AI source", () => {
    const event = {
      type: "paste_outcome_observed",
      ts: 1,
      outcome: "kept-as-is",
      source: "ai-chat-output",
      chars: 7000,
    } as unknown as EchoEvent;
    expect(runMatchers(event)).toContain(
      "paste_classified.source=ai.size>=80lines.no_edit_within_60s",
    );
  });

  it("does not fire for non-AI source", () => {
    const event = {
      type: "paste_outcome_observed",
      ts: 1,
      outcome: "kept-as-is",
      source: "external",
      chars: 7000,
    } as unknown as EchoEvent;
    expect(runMatchers(event)).not.toContain(
      "paste_classified.source=ai.size>=80lines.no_edit_within_60s",
    );
  });

  it("does not fire for small AI paste", () => {
    const event = {
      type: "paste_outcome_observed",
      ts: 1,
      outcome: "kept-as-is",
      source: "ai-chat-output",
      chars: 500,
    } as unknown as EchoEvent;
    expect(runMatchers(event)).not.toContain(
      "paste_classified.source=ai.size>=80lines.no_edit_within_60s",
    );
  });

  it("does not fire when iterated", () => {
    const event = {
      type: "paste_outcome_observed",
      ts: 1,
      outcome: "iterated",
      source: "ai-chat-output",
      chars: 7000,
    } as unknown as EchoEvent;
    expect(runMatchers(event)).not.toContain(
      "paste_classified.source=ai.size>=80lines.no_edit_within_60s",
    );
  });

  it("accepts hypothetical future ai-* sources (e.g. ai-completion)", () => {
    const event = {
      type: "paste_outcome_observed",
      ts: 1,
      outcome: "kept-as-is",
      source: "ai-completion",
      chars: 7000,
    } as unknown as EchoEvent;
    expect(runMatchers(event)).toContain(
      "paste_classified.source=ai.size>=80lines.no_edit_within_60s",
    );
  });
});

describe("matcher: commit_detected", () => {
  function commit(message: string): EchoEvent {
    return {
      type: "commit_detected",
      ts: 1000,
      sha: "deadbeef",
      message,
      filesTouched: ["src/foo.ts"],
    } as unknown as EchoEvent;
  }

  it("fires WHY-keyword matchKey for long messages with explanatory words", () => {
    const keys = runMatchers(
      commit(
        "Refactor cache layer because connection pool starves at peak load due to TLS handshake.",
      ),
    );
    expect(keys).toContain("commit_detected.msg_chars>=80.contains_why_keyword");
  });

  it("does not fire WHY-keyword for long messages without explanatory words", () => {
    const keys = runMatchers(
      commit(
        "Refactor cache layer and update the connection pool config for the new TLS handshake path.",
      ),
    );
    expect(keys).not.toContain(
      "commit_detected.msg_chars>=80.contains_why_keyword",
    );
  });

  it("fires short-message matchKey for tiny commits", () => {
    expect(runMatchers(commit("wip"))).toContain(
      "commit_detected.msg_chars<20",
    );
  });

  it("fires conventional-format matchKey for `feat(scope): subject`", () => {
    expect(runMatchers(commit("feat(api): add cache layer"))).toContain(
      "commit_detected.msg_matches_conventional",
    );
  });

  it("fires conventional-format matchKey for `fix: subject` (no scope)", () => {
    expect(runMatchers(commit("fix: handle null user id"))).toContain(
      "commit_detected.msg_matches_conventional",
    );
  });

  it("fires wip-or-fix-only matchKey for `wip` / `fix` / `update`", () => {
    expect(runMatchers(commit("wip"))).toContain(
      "commit_detected.msg_matches_wip_or_fix_only",
    );
    expect(runMatchers(commit("Fix"))).toContain(
      "commit_detected.msg_matches_wip_or_fix_only",
    );
    expect(runMatchers(commit("update"))).toContain(
      "commit_detected.msg_matches_wip_or_fix_only",
    );
  });

  it("does not fire any matcher for an empty message besides the short-chars one", () => {
    const keys = runMatchers(commit(""));
    expect(keys).toContain("commit_detected.msg_chars<20");
    expect(keys).not.toContain(
      "commit_detected.msg_chars>=80.contains_why_keyword",
    );
    expect(keys).not.toContain("commit_detected.msg_matches_conventional");
  });
});

describe("matcher: chat_turn (post-F4)", () => {
  it("fires specific+long for long specific prompts", () => {
    const event = {
      type: "chat_turn",
      ts: 1000,
      intent: "specific",
      charCount: 150,
      containsStackTraceOrLineRef: false,
      containsConstraintWords: false,
      acceptedAi: false,
    } as unknown as EchoEvent;
    expect(runMatchers(event)).toContain(
      "chat_turn.intent=specific.charCount>=120",
    );
  });

  it("fires vague+short for vague tiny prompts", () => {
    const event = {
      type: "chat_turn",
      ts: 1000,
      intent: "vague",
      charCount: 20,
      containsStackTraceOrLineRef: false,
      containsConstraintWords: false,
      acceptedAi: false,
    } as unknown as EchoEvent;
    expect(runMatchers(event)).toContain("chat_turn.intent=vague.charCount<40");
  });

  it("fires debug+stack for debug prompts with stack-trace flag", () => {
    const event = {
      type: "chat_turn",
      ts: 1000,
      intent: "debug",
      charCount: 80,
      containsStackTraceOrLineRef: true,
      containsConstraintWords: false,
      acceptedAi: false,
    } as unknown as EchoEvent;
    expect(runMatchers(event)).toContain(
      "chat_turn.intent=debug.contains_stack_trace_or_line_ref",
    );
  });

  it("fires plan+constraints for plan prompts that include constraint words", () => {
    const event = {
      type: "chat_turn",
      ts: 1000,
      intent: "plan",
      charCount: 60,
      containsStackTraceOrLineRef: false,
      containsConstraintWords: true,
      acceptedAi: false,
    } as unknown as EchoEvent;
    expect(runMatchers(event)).toContain(
      "chat_turn.intent=plan.includes_constraints",
    );
  });
});

describe("matcher: ai_accept_outcome_observed", () => {
  it("fires no-edit matchKey for 'no-edit' outcome", () => {
    const event = {
      type: "ai_accept_outcome_observed",
      ts: 1,
      outcome: "no-edit",
      editFraction: 0,
    } as unknown as EchoEvent;
    expect(runMatchers(event)).toContain(
      "ai_suggestion_accepted.afterMs<2000.withoutEdit",
    );
  });

  it("fires iterated matchKey for editFraction >= 0.3", () => {
    const event = {
      type: "ai_accept_outcome_observed",
      ts: 1,
      outcome: "iterated",
      editFraction: 0.5,
    } as unknown as EchoEvent;
    expect(runMatchers(event)).toContain(
      "ai_suggestion_accepted.thenEditWithin30s.editFraction>=0.3",
    );
  });

  it("does NOT fire iterated matchKey for tiny editFraction", () => {
    const event = {
      type: "ai_accept_outcome_observed",
      ts: 1,
      outcome: "iterated",
      editFraction: 0.05,
    } as unknown as EchoEvent;
    expect(runMatchers(event)).not.toContain(
      "ai_suggestion_accepted.thenEditWithin30s.editFraction>=0.3",
    );
  });

  it("does NOT fire any matchKey when no-edit is accompanied by editFraction>0 (defensive)", () => {
    const event = {
      type: "ai_accept_outcome_observed",
      ts: 1,
      outcome: "no-edit",
      editFraction: 0.4,
    } as unknown as EchoEvent;
    // outcome takes precedence; no-edit always means withoutEdit
    expect(runMatchers(event)).toContain(
      "ai_suggestion_accepted.afterMs<2000.withoutEdit",
    );
    expect(runMatchers(event)).not.toContain(
      "ai_suggestion_accepted.thenEditWithin30s.editFraction>=0.3",
    );
  });
});
