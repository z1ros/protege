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

describe("matcher: paste_classified", () => {
  it("fires AI-paste matchKey for ai-chat-output source with >=6000 chars and no follow-up edit", () => {
    const event = {
      type: "paste_classified",
      ts: 1000,
      file: "src/foo.ts",
      source: "ai-chat-output",
      chars: 6500,
    } as unknown as EchoEvent;
    const keys = runMatchers(event);
    expect(keys).toContain(
      "paste_classified.source=ai.size>=80lines.no_edit_within_60s",
    );
  });

  it("does not fire when source is not AI-shaped (clipboard/external)", () => {
    const event = {
      type: "paste_classified",
      ts: 1000,
      file: "src/foo.ts",
      source: "external",
      chars: 8000,
    } as unknown as EchoEvent;
    expect(runMatchers(event)).not.toContain(
      "paste_classified.source=ai.size>=80lines.no_edit_within_60s",
    );
  });

  it("does not fire when source is self-edit-paste even if large", () => {
    const event = {
      type: "paste_classified",
      ts: 1000,
      file: "src/foo.ts",
      source: "self-edit-paste",
      chars: 9000,
    } as unknown as EchoEvent;
    expect(runMatchers(event)).not.toContain(
      "paste_classified.source=ai.size>=80lines.no_edit_within_60s",
    );
  });

  it("does not fire when paste is small (chars < 6000)", () => {
    const event = {
      type: "paste_classified",
      ts: 1000,
      file: "src/foo.ts",
      source: "ai-chat-output",
      chars: 500,
    } as unknown as EchoEvent;
    expect(runMatchers(event)).not.toContain(
      "paste_classified.source=ai.size>=80lines.no_edit_within_60s",
    );
  });

  it("does not fire when a text_change appears within 60s after the paste", () => {
    const event = {
      type: "paste_classified",
      ts: 1000,
      file: "src/foo.ts",
      source: "ai-chat-output",
      chars: 7000,
    } as unknown as EchoEvent;
    const followup = {
      type: "text_change",
      ts: 30_000,
      path: "src/foo.ts",
    } as unknown as EchoEvent;
    expect(runMatchers(event, [followup])).not.toContain(
      "paste_classified.source=ai.size>=80lines.no_edit_within_60s",
    );
  });

  it("accepts hypothetical future ai-* sources (e.g. ai-completion)", () => {
    const event = {
      type: "paste_classified",
      ts: 1000,
      file: "src/foo.ts",
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

describe("matcher: ai_suggestion_accepted", () => {
  it("fires thenEdit matchKey when text_change follows within 30s", () => {
    const event = {
      type: "ai_suggestion_accepted",
      ts: 1000,
      file: "src/foo.ts",
      chars: 200,
    } as unknown as EchoEvent;
    const followup = {
      type: "text_change",
      ts: 5_000,
      path: "src/foo.ts",
    } as unknown as EchoEvent;
    expect(runMatchers(event, [followup])).toContain(
      "ai_suggestion_accepted.thenEditWithin30s.editFraction>=0.3",
    );
  });

  it("fires withoutEdit matchKey when no follow-up text_change is in the window", () => {
    const event = {
      type: "ai_suggestion_accepted",
      ts: 1000,
      file: "src/foo.ts",
      chars: 200,
    } as unknown as EchoEvent;
    expect(runMatchers(event)).toContain(
      "ai_suggestion_accepted.afterMs<2000.withoutEdit",
    );
  });
});
