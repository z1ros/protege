export * from "./concepts.js";
export * from "./lineDiff.js";
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

export type ChatMode = "text" | "voice" | "teaching";

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
  | { type: "chat/search"; query: string }
  | { type: "chat/clearHistory" }
  | { type: "echo/open" };

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
    };

/* ========== Echo — behavior observation dashboard ========== */

/** Time-window options for the Echo dashboard. */
export type EchoWindow = "today" | "week" | "month";

/** Paste classification heuristics. */
export type PasteSource = "external" | "ai-chat-output" | "self-edit-paste";

/** The single union of every event the extension batcher emits. Events are
 *  append-only; aggregation is the backend rollup's job. Payloads are kept
 *  narrow on purpose — raw event log stays compact. */
export type EchoEvent =
  | {
      type: "keystroke_batch";
      ts: number;
      file: string;
      language: string;
      keystrokes: number;
      durationMs: number;
      /** Chars typed during this batch window. Added in R1 for authorship
       *  tracking. Older extension builds may omit this field. */
      charsTyped?: number;
    }
  | {
      type: "session_tick";
      ts: number;
      file: string | null;
      language: string | null;
      /** Longest uninterrupted typing stretch observed during this tick. */
      focusStretchMs: number;
    }
  | {
      type: "session_boundary";
      ts: number;
      kind: "start" | "end";
      reason: "idle" | "vscode-close" | "fresh-start";
      /** Populated on `end` — total active ms attributed to the closed session. */
      activeMs?: number;
    }
  | {
      type: "paste_classified";
      ts: number;
      file: string;
      source: PasteSource;
      chars: number;
    }
  | {
      type: "ai_suggestion_accepted";
      ts: number;
      file: string;
      chars: number;
      /** Chars accepted from this AI suggestion. Added in R1 for authorship
       *  tracking. Typically equal to `chars` but kept separate so widget
       *  aggregators can opt in without breaking older events. */
      charsAccepted?: number;
    }
  | {
      type: "ai_suggestion_rejected";
      ts: number;
      file: string;
    }
  | {
      type: "undo_triggered";
      ts: number;
      file: string;
    }
  | {
      type: "line_diff";
      ts: number;
      file: string;
      linesAdded: number;
      linesRemoved: number;
      /** Touched-line fingerprints so the backend can bump
       *  LineRewriteCounter without the extension shipping content. */
      rewrittenFingerprints: Array<{
        fingerprint: string;
        roughLine: number;
        contentHash: string;
        sampleContent?: string;
      }>;
    }
  | {
      type: "commit_detected";
      ts: number;
      sha: string;
      message: string;
      filesTouched: string[];
    }
  | {
      type: "file_focus_change";
      ts: number;
      file: string | null;
      language: string | null;
    }
  | {
      type: "diagnostic_appeared";
      ts: number;
      file: string;
      line: number;
      severity: "error" | "warning" | "info";
      message: string;
    }
  | {
      type: "diagnostic_resolved";
      ts: number;
      file: string;
      line: number;
      durationMs: number;
    }
  | {
      /** Emitted when the extension's concept analyzer sees a known concept
       *  inside a source file on open or save. Backend stamps the current
       *  authorship ratio onto ConceptEncounter rows so the Concepts
       *  Covered widget can bucket sightings as Yours / Mixed / AI /
       *  In-codebase. Added in R1. Rv5.A adds `language` so the Concepts
       *  Covered widget's language picker has data to filter on. */
      type: "concept_encountered";
      ts: number;
      file: string;
      concept: string;
      cluster?: string;
      language?: string | null;
    }
  | {
      /** Rv5.B: emitted by the workspace scanner for each file processed.
       *  Batched and POSTed to `/echo/repo-scan` rather than routed through
       *  the normal /echo/events path — the scanner can produce thousands of
       *  concept rows per file and needs its own stricter rate bucket. */
      type: "repo_concept_batch";
      ts: number;
      file: string;
      language: string | null;
      workspaceRoot: string;
      concepts: string[];
    };

export type EchoEventKind = EchoEvent["type"];

/** Commit enrichment payload — computed extension-side between git commits,
 *  persisted server-side for W11. */
export interface CommitStory {
  userId?: string;
  commitSha: string;
  commitTs: string;
  message: string;
  filesTouched: string[];
  activeMinutes: number;
  undoCount: number;
  pasteCount: number;
  aiAcceptCount: number;
  peakFocusMin: number;
}

/** Daily rollup of raw events into widget-ready aggregates. Extended shape
 *  per plan — populated by the nightly `rollup` job. */
