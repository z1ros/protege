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

export type ChatMode = "text" | "voice";

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
  | { type: "wake/toggle" }
  | { type: "scan/request" }
  | { type: "auth/login" }
  | { type: "liveReview/toggle"; active: boolean }
  | { type: "ai/setBackend"; backend: "on-device" | "haiku" | "sonnet" | "auto" }
  | { type: "ai/downloadModel" }
  | { type: "feature/toggle"; feature: "inlineErrors" | "didYouKnow"; enabled: boolean }
  | { type: "chat/search"; query: string }
  | { type: "chat/clearHistory" };

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
  | { type: "chat/autoSend"; message: string }
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
