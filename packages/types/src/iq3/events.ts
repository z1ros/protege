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

/** Discriminated union of new IQ3 events. */
export type Iq3NewEvent =
  | Iq3ChatTurnEvent
  | Iq3TestRunResultEvent
  | Iq3EditorNavigationEvent;
