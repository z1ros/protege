export * from "./concepts.js";
import type { Cluster, IqPillars, IqV2, LevelInfo, SynergyResult } from "./concepts.js";

export type Role = "user" | "assistant" | "system" | "tool";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface FileContext {
  path: string;
  language: string;
  content: string;
  diagnostics?: Diagnostic[];
}

export interface Diagnostic {
  line: number;
  severity: "error" | "warning" | "info";
  message: string;
}

export interface Finding {
  type: "bug" | "security" | "performance" | "tip";
  line: number;
  title: string;
  explanation: string;
}

export interface AnalyzeRequest {
  userId?: string;
  file: FileContext;
}

export interface AnalyzeResponse {
  findings: Finding[];
}

export type ConceptLevel = "familiar" | "functional" | "competent" | "expert";

export interface ConceptRow {
  name: string;
  cluster: Cluster;
  mastery: number;            // effective mastery after decay + quality
  rawMastery: number;         // pre-decay, pre-quality
  timesUsed: number;
  distinctFiles: number;
  weight: number;
  iqContribution: number;     // this concept's contribution to user's codeIq
  level: ConceptLevel;
  lastUsedAt: string;
  daysSinceUsed: number;
}

export interface ClusterSummary {
  cluster: Cluster;
  label: string;
  concepts: number;           // concepts touched in this cluster
  total: number;              // total concepts defined in this cluster
  iq: number;                 // IQ contribution from this cluster
  progress: number;           // 0..1 average effective mastery across touched
}

export interface GainEvent {
  concept: string;
  cluster: Cluster;
  deltaIq: number;
  file: string;               // short basename
  ts: string;
  kind?: "concept" | "milestone" | "fix";
}

export interface DailyIqPoint {
  date: string;               // yyyy-mm-dd
  codeIq: number;
}

export interface StreakInfo {
  current: number;            // consecutive days ending today (or yesterday)
  longest: number;
  lastSaveDate: string | null; // yyyy-mm-dd
}

export interface MilestoneSummary {
  id: string;
  title: string;
  description: string;
  bonusIq: number;
  unlocked: boolean;
  unlockedAt: string | null;
}

export interface Recommendation {
  concept: string;
  cluster: Cluster;
  weight: number;
  reason: string;             // human-readable
}

/** Daily pillar snapshot — stored so we can compute "where did my points come from?" */
export interface DailyPillarSnapshot {
  date: string;               // yyyy-mm-dd
  depth: number;
  breadth: number;
  velocity: number;
  consistency: number;
  quality: number;
  composite: number;
}

/** Full IQ breakdown with per-pillar deltas + insights */
export interface IqBreakdown {
  today: DailyPillarSnapshot;
  yesterday: DailyPillarSnapshot | null;
  /** Per-pillar delta from yesterday → today */
  deltas: {
    depth: number;
    breadth: number;
    velocity: number;
    consistency: number;
    quality: number;
    composite: number;
  };
  /** The single biggest positive gain today */
  topGain: string | null;
  /** The single biggest gap/problem holding IQ back */
  biggestGap: string | null;
  /** Actionable suggestion for the biggest improvement opportunity */
  suggestion: string | null;
}

/** Weekly velocity log entry — tracked per user, updated on every recordConcepts call */
export interface VelocityLogEntry {
  week: string;               // ISO week: "2026-W16"
  newConcepts: number;        // first-time detections this week
  levelUps: number;           // skills that crossed a mastery tier this week
  newDomains: number;         // first concept in a previously untouched domain
}

/** Velocity summary returned in MeResponse */
export interface VelocityInfo {
  /** Trailing 4-week averages */
  avgNewConceptsPerWeek: number;
  avgLevelUpsPerWeek: number;
  avgNewDomainsPerWeek: number;
  /** Current week's raw numbers */
  thisWeek: VelocityLogEntry;
  /** Last 12 weeks for the velocity sparkline */
  recentWeeks: VelocityLogEntry[];
  /** The streak multiplier applied to the Velocity pillar */
  streakMultiplier: number;
}