export interface BehaviorDailyRollup {
  userId: string;
  date: string;                              // yyyy-mm-dd
  activeMinutes: number;
  totalMinutes: number;
  sessionsCount: number;
  sessionMinutes: number;
  hourHistogram: number[];                   // length 24 — active minutes per hour
  linesAdded: number;
  linesRemoved: number;
  linesNet: number;
  filesTouched: string[];
  fileHops: number;
  archetypeHint: string | null;
}

/** Per-line rewrite counter — W10 substrate. */
export interface LineRewriteCounterRow {
  userId: string;
  filePath: string;
  lineFingerprint: string;
  rewriteCount: number;
  lastContent: string;
  lastRewriteAt: string;
}

/** User preferences blob extension — adds the storyMode notify flag. */
export interface EchoUserPreferences {
  storyModeNotify: boolean;
  /** v5 W15/W17 shared language picker. `null` === "All languages". */
  echoConceptLanguage?: string | null;
}

/* ========== Widget payloads — DashboardResponse ==========
 *
 * These are the data shapes each widget (W1–W13) renders against. The
 * placeholder React components in apps/extension/src/echo/widgets/
 * import these prop types. Widget agents may refine individual fields
 * but MUST keep the named interface stable so the dashboard wiring
 * doesn't have to change. */

export interface HeroWidgetPayload {
  /** Total editor minutes across the window. Rendered by the "Time in Editor" tile. */
  timeInEditor: number;
  /** Sum of active (keystroke-bearing) minutes. Retained because the
   *  sparkline and trendDelta both key off active minutes. */
  activeMinutes: number;
  /** Lines authored (linesAdded) across the window. */
  linesWritten: number;
  /** Count of ConceptState rows that crossed the mastery threshold inside
   *  the window. Threshold: timesUsed >= 3 AND distinctFiles >= 2 AND
   *  lastUsedAt within [windowStart, windowEnd]. */
  conceptsMastered: number;
  /** 0..1 aggregate human/(human+ai) char ratio across this user's files
   *  touched in the window. 0 when no counters exist. */
  manualPct: number;
  /** True when `manualPct` should be suppressed in the UI because the window
   *  has no session activity (timeInEditor === 0). Prevents the tile from
   *  rendering a stale authorship ratio alongside otherwise-zero stats. */
  manualPctHidden: boolean;
  sparkline: number[];                       // trailing 7 days of active minutes
  trendDelta: number | null;                 // prior-window delta of active minutes
}

export interface PolarClockArc {
  startHour: number;                         // 0..24 (fractional)
  endHour: number;                           // 0..24
  weekday: number;                           // 0..6 (Sun..Sat)
  intensity: number;                         // 0..1
  label: string;                             // hover label e.g. "Tue 9:47pm · 47 min"
  /** Epoch ms for session start — clients use this to bucket per ring. */
  startTs: number;
  /** Session day key (YYYY-MM-DD, UTC) — Week window ring bucket. */
  dayKey: string;
  /** ISO week key (YYYY-Www) — Month window ring bucket. */
  weekKey: string;
}

export interface PolarClockPayload {
  sessions: PolarClockArc[];
  hourHistogram: number[];                   // length 24
  archetype: string;                         // "night-owl" | "morning-builder" | …
  archetypeCaption: string;                  // human-readable caption
  peakHour: number | null;                   // 0..23
}

export interface MonthlyHeatmapCell {
  date: string;                              // yyyy-mm-dd
  activeMinutes: number;
  filesTouched: number;
}

export interface MonthlyHeatmapPayload {
  cells: MonthlyHeatmapCell[];               // 30 entries, padded with empty days
  maxMinutes: number;                        // for color-scale normalization
}

export interface LinesWrittenDay {
  date: string;
  linesAdded: number;
  linesRemoved: number;
  linesNet: number;
}

export interface LinesWrittenPayload {
  days: LinesWrittenDay[];
  cumulativeNet: number;
  biggestDay: LinesWrittenDay | null;
}

export interface LineThatWontDiePayload {
  filePath: string;
  roughLine: number;
  content: string;
  language: string | null;
  rewriteCount: number;
  lastRewriteAt: string;
  /** Null when no line crossed the min-rewrite threshold — W10 hides itself. */
  empty: boolean;
}

export interface CommitStoryCard {
  sha: string;
  shortSha: string;
  message: string;
  filesTouched: string[];
  activeMinutes: number;
  undoCount: number;
  pasteCount: number;
  aiAcceptCount: number;
  peakFocusMin: number;
  ts: string;
}

export interface CommitStoriesPayload {
  cards: CommitStoryCard[];
}

/** W12 Save Tape — one row per recent save with context from the ±30s
 *  neighborhood of the save. Relative timestamp is pre-formatted server-side
 *  so the feed doesn't drift with client/server clock skew. */
