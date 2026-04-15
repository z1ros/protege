export * from "./concepts.js";
import type { Cluster } from "./concepts.js";

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

export interface ChatRunRequest {
  userId?: string;
  workspace?: WorkspaceContext;
  messages: OAITurn[]; // running conversation so far (empty on first call)
  newUserMessage?: string; // present on first call of a turn
  toolResults?: ToolResult[]; // present on continuation calls
  mode?: ChatMode; // rendering channel — affects persona + post-processing
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
  | { type: "openExternal"; url: string };

export type HostToWebview =
  | { type: "chat/append"; message: ChatMessage }
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
    }
  | { type: "iq/gain"; gains: GainEvent[]; codeIq: number }
  | { type: "file/active"; file: ActiveFileInfo | null }
  | { type: "teach/finding"; finding: Finding }
  | { type: "watcher/nudge"; nudge: UnpromptedNudge }
  | { type: "watcher/dismiss"; id: string };