export interface MeResponse {
  userId: string;
  username: string;
  codeIq: number;
  maxIq: number;
  bonusIq: number;            // from unlocked milestones
  totalConcepts: number;
  ruleCount: number;          // total concepts defined (for "X / Y tracked")
  topConcepts: ConceptRow[];
  clusters: ClusterSummary[];
  recentGains: GainEvent[];
  streak: StreakInfo;
  dailyIq: DailyIqPoint[];    // up to 30 days
  milestones: MilestoneSummary[];
  recommendations: Recommendation[];
  /** Five-pillar IQ breakdown — the real intelligence score */
  pillars: IqPillars;
  /** Engineering level + progress toward next + requirements checklist */
  level: LevelInfo;
  /** Cross-domain synergy bonuses + detected gaps */
  synergies: SynergyResult;
  /** Velocity tracking — learning speed over time */
  velocity: VelocityInfo;
  /** Daily IQ breakdown — where did my points come from / go? */
  breakdown: IqBreakdown;
  /** Code IQ v2 — the engineer's benchmark. One number = mean of six
   *  categories (Craft, Range, Velocity, Debug, Quality, Independence).
   *  Computed in parallel with v1 during the transition. */
  iqV2: IqV2;
}

export interface ActiveFileInfo {
  path: string;
  language: string;
}

/* ========== Proactive watcher nudges ========== */

export type UnpromptedTriggerId =
  | "error_persists"
  | "struggle_cluster"
  | "stare_pause"
  | "build_fail_loop"
  | "win_detected"
  | "flow_detected"
  | "commit_risk"
  | "late_night_marathon"
  | "risky_edit"
  | "concept_breakthrough";

export interface UnpromptedNudge {
  id: string;
  triggerId: UnpromptedTriggerId;
  severity: "low" | "medium" | "high";
  text: string;
  canEscalate: boolean;
  // Lightweight context shown to Claude on engage — NOT rich types to keep
  // the shared package slim
  context: {
    filePath?: string;
    errorMessage?: string;
    errorLine?: number;
    concept?: string;
    note?: string;
  };
  createdAt: number;
}

/* ========== Tool use ========== */

export interface WorkspaceContext {
  root?: string;
  activeFile?: {
    path: string;
    language: string;
    content: string;
    selection?: string;
  };
  fileTree?: string[]; // relative paths, truncated list
}

// OpenAI-compatible message shape we pass between backend <-> extension
export interface OAITurn {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  id: string;
  name: string;
  content: string;
  error?: string;
}

export type ChatMode = "text" | "voice" | "voice-dialogue" | "teaching";

/**
 * Cloud chat backend the user wants to route this request through. The
 * server maps this to a concrete Anthropic model id. `undefined` means
 * "use the server default" (backwards-compat with pre-selection clients).
 */
export type ChatBackend = "haiku" | "sonnet";

export interface ChatRunRequest {
  userId?: string;
  workspace?: WorkspaceContext;
  messages: OAITurn[]; // running conversation so far (empty on first call)
  newUserMessage?: string; // present on first call of a turn
  toolResults?: ToolResult[]; // present on continuation calls
  mode?: ChatMode; // rendering channel — affects persona + post-processing
  /** Which cloud model the user selected. Server defaults to Sonnet when omitted. */
  backend?: ChatBackend;
  /**
   * Disable tool-use entirely for this request. The server omits the
   * `tools` array from the Anthropic call, forcing the model to reply
   * with text only. Set by one-shot callers (review engine, voice
   * explain) that just need a JSON/string reply and can't consume
   * tool-call rounds.
   */
  noTools?: boolean;
}

export interface ChatRunResponse {
  // Either a final reply, or a set of tool calls the extension must execute.
  reply?: string;
  toolCalls?: ToolCall[];
  messages: OAITurn[]; // updated running conversation
}

export interface ChatRequest {
  userId?: string;
  message: string;
  file?: FileContext;
}

export interface ChatResponse {
  reply: string;
}

/* ========== Webview <-> host messages ========== */

