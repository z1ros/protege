import type { EchoEvent, Iq3UserState } from "@protege/types";
import { applyMatchKeys, initialUserState } from "../hmm.js";
import { getIq3UserStateRepo } from "../repo.js";

export interface IngestContext {
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
    // Skim pattern was previously silent — silence meant a persona who
    // mostly skims (a typical mid-tier reader) couldn't anchor their
    // readsBeforeWrites trait at "mid"; the trait drifted purely on
    // whatever deep/jump-in events also fired, often saturating. Wiring
    // the skim matchKey provides a moderate-positive anchor.
    if (pattern === "skim") {
      return ["file_opened.then.skim.first_text_change.afterMs>5s.afterMs<30s"];
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
  (e, ctx) => {
    if (e.type !== "commit_detected") return [];
    const out: string[] = [];
    const message = (e as any).message ?? "";
    const msgChars = message.length;
    const isConventional = /^[a-z]+(\(.+?\))?:\s/.test(message);
    if (msgChars >= 80 && /\b(because|since|to fix|due to|so that)\b/i.test(message)) {
      out.push("commit_detected.msg_chars>=80.contains_why_keyword");
    }
    if (msgChars < 20) out.push("commit_detected.msg_chars<20");
    if (isConventional) {
      out.push("commit_detected.msg_matches_conventional");
      // Long conventional commits without the explicit because/since
      // keyword are still strong rationale evidence. Real senior
      // commits often frame the why via "via X", "to prevent Y",
      // "for Z" rather than the keyword set above.
      if (msgChars >= 80) {
        out.push("commit_detected.msg_chars>=80.matches_conventional");
      }
    }
    if (/^(wip|fix|update)$/i.test(message.trim())) {
      out.push("commit_detected.msg_matches_wip_or_fix_only");
    }
    // Negative signal feeding Verification::runsTestsOften — was this
    // commit preceded by ANY test_run_result in the last 10 minutes?
    // If not, the user shipped without testing first. Uses only events
    // already in the stream (no new producer needed).
    const since = (e as any).ts - 10 * 60 * 1000;
    const hasRecentTest = ctx.recent.some(
      (r) =>
        r.type === "test_run_result" &&
        (r as any).ts >= since &&
        (r as any).ts <= (e as any).ts,
    );
    if (!hasRecentTest) {
      out.push("commit_detected.no_test_run.in_window=10min_before");
    }
    return out;
  },

  // chat_turn — prompt-quality matchers + correlation with prior AI accepts
  (e, ctx) => {
    if (e.type !== "chat_turn") return [];
    const out: string[] = [];
    const charCount = (e as any).charCount ?? 0;
    const intent = (e as any).intent;
    const ts = (e as any).ts;
    if (intent === "specific" && charCount >= 120) {
      out.push("chat_turn.intent=specific.charCount>=120");
    }
    if (intent === "vague" && charCount < 40) {
      out.push("chat_turn.intent=vague.charCount<40");
    }
    if (
      intent === "debug" &&
      (e as any).containsStackTraceOrLineRef &&
      charCount <= 1500
    ) {
      out.push("chat_turn.intent=debug.contains_stack_trace_or_line_ref");
      if (charCount >= 200 && charCount <= 1500) {
        out.push("chat_turn.contains_stack_trace.charCount>=200");
      }
    }
    if (intent === "plan" && (e as any).containsConstraintWords) {
      out.push("chat_turn.intent=plan.includes_constraints");
    }
    // Comprehension::asksClarifyingQuestions — turn carries a real
    // question with substance. Producer flag gates trailing-? noise.
    if ((e as any).containsQuestionMark && charCount >= 60) {
      out.push("chat_turn.contains_question_mark.charCount>=60");
    }
    // Plan-intent prompt that lands BEFORE any text_change in the
    // session window is evidence of "thinks before writes." We approx
    // "before first edit" via the rolling 30-min recent buffer.
    if (intent === "plan") {
      const since = ts - 30 * 60 * 1000;
      const editedRecently = ctx.recent.some(
        (r) => r.type === "text_change" && (r as any).ts >= since,
      );
      if (!editedRecently) {
        out.push("chat_turn.intent=plan.before_first_edit");
      }
    }
    // Request-intent without a prior question in the same window —
    // negative signal for asksClarifyingQuestions.
    if (intent === "request") {
      const since = ts - 30 * 60 * 1000;
      const priorQuestion = ctx.recent.some(
        (r) =>
          r.type === "chat_turn" &&
          (r as any).ts >= since &&
          ((r as any).containsQuestionMark === true ||
            (r as any).intent === "plan"),
      );
      if (!priorQuestion) {
        out.push("chat_turn.intent=request.no_prior_question");
      }
    }
    // AI Partnership::explainsAfterAccept — chat_turn within 15 min
    // of an AI accept that asks for an explanation (debug intent OR
    // explicit explain phrasing). Two separate matchKeys; emit either
    // when the correlation fires.
    const acceptWindow = 15 * 60 * 1000;
    const hadRecentAccept = ctx.recent.some(
      (r) =>
        r.type === "ai_suggestion_accepted" &&
        (r as any).ts >= ts - acceptWindow,
    );
    if (hadRecentAccept) {
      if (intent === "debug") {
        out.push(
          "ai_suggestion_accepted.then.chat_turn.intent=debug.in_window=15min",
        );
      }
      if ((e as any).containsExplainKeyword) {
        out.push(
          "ai_suggestion_accepted.then.chat_turn.contains_explain_keyword.in_window=15min",
        );
      }
    }
    return out;
  },

  // editor_navigation — session_count matchers feeding navigatesBySymbols.
  // Window: 30 minutes (matches the test_run_result session pattern).
  // Distinguishes "navigates by symbols" (high-signal: def-jump,
  // symbol-search) from "bounces between files" (low-signal: many
  // file-bounces with no def-jump). Without these matchers, the
  // navigatesBySymbols trait sat at the uniform prior forever and
  // silently capped the Comprehension pillar at ~752.
  (e, ctx) => {
    if (e.type !== "editor_navigation") return [];
    const since = (e as any).ts - 30 * 60 * 1000;
    const recent = ctx.recent.filter(
      (r) => r.type === "editor_navigation" && (r as any).ts >= since,
    );
    const defJumps = recent.filter((r) => (r as any).kind === "def-jump").length;
    const symbolSearches = recent.filter(
      (r) => (r as any).kind === "symbol-search",
    ).length;
    const fileBounces = recent.filter(
      (r) => (r as any).kind === "file-bounce",
    ).length;
    const out: string[] = [];
    if ((e as any).kind === "def-jump" && defJumps >= 3) {
      out.push("editor_navigation.kind=def-jump.session_count>=3");
    }
    if ((e as any).kind === "symbol-search" && symbolSearches >= 2) {
      out.push("editor_navigation.kind=symbol-search.session_count>=2");
    }
    if (
      (e as any).kind === "file-bounce" &&
      fileBounces >= 10 &&
      defJumps === 0
    ) {
      out.push(
        "editor_navigation.kind=file-bounce.session_count>=10.no_def-jump",
      );
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

  // ========================================================================
  // Coverage expansion — matchers feeding traits that previously sat at the
  // uniform prior because nothing emitted their declared matchKeys. All use
  // events already in the EchoEvent stream; no new producers required.
  // ========================================================================

  // file_saved → Verification::writesTestFiles + Execution::compilesCleanOnSave.
  (e, ctx) => {
    if (e.type !== "file_saved") return [];
    const out: string[] = [];
    const path: string = (e as any).path ?? (e as any).file ?? "";
    const errorCount: number = (e as any).errorCount ?? 0;
    if (
      /\.(test|spec)\./i.test(path) ||
      /(\/__tests__\/|\/tests?\/|\/specs?\/)/i.test(path)
    ) {
      out.push("file_saved.path_matches_test_pattern");
    }
    // compilesCleanOnSave — clean save = strong evidence of high state;
    // many-error save = strong evidence of low state.
    if (errorCount === 0) {
      out.push("file_saved.errorCount=0");
    } else if (errorCount >= 5) {
      out.push("file_saved.errorCount>=5");
    }
    // Session-proportion variants — fire on a rolling window once we
    // have enough samples.
    const since = (e as any).ts - 60 * 60 * 1000;
    const recentSaves = ctx.recent.filter(
      (r) => r.type === "file_saved" && (r as any).ts >= since,
    );
    if (recentSaves.length >= 5) {
      const cleanProp =
        recentSaves.filter((r) => ((r as any).errorCount ?? 0) === 0).length /
        recentSaves.length;
      const noisyProp =
        recentSaves.filter((r) => ((r as any).errorCount ?? 0) >= 3).length /
        recentSaves.length;
      if (cleanProp >= 0.8) {
        out.push("file_saved.errorCount=0.session_proportion>=0.8");
      }
      if (noisyProp >= 0.4) {
        out.push("file_saved.errorCount>=3.session_proportion>=0.4");
      }
    }
    return out;
  },

  // concept_encountered → Execution::conceptDepth (rolling 30-day window).
  (e, ctx) => {
    if (e.type !== "concept_encountered") return [];
    const out: string[] = [];
    const since = (e as any).ts - 30 * 24 * 60 * 60 * 1000;
    const recent = ctx.recent.filter(
      (r) => r.type === "concept_encountered" && (r as any).ts >= since,
    );
    const distinct = new Set<string>();
    const distinctD3 = new Set<string>();
    let onlyD1 = true;
    for (const r of recent) {
      const cid = (r as any).conceptId ?? (r as any).concept ?? "";
      if (cid) distinct.add(cid);
      const diff = (r as any).difficulty;
      if (diff === 3) {
        distinctD3.add(cid);
        onlyD1 = false;
      } else if (diff !== 1 && diff !== undefined) {
        onlyD1 = false;
      }
    }
    if (distinct.size >= 20) {
      out.push("concept_encountered.distinct_count>=20.in_30days");
    } else if (distinct.size <= 3 && recent.length >= 5) {
      out.push("concept_encountered.distinct_count<=3.in_30days");
    }
    if (distinctD3.size >= 5) {
      out.push("concept_encountered.distinct_difficulty3_count>=5.in_30days");
    }
    if (onlyD1 && recent.length >= 10) {
      out.push("concept_encountered.only_difficulty1.in_30days");
    }
    return out;
  },

  // diagnostic_resolved → Diagnostics::errorResolutionFast +
  // Diagnostics::fixNotBandAid + Diagnostics::testsAfterError. Emitted as
  // matchKey strings using the original "error_cleared" naming so the
  // likelihood table doesn't have to be edited.
  (e, ctx) => {
    if (e.type !== "diagnostic_resolved") return [];
    const out: string[] = [];
    const ts = (e as any).ts;
    const file: string = (e as any).file ?? "";
    const line: number = (e as any).line ?? 0;
    const durMs = (e as any).durationMs ?? Infinity;
    if (durMs <= 60_000) {
      // Severity isn't tracked per resolve event today — use the
      // tighter 60s threshold conservatively as the high-severity
      // proxy. Adjust when severity carries through.
      out.push("error_cleared.duration_since_appeared<=60s.error_severity=high");
    }
    if (durMs <= 120_000) {
      out.push("error_cleared.duration_since_appeared<=120s");
    }
    if (durMs >= 900_000) {
      out.push("error_cleared.duration_since_appeared>=900s");
    }
    // testsAfterError — tests run within 15 min after resolve, OR test
    // file saved within 20 min after resolve.
    const win15 = 15 * 60 * 1000;
    const win20 = 20 * 60 * 1000;
    const ranTests = ctx.recent.some(
      (r) =>
        r.type === "test_run_result" &&
        (r as any).ts >= ts &&
        (r as any).ts <= ts + win15,
    );
    if (ranTests) {
      out.push("error_cleared.then.test_run_result.in_window=15min");
    }
    const savedTestFile = ctx.recent.some((r) => {
      if (r.type !== "file_saved") return false;
      const p: string = (r as any).path ?? (r as any).file ?? "";
      return (
        /\.(test|spec)\./i.test(p) &&
        (r as any).ts >= ts &&
        (r as any).ts <= ts + win20
      );
    });
    if (savedTestFile) {
      out.push("error_cleared.then.writesTestFile.in_window=20min");
    }

    // ============================================================
    // v3 (targeted): hypothesisDriven + fixNotBandAid via
    // appeared→resolved correlation. Pure backend computation over
    // events already in the stream — no new producers required.
    //
    // Strategy: find the corresponding diagnostic_appeared (same file
    // + line, within a 30-min window). Examine intervening events:
    //   - text_change events split by neighborhood (same file) vs
    //     anywhere → drives hypothesisDriven.
    //   - editor_navigation def-jump events during window → positive
    //     hypothesisDriven signal (followed the stack).
    //   - line_diff size proxy → drives fixNotBandAid (targeted vs
    //     broad fix).
    //   - test-file edits during window → fixNotBandAid positive
    //     ("test added with fix").
    // ============================================================
    const debugWindow = 30 * 60 * 1000;
    const appeared = [...ctx.recent].reverse().find(
      (r) =>
        r.type === "diagnostic_appeared" &&
        (r as any).file === file &&
        (r as any).line === line &&
        (r as any).ts >= ts - debugWindow &&
        (r as any).ts <= ts,
    );
    if (appeared) {
      const appearedTs = (appeared as any).ts;
      const interim = ctx.recent.filter(
        (r) => (r as any).ts >= appearedTs && (r as any).ts <= ts,
      );
      const editsAnywhere = interim.filter((r) => r.type === "text_change").length;
      const editsInNeighborhood = interim.filter(
        (r) => r.type === "text_change" && (r as any).file === file,
      ).length;
      const hadDefJump = interim.some(
        (r) => r.type === "editor_navigation" && (r as any).kind === "def-jump",
      );
      // Approximate fix size in lines from line_diff events in the
      // window (preferred) or by summing text_change charsAdded /60
      // as a fallback.
      const lineDiffLines = interim
        .filter((r) => r.type === "line_diff")
        .reduce(
          (sum, r) =>
            sum + ((r as any).linesAdded ?? 0) + ((r as any).linesRemoved ?? 0),
          0,
        );
      const fallbackLines = interim
        .filter((r) => r.type === "text_change")
        .reduce(
          (sum, r) =>
            sum +
            (((r as any).charsAdded ?? 0) + ((r as any).charsRemoved ?? 0)) / 60,
          0,
        );
      const totalLines = lineDiffLines > 0 ? lineDiffLines : fallbackLines;
      // Test-file edited during the debug window — proxy for
      // "with_test_added" (the matchKey says within 10 min after
      // clearing; our approximation is during the debug window since
      // we can't look forward past the resolve in ctx.recent).
      const testEdited = interim.some((r) => {
        if (r.type !== "text_change" && r.type !== "file_saved") return false;
        const p: string = (r as any).file ?? (r as any).path ?? "";
        return /\.(test|spec)\./i.test(p);
      });

      // hypothesisDriven matchKeys
      if (editsInNeighborhood > 0 && editsInNeighborhood <= 3) {
        out.push(
          "error_appeared.then.edits_in_error_neighborhood.count<=3.then.error_cleared",
        );
      }
      if (editsAnywhere >= 8) {
        out.push(
          "error_appeared.then.edits_anywhere.count>=8.then.error_cleared",
        );
      }
      if (editsAnywhere === 0 && ts - appearedTs > 30_000) {
        out.push("error_appeared.then.no_edit.duration>30s");
      }
      if (hadDefJump) {
        out.push("error_appeared.then.editor_navigation.kind=def-jump.before_edit");
      }

      // fixNotBandAid matchKeys
      if (totalLines > 0 && totalLines <= 5) {
        out.push("error_cleared.targeted_edit.line_count<=5");
      }
      if (totalLines >= 30) {
        out.push("error_cleared.broad_edit.line_count>=30");
      }
      if (testEdited) {
        out.push("error_cleared.with_test_added.in_window=10min");
      }
    }

    return out;
  },

  // diagnostic_appeared → Diagnostics::readsStackTrace second key —
  // navigation following the diagnostic counts as "tracing the stack."
  (e, ctx) => {
    if (e.type !== "diagnostic_appeared") return [];
    const out: string[] = [];
    const ts = (e as any).ts;
    const window = 5 * 60 * 1000;
    const navAfter = ctx.recent.some(
      (r) =>
        r.type === "editor_navigation" &&
        (r as any).kind === "def-jump" &&
        (r as any).ts >= ts &&
        (r as any).ts <= ts + window,
    );
    if (navAfter) {
      out.push(
        "error_appeared.then.editor_navigation.kind=def-jump.matches_stack_frame",
      );
    }
    // No-navigation 2-min stale signal — fires when an error has been
    // sitting for >120s with no navigation/edit response.
    const idleWindow = 120_000;
    const recentRespond = ctx.recent.some(
      (r) =>
        ((r.type === "editor_navigation" && (r as any).kind === "def-jump") ||
          r.type === "text_change") &&
        (r as any).ts >= ts &&
        (r as any).ts <= ts + idleWindow,
    );
    if (!recentRespond && Date.now() - ts > idleWindow) {
      out.push("error_appeared.no_navigation.duration>=120s");
    }
    return out;
  },

  // ai_suggestion_rejected → AI Partnership::overridesAiConfidently.
  (e, ctx) => {
    if (e.type !== "ai_suggestion_rejected") return [];
    const out: string[] = [];
    const ts = (e as any).ts;
    const since = ts - 30 * 60 * 1000;
    const sessionRejects = ctx.recent.filter(
      (r) => r.type === "ai_suggestion_rejected" && (r as any).ts >= since,
    ).length;
    if (sessionRejects >= 3) {
      out.push("ai_suggestion_rejected.session_count>=3");
    }
    return out;
  },

  // ai_suggestion_accepted (extend) → AI Partnership::iteratesOnAiOutput
  // counterpart matchKeys (the existing matcher emits the
  // authorshipSelf-shaped keys; we add the iteratesOnAiOutput-shaped
  // ones here from the same observed outcome).
  (e, ctx) => {
    if (e.type !== "ai_accept_outcome_observed") return [];
    const out: string[] = [];
    const outcome = (e as any).outcome;
    const editFraction = (e as any).editFraction ?? 0;
    if (outcome === "iterated" && editFraction >= 0.3) {
      out.push(
        "ai_suggestion_accepted.then.text_change.editFraction>=0.3.in_window=5min",
      );
    }
    if (outcome === "no-edit") {
      out.push("ai_suggestion_accepted.no_edit.in_window=30min");
    }
    return out;
  },

  // line_diff → Stewardship::removesDeadCode + Stewardship::commentsWhyNotWhat.
  // The line_diff event ships counts but not raw content, so comment-quality
  // signals here are coarse. Real-content analysis would require a producer
  // upgrade. We fire the conservative shapes only.
  (e, ctx) => {
    if (e.type !== "line_diff") return [];
    const out: string[] = [];
    const linesAdded = (e as any).linesAdded ?? 0;
    const linesRemoved = (e as any).linesRemoved ?? 0;
    // commit-level dead-code removal proxy — fired from line_diff so
    // that commit_detected enrichment isn't required to score this.
    // Counts fingerprints with sampleContent that look like commented-
    // out code if the producer included samples; otherwise rely on
    // raw line counts.
    if (linesRemoved > linesAdded * 1.5 && linesRemoved >= 5) {
      // Per-event proxy — accumulates via repeated line_diff events.
      // We re-emit this in commit_detected matcher with proper rolling
      // state too.
      out.push("commit_detected.lines_deleted>=lines_added.session_count>=2");
    }
    // Verification :: assertionDensity — count assertion-shaped calls
    // computed by the lineDiffer over newly-added lines. Producers
    // older than the assertionsAdded field will leave it undefined,
    // in which case we skip emission rather than infer.
    //
    // Cross-trigger on commit_detected as well, since the line_diff
    // event for a single save may not cross the 20-line bar but the
    // cumulative diff in a commit usually will. Here we only handle
    // the line_diff path; the commit-time accumulator is left for a
    // follow-up if assertionsAdded turns out to need rolling state.
    const assertionsAdded = (e as any).assertionsAdded;
    if (typeof assertionsAdded === "number") {
      if (assertionsAdded >= 3 && linesAdded >= 20) {
        out.push("line_diff.assertions_added>=3.lines_added>=20");
      } else if (assertionsAdded >= 2 && linesAdded >= 8) {
        // Milder positive — small test-file edits. Higher-bar matchKey
        // above takes precedence (no double-counting).
        out.push("line_diff.assertions_added>=2.lines_added>=8");
      } else if (assertionsAdded === 0 && linesAdded >= 50) {
        out.push("line_diff.assertions_added=0.lines_added>=50");
      }
    }
    return out;
  },

  // commit_detected (extension) — preCommitReads + writesTestFiles +
  // agenticFlowQuality + commentsWhyNotWhat (count-based proxies).
  (e, ctx) => {
    if (e.type !== "commit_detected") return [];
    const out: string[] = [];
    const ts = (e as any).ts;
    const filesTouched: string[] = (e as any).filesTouched ?? [];
    // preCommitReads — file_focus_change count in the 10-min window
    // before commit (proxy for "opened files"). Strong positive when
    // many files read first; strong negative when zero (committing blind).
    // EchoEvent union uses `file_focus_change`, not `file_opened` — the
    // earlier reference was a stale type from an older schema iteration.
    const preWindow = 10 * 60 * 1000;
    const opensInWindow = ctx.recent.filter(
      (r) =>
        r.type === "file_focus_change" &&
        (r as any).ts >= ts - preWindow &&
        (r as any).ts < ts,
    ).length;
    if (opensInWindow >= 3) {
      out.push(
        "commit_detected.recent_file_opens>=3.in_window=10min_before",
      );
    } else if (opensInWindow === 0) {
      out.push("commit_detected.no_file_opens.in_window=10min_before");
    }
    // writesTestFiles via touched paths — does this commit include
    // test files? Repeated commits doing so over the rolling session
    // window count toward the strong-state matchKeys.
    const TEST_RX = /\.(test|spec)\.|\/__tests__\/|\/tests?\/|\/specs?\//i;
    const testFiles = filesTouched.filter((p) => TEST_RX.test(p));
    const sinceSession = ts - 30 * 24 * 60 * 60 * 1000;
    const recentCommits = ctx.recent.filter(
      (r) => r.type === "commit_detected" && (r as any).ts >= sinceSession,
    );
    const commitsWithTestChanges = recentCommits.filter((r) => {
      const f: string[] = (r as any).filesTouched ?? [];
      return f.some((p) => TEST_RX.test(p));
    }).length;
    if (testFiles.length >= 2 && commitsWithTestChanges >= 3) {
      out.push("commit_detected.test_file_changes>=2.session_count>=3");
    }
    if (recentCommits.length >= 10 && commitsWithTestChanges === 0) {
      out.push("commit_detected.no_test_changes.session_count>=10");
    }
    if (filesTouched.length > 0) {
      const ratio = testFiles.length / filesTouched.length;
      if (ratio >= 0.5) {
        out.push("commit_detected.test_to_src_ratio>=0.5");
      }
    }
    // agenticFlowQuality — chat_turn intent=plan within 2hr before
    // this commit signals coherent agentic flow (planned work that
    // landed).
    const planWindow = 2 * 60 * 60 * 1000;
    const recentPlan = ctx.recent.some(
      (r) =>
        r.type === "chat_turn" &&
        (r as any).intent === "plan" &&
        (r as any).ts >= ts - planWindow &&
        (r as any).ts < ts,
    );
    if (recentPlan) {
      out.push("chat_turn.intent=plan.then.commit_detected.in_window=2hour");
    }
    return out;
  },

  // text_change → Comprehension::pausesBeforeLargeEdits via prior
  // keystroke_batch idle gap. A large text_change with a long quiet
  // gap before it = "paused to think." Short gap before a large
  // change = "burst typing" without thinking.
  (e, ctx) => {
    if (e.type !== "text_change") return [];
    const out: string[] = [];
    const ts = (e as any).ts;
    const charsAdded = (e as any).charsAdded ?? (e as any).chars ?? 0;
    if (charsAdded < 50) return out;
    // Find the most recent activity event before this text_change.
    let lastActivityTs = -Infinity;
    for (const r of ctx.recent) {
      if ((r as any).ts >= ts) continue;
      if (
        r.type === "keystroke_batch" ||
        r.type === "text_change" ||
        r.type === "editor_navigation"
      ) {
        if ((r as any).ts > lastActivityTs) lastActivityTs = (r as any).ts;
      }
    }
    if (lastActivityTs === -Infinity) return out;
    const idleMs = ts - lastActivityTs;
    if (idleMs >= 20_000) {
      out.push("before_text_change.size>=50chars.idle_duration>=20s");
    } else if (idleMs <= 2_000) {
      out.push("before_text_change.size>=50chars.idle_duration<=2s");
    }
    return out;
  },

  // v3 (targeted): commit_detected → Stewardship::refactorsWhileTouching.
  // Two matchKeys, both backend-only:
  //
  //   - touches_unrelated_files.with_classification=refactor — a commit
  //     whose message reads as a refactor AND touches multiple files
  //     across distinct directories. Strong positive: the user goes
  //     out of their way to clean up across boundaries.
  //
  //   - single_file.feature_only.session_count>=10 — many recent
  //     commits each landing on a single file with a feat: prefix.
  //     Negative signal: the user ships features but never refactors
  //     adjacent code while touching it.
  (e, ctx) => {
    if (e.type !== "commit_detected") return [];
    const out: string[] = [];
    const message: string = (e as any).message ?? "";
    const filesTouched: string[] = (e as any).filesTouched ?? [];
    const ts = (e as any).ts;

    const isRefactor =
      /\b(refactor|cleanup|rename|simplif|extract|deduplicate|consolidate)\b/i.test(
        message,
      );
    const dirs = new Set(
      filesTouched.map((f) => {
        const idx = f.lastIndexOf("/");
        return idx >= 0 ? f.slice(0, idx) : ".";
      }),
    );
    if (isRefactor && filesTouched.length >= 3 && dirs.size >= 2) {
      out.push(
        "commit_detected.touches_unrelated_files.with_classification=refactor",
      );
    }

    // Rolling 24-hour window of single-file feat-only commits.
    const since = ts - 24 * 60 * 60 * 1000;
    let recentSingleFileFeats = 0;
    for (const r of ctx.recent) {
      if (r.type !== "commit_detected") continue;
      if ((r as any).ts < since) continue;
      const m = (r as any).message ?? "";
      const fs = (r as any).filesTouched ?? [];
      if (fs.length === 1 && /^feat[(:]/i.test(m)) recentSingleFileFeats++;
    }
    if (recentSingleFileFeats >= 10) {
      out.push("commit_detected.single_file.feature_only.session_count>=10");
    }

    return out;
  },
];

const AI_RELATED = new Set<string>([
  "chat_turn",
  "ai_suggestion_accepted",
  "ai_suggestion_rejected",
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
 * Pure function: apply a batch of events to a user state through the
 * full matcher → HMM update pipeline. No I/O, no persistence — exposed
 * for the persona harness (`__personas__/`) so behavioral tests can run
 * deterministic event streams without touching disk or Supabase.
 *
 * The IngestContext (rolling event window) is taken explicitly so
 * callers can either supply a fresh context per run or thread one
 * across multiple calls to mimic a real session.
 */
export function applyEventsToState(
  state: Iq3UserState,
  events: EchoEvent[],
  ctx: IngestContext = { recent: [] },
): Iq3UserState {
  let next = state;
  for (const e of events) {
    ctx.recent.push(e);
    if (ctx.recent.length > 4000) ctx.recent.splice(0, ctx.recent.length - 4000);
    const allKeys: string[] = [];
    for (const m of MATCHERS) allKeys.push(...m(e, ctx));
    // Always pipe through `applyMatchKeys` so `eventCount` (and
    // `aiEventCount` for AI-tagged events) increments on every event,
    // even ones that don't fire any trait matcher. Previously the
    // function early-returned for non-AI no-match events, which left
    // `eventCount` stuck and kept users in `cold` maturity / pillars
    // pending forever despite real activity. The HMM update is a
    // no-op when `matchKeys` is empty, so this is cheap.
    next = applyMatchKeys(next, allKeys, {
      isAiEvent: AI_RELATED.has(e.type as string),
    });
  }
  return next;
}

/**
 * Per-user serialization queue.
 *
 * `ingestForUser` does load → mutate → save without database-level
 * locking. Two concurrent requests for the same user would interleave
 * and the second `save` would silently overwrite the first. The chain
 * below funnels every ingest for the same userId through a single
 * promise queue so reads always see the most recent committed state.
 *
 * Single-process only — multi-process deployments still need DB-level
 * concurrency control (Supabase optimistic update or row lock).
 */
const userIngestChains = new Map<string, Promise<unknown>>();

function withUserIngestLock<T>(
  userId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = userIngestChains.get(userId);
  const next = (async () => {
    if (prev) {
      try { await prev; } catch { /* ignore previous failure */ }
    }
    return fn();
  })();
  userIngestChains.set(userId, next);
  next.finally(() => {
    if (userIngestChains.get(userId) === next) userIngestChains.delete(userId);
  });
  return next;
}

/**
 * Process a batch of events for a single user. Loads state, applies all
 * matchers, saves state. Side-effect-only. Concurrent calls for the
 * same `userId` are serialized.
 */
export async function ingestForUser(
  userId: string,
  events: EchoEvent[],
): Promise<void> {
  return withUserIngestLock(userId, async () => {
    const repo = getIq3UserStateRepo();
    const ctx = getCtx(userId);
    const initial = (await repo.load(userId)) ?? initialUserState(userId);
    const next = applyEventsToState(initial, events, ctx);
    await repo.save(next);
  });
}

/** @internal Exposed for unit tests of individual matcher predicates.
 *  Do not import from production code paths. */
export const _MATCHERS_FOR_TEST: ReadonlyArray<Matcher> = MATCHERS;