export interface SaveTapeEntry {
  ts: string;                                // ISO
  relative: string;                          // "3m ago", "21m ago", "1h ago", "Yesterday 9:47pm"
  file: string;                              // full path (for click-to-open)
  displayPath: string;                       // last 2 segments of `file`
  language: string | null;
  linesAdded: number;
  linesRemoved: number;
  errorsAdded: number;
  errorsResolved: number;
  aiAccepts: number;
  pasted: number;
}

export interface SaveTapePayload {
  entries: SaveTapeEntry[];
}

export interface StoryModeTeaserPayload {
  notify: boolean;
  nextDrop: string | null;                   // ISO date or null
}

/** W14 Independence Trend — trajectory view of authorship composition.
 *  Replaces the old codeOrigin donut because W1 Hero already surfaces the
 *  static Manual% as a tile. Adds a time dimension the hero cannot: daily
 *  composition stacks + prior-window trend + depth signals. */
export interface IndependenceDayPoint {
  date: string;                              // yyyy-mm-dd
  label: string;                             // short display e.g. "Wed 22"
  typedChars: number;
  aiChars: number;
  pastedChars: number;
}

export interface IndependenceLanguageRow {
  language: string;
  /** 0..1 — either accept-vs-reject rate when reject events are present,
   *  or an AI-chars share fallback. See aggregator comment. */
  acceptRate: number;
  /** Total chars attributed to this language — credibility signal.
   *  UI surfaces "low data" badge when sample < 50. */
  sample: number;
}

export interface IndependenceTrendPayload {
  /** 0..1 typed chars / (typed + ai) for the current window. Paste chars
   *  are tracked in `days` but excluded from this ratio — paste is its own
   *  signal, not an authorship tug-of-war axis. */
  manualPct: number;
  /** Delta vs. prior equivalent-length window (0..1 scale, signed).
   *  Null when the prior window has no typed-or-ai chars. */
  manualPctTrend: number | null;
  /** ai_edit_after_accept / ai_suggestion_accepted. Null when denominator 0. */
  editAfterAcceptRate: number | null;
  /** Signed delta vs. prior window (0..1 scale). Null on no prior data. */
  editAfterAcceptTrend: number | null;
  /** Count of undo_triggered events that fired within 10s after an
   *  ai_suggestion_accepted in the current window. */
  undoAfterAcceptCount: number;
  /** One entry per day in the window — missing days render as zeros. */
  days: IndependenceDayPoint[];
  /** Top 4 languages by total chars, sorted by `sample` desc. */
  byLanguage: IndependenceLanguageRow[];
}

/** W15 Concepts Covered — v5 shape. Two buckets (Yours / AI Used), per-tile
 *  known/not_known/unset status cycle, single shared language picker. */
export type ConceptKnownStatus = "unset" | "known" | "not_known";

export interface ConceptsCoveredTile {
  name: string;
  language: string | null;
  timesUsed: number;
  distinctFiles: number;
  bucket: "yours" | "ai";
  status: ConceptKnownStatus;
  isNew: boolean;
  firstSeenAt: string;                       // ISO
  lastUsedAt: string;                        // ISO
}

export interface ConceptLanguageCount {
  language: string | null;
  count: number;
}

export interface ConceptsCoveredPayload {
  tiles: ConceptsCoveredTile[];
  counts: { yours: number; ai: number };
  /** Distinct languages across the full pre-filter tile set, sorted by
   *  count desc. The null entry (if present) is rendered as "Unknown". */
  languages: ConceptLanguageCount[];
  /** Current UserPreference.echoConceptLanguage — null = All languages. */
  selectedLanguage: string | null;
}

/** W17 Repo Concepts — new widget in v5. Lists every concept the scanner
 *  found in the current workspace, filterable by the shared language
 *  picker. Status badge shares the same table as W15 (per-user, cross-
 *  workspace). */
export interface RepoConceptTile {
  name: string;
  language: string | null;
  fileCount: number;
  status: ConceptKnownStatus;
  firstSeenAt: string;                       // ISO
  lastSeenAt: string;                        // ISO
}

export type RepoScanState = "idle" | "scanning" | "done" | "truncated";

export interface RepoConceptsPayload {
  tiles: RepoConceptTile[];
  /** Total concepts across all languages in this workspace (pre-filter). */
  totalConcepts: number;
  languages: ConceptLanguageCount[];
  selectedLanguage: string | null;
  /** Null when the extension couldn't resolve a workspace root. */
  workspaceRoot: string | null;
  /** ISO — max(lastSeenAt) across the index rows. Null when never scanned. */
  lastScannedAt: string | null;
  /** Sum of tile fileCount — rough file tally, not exact distinct files. */
  scannedFileCount: number | null;
  /** Backend default: "idle". The webview overrides this locally from
   *  `repo_scan_status` messages while a scan is active. */
  scanState: RepoScanState;
}