export type WebviewToHost =
  | { type: "chat/send"; message: string; mode?: ChatMode }
  | { type: "chat/clear" }
  | { type: "ready" }
  | { type: "watcher/engage"; nudgeId: string; triggerId: UnpromptedTriggerId; context: UnpromptedNudge["context"] }
  | { type: "watcher/dismiss"; nudgeId: string }
  | { type: "openExternal"; url: string }
  | { type: "mic/reset" }
  | { type: "mic/openSettings" }
  | { type: "voice/openInBrowser" }
  | { type: "voice/start" }
  | { type: "voice/stop" }
  | { type: "voice/speaking"; active: boolean }
  | {
      /**
       * Webview → host: the TTS clip started via `voice/playExplain` has
       * finished playing (or errored). Host uses this to swap the
       * "speaking…" chip for the post-voice handoff invite, so the timing
       * matches real playback instead of a guess based on word count.
       */
      type: "voice/playbackDone";
      reason: "ended" | "error";
      /** Correlation id from `voice/playExplain` so the host can resolve
       *  the right awaiter (teach_step tool waits on this). */
      requestId?: string;
    }
  | { type: "wake/toggle" }
  | { type: "scan/request" }
  | { type: "auth/login" }
  | { type: "liveReview/toggle"; active: boolean }
  | { type: "ai/setBackend"; backend: "on-device" | "haiku" | "sonnet" | "auto" }
  | { type: "ai/downloadModel" }
  | { type: "feature/toggle"; feature: "inlineErrors" | "didYouKnow"; enabled: boolean }
  | { type: "explainMode/set"; mode: "text" | "voice" | "both" }
  | { type: "chat/search"; query: string }
  | { type: "chat/clearHistory" }
  | { type: "map/request" }
  | { type: "map/fileSummary"; path: string }
  | { type: "map/openFile"; path: string }
  | { type: "tour/start"; intent: "codebase" }
  | { type: "tour/next" }
  | { type: "tour/stop" }
  | { type: "explainBack/submit"; explanation: string }
  | { type: "explainBack/stop" }
  | { type: "debug/log"; tag: string; message: string };

export type HostToWebview =
  | { type: "chat/append"; message: ChatMessage }
  | { type: "chat/history"; messages: ChatMessage[] }
  | { type: "chat/searchResults"; results: { message: ChatMessage; snippet: string }[] }
  | { type: "chat/loading"; loading: boolean }
  | { type: "chat/error"; error: string }
  | {
      type: "chat/tool";
      name: string;
      args: Record<string, unknown>;
      status: "running" | "done" | "error";
    }
  | {
      type: "iq/update";
      codeIq: number;
      maxIq: number;
      bonusIq: number;
      totalConcepts: number;
      ruleCount: number;
      topConcepts: ConceptRow[];
      clusters: ClusterSummary[];
      recentGains: GainEvent[];
      streak: StreakInfo;
      dailyIq: DailyIqPoint[];
      milestones: MilestoneSummary[];
      recommendations: Recommendation[];
      pillars: IqPillars;
      level: LevelInfo;
      synergies: SynergyResult;
      velocity: VelocityInfo;
      breakdown: IqBreakdown;
      iqV2: IqV2;
    }
  | { type: "iq/gain"; gains: GainEvent[]; codeIq: number }
  | {
      /**
       * Host → webview: drop the "LAST CALL" chip in the Live tab. Sent
       * when the user switches AI backend so a stale Sonnet/Haiku call
       * doesn't linger on-screen after they've moved to On-Device.
       */
      type: "ai/lastCallCleared";
    }
  | { type: "chat/autoSend"; message: string }
  | {
      /**
       * Host → webview: flip the chat panel into voice-input mode and
       * auto-send `message` as the first turn of a new follow-up thread.
       * Used by the Teaching Thread's "Ask" button so clicking Ask
       * transitions the user into a spoken conversation with the mentor
       * without leaving the editor.
       */
      type: "voice/primeConversation";
      message: string;
    }
  | {
      /**
       * Host → webview: play this short explanation through TTS.
       * The webview calls /tts, streams the WAV, and plays it via its
       * persistent AudioContext (same path as Voice Mode). Used by the
       * Ghost Lens "Explain" button when explainMode is "voice" or "both".
       */
      type: "voice/playExplain";
      text: string;
      voice?: "female" | "male";
      /** Optional id; webview echoes it in `voice/playbackDone.requestId`
       *  so hosts can await a specific clip (teach_step chaining). */
      requestId?: string;
    }
  | { type: "scan/started" }
  | { type: "scan/done"; found: number; summary: string }
  | { type: "file/active"; file: ActiveFileInfo | null }
  | { type: "teach/finding"; finding: Finding }
  | { type: "watcher/nudge"; nudge: UnpromptedNudge }
  | { type: "watcher/dismiss"; id: string }
  | { type: "voice/recording"; active: boolean }
  | { type: "voice/transcript"; text: string }
  | {
      /** Host → webview: play a short pre-cached filler clip ("Mm-hmm.",
       *  etc.) right after the user stops speaking so they hear an instant
       *  acknowledgment while STT + Claude + TTS run in the background.
       *  Makes the 2-4s response delay feel alive instead of dead. */
      type: "voice/fillerPlay";
    }
  | { type: "voice/error"; error: string }
  | { type: "wake/state"; active: boolean; status?: string }
  | { type: "liveReview/state"; active: boolean }
  | {
      type: "tip/detail";
      tip: {
        title: string;
        body: string;
        kind: "bug" | "perf" | "tip" | "warn" | "info";
        ruleId: string;
        currentLine?: string;
        fix?: string;
        lang?: string;
        uri: string;
        line: number;
      };
    }
  | {
      type: "ai/modelStatus";
      ready: boolean;
      loading: boolean;
      error: string | null;
      downloadProgress: number;
    }
  /** Host pushes the currently selected backend so the webview hydrates
   *  from persisted state (globalState) instead of defaulting to "auto" on
   *  every reload. */
  | { type: "ai/backend"; backend: "on-device" | "haiku" | "sonnet" | "auto" }
  /** Host reports the current `protege.explainMode` so the Live tab's
   *  3-option toggle (Text / Voice / Both) can reflect state at a glance.
   *  Sent on activate + whenever the setting changes (via user clicking
   *  the Live toggle OR editing settings.json directly). */
  | { type: "explainMode/state"; mode: "text" | "voice" | "both" }
  /** Host reports which backend actually executed the most recent query.
   *  The webview shows this as a "last call" chip so the user can prove
   *  on-device is running vs. silently falling through to Claude. */
  | {
      type: "ai/lastCall";
      backend: "on-device" | "haiku" | "sonnet";
      atMs: number;
      durationMs: number;
      ok: boolean;
      /** Set when the chosen backend couldn't run and we fell back (or
       *  refused to). The chip must render this loudly. */
      fallback?: {
        requested: "on-device" | "haiku" | "sonnet" | "auto";
        reason: string;
      };
    }
  | {
      type: "auth/user";
      user: {
        githubId: string;
        login: string;
        email: string | null;
        avatarUrl: string | null;
      } | null;
    }
  | { type: "map/data"; data: ProjectMapData }
  | { type: "map/fileSummaryResult"; path: string; summary: string | null }
  | { type: "tour/state"; state: TourState | null }
  | { type: "tour/narrationReady"; index: number; narration: string }
  | { type: "explainBack/state"; state: ExplainBackSession | null }
  | { type: "ownership/changed"; path: string; summary: OwnershipSummary };

