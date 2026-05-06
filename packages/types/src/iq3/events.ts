/**
 * IQ3 introduces three new event variants. They compose into the existing
 * EchoEvent union via module augmentation (see end of file).
 *
 * - chat_turn: user sends a message to the AI; lets HMM see prompt quality
 * - test_run_result: VS Code test API run finished; verifies "runsTestsOften"
 * - editor_navigation: def jump / file bounce / symbol search; signals reading style
 */

export interface Iq3ChatTurnEvent {
  type: "chat_turn";
  ts: number;
  /** classifier output set by the producer */
  intent: "specific" | "vague" | "request" | "debug" | "plan";
  /** length of the prompt in characters (proxy for specificity) */
  charCount: number;
  /** producer-classified: prompt mentions an error/line/stack reference */
  containsStackTraceOrLineRef: boolean;
  /** producer-classified: prompt expresses a constraint or requirement */
  containsConstraintWords: boolean;
  /** whether this turn produced an "accept" downstream */
  acceptedAi: boolean;
}

export interface Iq3TestRunResultEvent {
  type: "test_run_result";
  ts: number;
  file: string;
  /** number of tests run */
  tests: number;
  /** number that passed */
  passed: number;
  /** total duration in ms */
  durationMs: number;
  /** trigger source: 'manual', 'save', 'ci-watch' */
  trigger: "manual" | "save" | "ci-watch";
}

export interface Iq3EditorNavigationEvent {
  type: "editor_navigation";
  ts: number;
  /** kind of navigation */
  kind: "def-jump" | "file-bounce" | "symbol-search" | "find-refs";
  /** source file (PII-redacted to relative path only) */
  fromFile: string;
  toFile: string;
  /** ms since the last text edit in the source file */
  msSinceEdit: number;
}

/**
 * Rollup: observed read pattern when a file was opened and edited.
 * Emitted by the extension after observing the open→edit sequence.
 * Privacy: no file paths, just classifier + counts.
 */
export interface Iq3ReadPatternEvent {
  type: "read_pattern_observed";
  ts: number;
  /** "deep" = >=30s + >=2 navigations before first edit (reads-high)
   *  "skim" = some delay or one nav (reads-mid)
   *  "jump-in" = first edit within 5s of open with no nav (reads-low) */
  pattern: "deep" | "skim" | "jump-in";
  /** ms between file_opened and first text_change */
  msToFirstEdit: number;
  /** count of editor_navigation events between open and first edit */
  navCount: number;
}

/**
 * Rollup: observed outcome of an AI-shaped paste after a 60s window.
 * Privacy: no pasted content; only outcome + source classification.
 */
export interface Iq3PasteOutcomeEvent {
  type: "paste_outcome_observed";
  ts: number;
  /** "kept-as-is" = no edits within 60s of paste (authorship-low)
   *  "iterated"   = edits within 60s (authorship-mid)
   *  "rejected"   = pasted content was undone within 60s (authorship-high) */
  outcome: "kept-as-is" | "iterated" | "rejected";
  /** original paste source (e.g. "ai-chat-output") */
  source: string;
  /** original paste size in characters */
  chars: number;
}

/**
 * Rollup: observed outcome of an ai_suggestion_accepted after a 30s window.
 * Privacy: no accepted content; only outcome metric.
 */
export interface Iq3AiAcceptOutcomeEvent {
  type: "ai_accept_outcome_observed";
  ts: number;
  /** "no-edit"  = no text_change within 30s (authorship-low)
   *  "iterated" = text_change within 30s with non-trivial editFraction (authorship-mid/high) */
  outcome: "no-edit" | "iterated";
  /** Estimated fraction of accepted text that was edited within window, 0..1.
   *  Approximation: chars changed in nearby text_change events / accepted chars. */
  editFraction: number;
}

/** Discriminated union of new IQ3 events. */
export type Iq3NewEvent =
  | Iq3ChatTurnEvent
  | Iq3TestRunResultEvent
  | Iq3EditorNavigationEvent
  | Iq3ReadPatternEvent
  | Iq3PasteOutcomeEvent
  | Iq3AiAcceptOutcomeEvent;