/** W16 Concepts Momentum — new-concepts-per-day line chart. On the Today
 *  window the aggregator switches to hourly buckets so the chart shows a
 *  24-point series instead of a 1-2 dot line. Other windows stay daily. */
export interface ConceptsMomentumPoint {
  /** Daily: "yyyy-mm-dd". Hourly: "HH" (00..23). */
  bucket: string;
  /** Display label — "Wed 22" for daily, "HH:00" zero-padded for hourly. */
  label: string;
  count: number;
  sampleNames: string[];                     // up to 5
  overflow: number;                          // remaining beyond sample
}

export interface ConceptsMomentumPayload {
  points: ConceptsMomentumPoint[];
  /** Tells the frontend which X-axis formatting + tick density to use. */
  mode: "hourly" | "daily";
}

/** Shape of GET /echo/dashboard?window=…. Widget agents refine fields, not
 *  names. `null` slots mean "no data yet" — widgets render empty state. */
export interface DashboardResponse {
  window: EchoWindow;
  generatedAt: string;
  /** Days of Echo-tracked history the user has (clamped to window length).
   *  null when history meets/exceeds the requested window — widgets render
   *  normally. Non-null when the window was clamped to the user's history
   *  (e.g. 5 means user has been tracked 5 days, shorter than Week). */
  historyDays: number | null;
  /** True when the prior-window comparison is unavailable because the
   *  user doesn't have a full prior window of history. */
  priorWindowHidden: boolean;
  hero: HeroWidgetPayload | null;
  polar: PolarClockPayload | null;
  heatmap: MonthlyHeatmapPayload | null;
  independence: IndependenceTrendPayload | null;
  conceptsCovered: ConceptsCoveredPayload | null;
  repoConcepts: RepoConceptsPayload | null;
  conceptsMomentum: ConceptsMomentumPayload | null;
  lines: LinesWrittenPayload | null;
  rewrittenLine: LineThatWontDiePayload | null;
  commits: CommitStoriesPayload | null;
  saveTape: SaveTapePayload | null;
  storyMode: StoryModeTeaserPayload;
}

/* ========== Echo RPC — webview <-> host ========== */

export type EchoWebviewToHost =
  | { type: "echo_ready" }
  | { type: "echo_request"; window: EchoWindow }
  | { type: "echo_setSubPage"; subPage: "dashboard" | "story" }
  | { type: "echo_openMoment"; file: string; line?: number; ts?: number }
  | { type: "echo_notifyStoryMode"; enabled: boolean }
  | { type: "echo_refreshPreferences" }
  | {
      /** Rv5.C: persist the known-state for a concept. Host POSTs to
       *  /echo/concepts/status and then refetches the current window.
       *  Status enum is strictly the v5 triple (known / not_known /
       *  unset); Rv5.D removed the legacy v4 shim after the store
       *  migration lands. */
      type: "echo_setConceptStatus";
      concept: string;
      status: ConceptKnownStatus;
    }
  | {
      /** Rv5.C: persist the shared language picker selection. `null`
       *  means "All languages". Applies to both W15 and W17. */
      type: "echo_setConceptLanguage";
      language: string | null;
    }
  | {
      /** Rv5.B: force a fresh workspace scan. Clears the
       *  `scannedWorkspaces` cache entry for the current workspace and
       *  invokes scanWorkspace with `force: true`. Used by W17's re-scan
       *  button. */
      type: "echo_rescanRepo";
    };

export type EchoHostToWebview =
  | { type: "echo_dashboard"; window: EchoWindow; data: DashboardResponse }
  | { type: "echo_dashboardLoading"; window: EchoWindow }
  | { type: "echo_dashboardError"; window: EchoWindow; error: string }
  | { type: "echo_preferences"; preferences: EchoUserPreferences }
  | {
      /** Sent when a new commit is enriched extension-side. Dashboard can
       *  hot-refresh W11 without waiting for the next poll. */
      type: "echo_commit_enriched";
      story: CommitStory;
    }
  | {
      /** Rv5.B: live state of the workspace concept scanner. Rv5.C's W17
       *  widget consumes this to render the "scanning…" chip, the final
       *  file count, and to trigger a dashboard refetch when the scan
       *  finishes. */
      type: "repo_scan_status";
      state: "idle" | "scanning" | "done" | "truncated";
      scannedFiles?: number;
      totalCandidates?: number;
      finishedAt?: string;
    };