/* ========== Project Map (A1) ========== */

export interface ProjectMapFile {
  /** Relative path from workspace root, forward slashes. */
  path: string;
  /** Total edits across all authors in the last 7 days (from git log). */
  editsTotal: number;
  /** Edits by the current user (matched by `git config user.email`). */
  editsByMe: number;
  /** True when the heuristic believes this is a project entry point
   *  (from package.json main/bin, activate() for VS Code ext, app.listen
   *  for servers, etc.). */
  isEntryPoint: boolean;
  /** Optional ownership summary — present once the ownership system has
   *  seen any activity on the file. Omitted means `untracked`. */
  ownership?: OwnershipSummary;
}

export interface ProjectMapData {
  /** Workspace root, displayed as the header. `null` if no workspace. */
  root: string | null;
  /** All source files considered interesting (skip node_modules, dist,
   *  generated, binary). Sorted by `editsTotal` descending. */
  files: ProjectMapFile[];
  /** Top-N most-edited files for the sidebar "hot files" list. */
  hotFiles: ProjectMapFile[];
  /** Files marked as entry points. */
  entryPoints: ProjectMapFile[];
  /** Files the user hasn't edited — "untouched by me". */
  untouchedByMe: ProjectMapFile[];
  /** When this data was computed, ms epoch. */
  computedAt: number;
  /** Warnings surfaced during collection (e.g. "git not available"). */
  warnings: string[];
}

/* ========== Architecture Tour (A2) ========== */

export interface TourStep {
  /** Relative path from workspace root. */
  path: string;
  /** 0-based line number to scroll to + anchor the highlight on. */
  focusLine: number;
  /** Short label describing the focal point (e.g. "activate()",
   *  "default export", "top-level class"). May be empty. */
  focusLabel: string;
  /** 2–3 sentence narration, filled in as the Haiku call returns.
   *  `null` while the call is in flight; the webview shows a typing
   *  indicator until the `tour/narrationReady` message lands. */
  narration: string | null;
}

export interface TourState {
  /** The user's intent string — currently only "codebase" is shipped,
   *  but the type is forward-compatible with "auth-flow" / "around file". */
  intent: string;
  /** Ordered list of 3–7 steps. Narrations arrive asynchronously via
   *  `tour/narrationReady`. */
  steps: TourStep[];
  /** Current step index (0-based). */
  currentIndex: number;
  /** ms epoch when the tour started. */
  startedAt: number;
}

/* ========== Explain-back Session (B1) ========== */

export interface ExplainBackRound {
  /** What the user said, verbatim. */
  explanation: string;
  /** Parsed grade from Haiku. `null` while the grading call is in flight. */
  grade: ExplainBackGrade | null;
  /** ms epoch when the user submitted this round. */
  submittedAt: number;
}

export interface ExplainBackGrade {
  /** One-sentence "what the user nailed". */
  got_right: string;
  /** One specific thing they missed — null when solid. */
  missed: string | null;
  /** Pointed follow-up question OR "you got this" when solid. */
  follow_up: string;
  /** Whether Protege thinks the explanation is complete enough to stop. */
  done: boolean;
}

export interface ExplainBackSession {
  /** Relative path of the file the selection came from. */
  path: string;
  /** The user's selected code. */
  code: string;
  /** Language id for syntax highlighting. */
  language: string;
  /** Rounds of explanation + grading (append-only during the session). */
  rounds: ExplainBackRound[];
  /** True when the most recent round is awaiting a grade. */
  grading: boolean;
  /** Soft cap — when rounds.length ≥ this, we encourage wrapping up. */
  maxRounds: number;
  /** ms epoch when the session started. */
  startedAt: number;
  /** 0-based line range of the original selection — used by ownership.markExplained. */
  startLine?: number;
  endLine?: number;
}

/* ========== Code Ownership (Vibecoding Partnership) ========== */

/** Single tracked region of a file — created on an auto-insert burst, and
 *  stamped with `explainedAt` when the user passes an explain-back round
 *  or drill that covers it. Typed regions are recorded too but implicitly
 *  count as owned without explanation. */
export interface OwnershipRegion {
  /** 0-based inclusive start line at the moment of capture. */
  startLine: number;
  /** 0-based inclusive end line at the moment of capture. */
  endLine: number;
  /** How the lines came to exist. */
  origin: "typed" | "auto-inserted";
  /** ms epoch when the user successfully explained / drilled this range,
   *  or null if still unreviewed. Typed regions may have `explainedAt`
   *  null — they still count as owned. */
  explainedAt: number | null;
}

export interface FileOwnership {
  /** Schema version, for migrations later. */
  version: 1;
  /** Regions of the file, roughly non-overlapping. Adjacent same-origin
   *  regions are merged on insert; at most ~200 per file (coarsened if
   *  the cap is exceeded). */
  regions: OwnershipRegion[];
  /** ms epoch of the last time we recomputed `totalLinesAtLastScan`. */
  lastScanAt: number;
  /** Total line count of the file at last scan; used as denominator for
   *  the ownership percentage. */
  totalLinesAtLastScan: number;
}

/** Summary state used by every UI surface (map dots, greeter, inviter). */
export type OwnershipState = "untracked" | "owned" | "partial" | "unknown";

export interface OwnershipSummary {
  /** Coarse bucket: `untracked` when no regions recorded; `owned` > 0.8;
   *  `partial` 0.3–0.8; `unknown` < 0.3. */
  state: OwnershipState;
  /** (typed-lines + explained-auto-lines) / total, clamped 0..1. */
  ownedPct: number;
  /** (typed-lines + all-auto-lines) / total — upper bound if every auto
   *  region were explained. */
  knownPct: number;
  /** Lines the user has not yet typed OR explained. */
  unknownLines: number;
  /** Total file lines at last scan. */
  totalLines: number;
  /** The single largest contiguous unreviewed range — used by nudges and
   *  the "open the most unclear part together" flow. Null when there's
   *  no unreviewed range. */
  topUnknownRange: { startLine: number; endLine: number } | null;
}
