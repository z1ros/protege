export * from "./concepts.js";
export * from "./lineDiff.js";
import type { Cluster, IqPillars, IqV2, LevelInfo, SynergyResult } from "./concepts.js";
import type { Iq3NewEvent } from "./iq3/events.js";
import type { Iq3Headline } from "./iq3/hmm.js";
import type { Iq3FieldId } from "./iq3/fields.js";

export type Role = "user" | "assistant" | "system" | "tool";

export interface ChatMessage {
  id: string;
  /** Which conversation this message belongs to. Required on all new
   *  messages. Legacy messages persisted before the sessions feature
   *  shipped resolve to `legacy-<userId>` during hydration. */
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  /** How this turn was delivered. "voice" means the user spoke it (wake
   *  word or voice mode) or the assistant's reply was spoken aloud. Used
   *  by the UI to show a small mic glyph, and by the backend to pick a
   *  short, ear-friendly prompt. Undefined on legacy/persisted messages. */
  source?: "voice" | "text";
}

/**
 * A chat session = one continuous conversation. Sessions are user-scoped,
 * synced to the cloud, and visible as separate cards in the history panel.
 * Title defaults to a snippet of the first user message; the user can rename.
 */
export interface ChatSession {
  id: string;
  /** GitHub numeric ID (server-side only — webview never sees raw user IDs). */
  userId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** ISO timestamp of the most recent message in the session. Used for
   *  list sort order ("most recently active first"). */
  lastMessageAt: string;
  messageCount: number;
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

/* ========== File Walk ==========
 *
 * Sequential mentor-narrated walkthrough of a single file. Backend produces
 * an ordered list of steps in execution order (top-level imports/side
 * effects → exported entry points → supporting functions). The extension
 * highlights `lineStart..lineEnd` and renders `body` in an inline comment
 * thread, with `concepts[]` exposed as Teach buttons that route through
 * the existing dispatchTeachConcept path. */

export interface WalkStep {
  /** Zero-based step index, monotonically increasing in the steps[] array. */
  index: number;
  /** 1-indexed inclusive line range to highlight in the editor. */
  lineStart: number;
  lineEnd: number;
  /** Short headline (≤ 60 chars). */
  title: string;
  /** 2–4 sentences of plain-language explanation, markdown allowed. */
  body: string;
  /** Concept names referenced in this step. Rendered as Teach buttons. */
  concepts: string[];
}

export interface WalkImportExcerpt {
  /** Relative-from-active-file path, forward slashes. */
  path: string;
  /** Up to ~80 lines of the imported file, truncated. */
  excerpt: string;
}

export interface WalkRepoSummary {
  topConcepts: string[];
  primaryLanguages: string[];
  fileCount: number;
}

export interface WalkRequest {
  userId?: string;
  /** Hash is intentionally NOT in this shape — the server derives it from
   *  `content` so a client cannot poison the cross-user step cache by
   *  asserting an arbitrary key. */
  file: { path: string; language: string; content: string };
  imports?: WalkImportExcerpt[];
  repoSummary?: WalkRepoSummary;
}

export interface WalkResponse {
  fileHash: string;
  steps: WalkStep[];
  /** True when the response was served from the (file-hash keyed) backend cache. */
  cached: boolean;
}

/** Returned with HTTP 429 when a user exceeds their daily walk quota. */
export interface WalkQuotaError {
  error: "daily quota exceeded";
  used: number;
  limit: number;
  /** Epoch ms — when the daily counter resets. */
  resetAt: number;
}

/** Cap kinds that can surface in a 429. The first three are the
 *  user-facing categories shown in the panel; the last four are
 *  internal route caps the panel doesn't display but a 429 from any
 *  of them still routes through the same toast surface. */
export type QuotaKind =
  | "chat_messages"
  | "tool_calls"
  | "voice_minutes"
  | "scan"
  | "teach"
  | "tts"
  | "stt"
  | "verify"
  | "classify";

/** Body returned by `GET /me/quota` — today's per-user usage shape the
 *  extension renders as mini progress bars + a $ pill in the Live tab.
 *  Three user-facing categories that map onto what users can directly
 *  feel ("I sent a message", "the bot used a tool", "I spoke / heard
 *  audio"). Internal granular counters live server-side and aren't
 *  exposed here. */
export interface QuotaSnapshot {
  userId: string;
  /** yyyy-mm-dd (UTC). */
  day: string;
  /** Epoch ms — next 00:00 UTC, when counters reset to 0. */
  resetAt: number;
  usage: {
    /** /chat premium-tier turns. Default beta limit: 100/day. */
    chat_messages: { used: number; limit: number };
    /** Tool invocations the model made inside chat (read_file, edit,
     *  grep, etc.). Tracked for analytics; no per-day cap is enforced
     *  (the daily $ cap covers cost). Optional so future backends can
     *  drop the field without breaking older clients. */
    tool_calls?: { used: number; limit: number };
    /** Combined TTS + STT minutes today. Default beta limit: 20/day. */
    voice_minutes: { used: number; limit: number };
    /** Cumulative chat engagement in minutes today — sum of capped
     *  gaps between consecutive user messages. Display-only (no cap).
     *  Optional so older backends without the column don't break the
     *  webview's snapshot decoder. */
    chat_minutes?: { used: number };
    /** Running $ estimate vs the daily $ ceiling. */
    cost: { used: number; limitUsd: number };
    /** Daily token totals (added 2026-05-02 — migration 005).
     *  `used` = prompt + completion. Optional so older backends
     *  without the column return undefined and the webview falls
     *  back gracefully. `limit` is a display ceiling calibrated
     *  against the $ cap; not enforced as a separate gate. */
    tokens?: {
      used: number;
      prompt: number;
      completion: number;
      limit: number;
    };
  };
  /** Subsystem health — let the panel paint a "● connected /
   *  ○ not configured" indicator and a tooltip with the precise reason
   *  if something's off. Backed by the startup probe of `user_quotas`. */
  meta?: {
    enforced: boolean;
    probe:
      | "unknown"
      | "no-supabase"
      | "table-missing"
      | "connected"
      | "error";
    probeDetail?: string;
  };
}

/** Body returned with HTTP 429 from any quota-gated route. The
 *  extension surfaces this as a plain-language toast + offers
 *  "details" that opens the Live tab's usage panel. */
export interface QuotaExceededError {
  error: "daily quota exceeded";
  /** Which counter tripped. */
  kind: QuotaKind;
  /** Whether the route count or the $ ceiling is what blocked. */
  reason: "route-cap" | "dollar-cap";
  used: number;
  limit: number;
  /** Epoch ms — when the counter resets. */
  resetAt: number;
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
  /** Server-side internal-team flag. True when the authenticated GitHub
   *  login appears in `PROTEGE_INTERNAL_LOGINS` (case-insensitive). Gates
   *  dev-only UI in the webview (Advanced surfaces panel, etc.). Always
   *  false for non-allowlisted users — the catalog itself is local data
   *  but other dev-only panels could hit gated endpoints, so we never
   *  derive this client-side. */
  internal: boolean;
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

/**
 * Chat channels:
 *  - text: typed Q&A, no TTS, full markdown.
 *  - voice / voice-dialogue: spoken reply, no markdown, short.
 *  - teaching: voice-driven agentic lesson with `teach_step` + TTS.
 *  - teaching-text: typed back-and-forth lesson with beat structure +
 *    PAUSE-at-checkpoint discipline. Distinct from `teaching` so the
 *    backend prompt can pick the right channel-specific block.
 */
export type ChatMode =
  | "text"
  | "voice"
  | "voice-dialogue"
  | "teaching"
  | "teaching-text";

/**
 * Task shaping — classifier output consumed by the chat router.
 * See plans/task-shaping.md §2.2. Produced by `shapeTask()` from the
 * intent/ subsystem before every chat turn; drives fork-chip decisions
 * in Phase 1 and (later) TaskSession creation in Phase 2.
 */
export type TaskShapeKind =
  | "qna"       // concept question, no code change
  | "build"     // add/create something
  | "teach"     // user explicitly wants to learn
  | "debug"     // user is stuck on a broken thing
  | "refactor"  // restructure existing code, no new surface
  | "chat";     // social / casual / clarifying

export type TaskComplexity = "trivial" | "single-step" | "multi-step";

export interface TaskShape {
  shape: TaskShapeKind;
  complexity: TaskComplexity;
  mode: "text" | "voice-dialogue" | "learning";
  needsRoadmap: boolean;
  roadmapSeeds?: string[];
  confidence: number; // 0..1
  signals: { tier: "regex" | "llm" | "cache"; why: string };
}

/** Context the classifier consults. Built host-side via `buildShapeContext`
 *  from the current editor / history / mode state. Sent over to `/classify`
 *  for tier 2 LLM classification. */
export interface ShapeContext {
  activeFilePath: string | null;
  activeFileLanguage: string | null;
  activeFileSelection: string | null;
  recentMessages: { role: "user" | "assistant"; content: string }[];
  currentMode: ChatMode;
  wakeActive: boolean;
  diagnosticsOnActiveFile: {
    severity: "error" | "warning";
    message: string;
  }[];
}

export interface ClassifyRequest {
  message: string;
  context: ShapeContext;
}

export type ClassifyResponse =
  | { shape: TaskShape }
  | { error: string };

/**
 * Understanding-Check verifier — one Haiku call between shapeTask and
 * runChat that either confirms the goal is clear, asks ONE clarifier,
 * or refines the goal into something actionable. See
 * plans/understanding-check.md.
 */
export type UnderstandingAction =
  | "clarify"
  | "offer-learn"
  | "offer-do"
  | "answer";

export interface Understanding {
  action: UnderstandingAction;
  goal: string;
  clarifier?: string;
  confidence: number;
  signals: { tier: "skip" | "llm" | "cache"; why: string };
}

export interface VerifyRequest {
  message: string;
  shape: TaskShape;
  context: ShapeContext;
  /** True when the message is the user's reply to a prior clarifier. The
   *  verifier must NOT emit another `clarify` in this case. */
  forceProceed?: boolean;
}

export type VerifyResponse =
  | { understanding: Understanding }
  | { error: string };

/**
 * Cloud chat backend the user wants to route this request through. The
 * server maps this to a concrete Anthropic model id. `undefined` means
 * "use the server default" (backwards-compat with pre-selection clients).
 */
export type ChatBackend = "haiku" | "sonnet";

/**
 * Quality tier — orthogonal to `backend`. Lets auto-fired background
 * scans request a cheaper model (gpt-4.1-mini / Haiku) without
 * sacrificing the premium model for user-triggered calls (chat,
 * Learning Mode, voice Explain).
 *
 * Default is "premium" so existing callers are unaffected.
 */
export type ChatTier = "cheap" | "premium";

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
   * Quality tier. "cheap" routes to gpt-4.1-mini (OpenAI) or Haiku
   * (Anthropic). "premium" uses the full model. Defaults to "premium".
   */
  tier?: ChatTier;
  /**
   * Disable tool-use entirely for this request. The server omits the
   * `tools` array from the Anthropic call, forcing the model to reply
   * with text only. Set by one-shot callers (review engine, voice
   * explain) that just need a JSON/string reply and can't consume
   * tool-call rounds.
   */
  noTools?: boolean;
}

/**
 * Slim projection of one step from the lesson plan, sent to the webview
 * so it can render a roadmap of the whole lesson under the banner.
 * Excludes the actual code (which can be large) — just the type label
 * and the planner-generated summary.
 */
export interface LessonStepPreview {
  type: string;
  summary: string;
}

/**
 * Snapshot of the lesson session state at the moment the backend reply
 * was generated. Used by the webview to render a lesson-progress banner.
 * `null` when there's no active lesson (regular chat). When `phase ===
 * "DONE"` the lesson just ended this turn.
 */
export interface LessonStateSnapshot {
  id: string;
  concept: string;
  level: "zero" | "comfortable" | "expert" | "unknown";
  phase: "PROBE" | "TEACHING" | "DONE";
  /** 1-indexed for display. 0 when in PROBE phase. */
  stepNumber: number;
  /** Total planned steps. Note: the plan is mutable (insertions on
   *  why-questions / confusions can grow it), so this can change turn
   *  to turn. */
  totalSteps: number;
  /** Type of the step that was just delivered, or null in PROBE. */
  currentStepType: string | null;
  /** Planner-generated summary of the current step, e.g. "Add useEffect
   *  to React import line". Lets the banner show what's actually
   *  happening, not just an abstract type label. Null in PROBE. */
  currentStepSummary: string | null;
  /** Full lesson plan (just type + summary, no code) so the webview
   *  can render a collapsible roadmap. Empty array in PROBE. */
  plan: LessonStepPreview[];
}

export interface ChatRunResponse {
  // Either a final reply, or a set of tool calls the extension must execute.
  reply?: string;
  toolCalls?: ToolCall[];
  messages: OAITurn[]; // updated running conversation
  /** Present only when the chat round was driven by a lesson session. */
  lessonState?: LessonStateSnapshot | null;
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
  | {
      type: "chat/send";
      message: string;
      mode?: ChatMode;
      /** Messages currently visible in the webview's chat view. When
       *  provided, the host uses these as the AI's short-term context
       *  INSTEAD of pulling the last N from globalState. Lets "New chat"
       *  start fresh without wiping persisted history — the webview
       *  clears its local view → context becomes empty → AI sees no
       *  prior turns, but the history panel still has old sessions. */
      contextMessages?: ChatMessage[];
      /** ID the webview already used for the optimistic user-message
       *  append. Voice turns broadcast `chat/append` back to all
       *  webviews so other open panels see the message; the host reuses
       *  this id so the originating webview dedupes by id and doesn't
       *  show the message twice. */
      userMsgId?: string;
    }
  | { type: "chat/clear" }
  | { type: "chat/abort" }
  | { type: "chat/typing" }
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
      /** Webview → host: synthesise speech for `text`. Host runs the
       *  authenticated POST to /tts on the user's behalf and replies via
       *  `voice/ttsResponse` with base64 WAV bytes (or an error). The
       *  webview never has the GitHub token, so it cannot call /tts
       *  directly once the route is auth-gated. */
      type: "voice/ttsRequest";
      requestId: string;
      text: string;
      voice?: "female" | "male";
    }
  | {
      /** Webview → host: ask for the current Kokoro warmup status. Host
       *  forwards (authenticated) to /tts/status and replies via
       *  `voice/ttsStatusResponse`. */
      type: "voice/ttsStatusRequest";
      requestId: string;
    }
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
  | {
      /** Webview → host: the user picked a voice gender in VoiceMode's
       *  picker. Host persists to `protege.voice.gender` so all host-side
       *  broadcast sites (Ghost Lens explain, teach narrations, file-open
       *  greeter) use the same voice as the in-webview picker. */
      type: "voice/setGender";
      gender: "female" | "male";
    }
  | { type: "scan/request" }
  | { type: "auth/login" }
  | {
      /** Login-first sign-out. Clears the host-side cached GitHub user
       *  and persists an opt-out flag so future activations keep the
       *  signed-out state until the user explicitly signs in again. We
       *  cannot revoke VS Code's underlying GitHub session — that's
       *  owned by the Accounts UI. The host responds by broadcasting
       *  `auth/user` with `null`. */
      type: "auth/logout";
    }
  | { type: "liveReview/toggle"; active: boolean }
  | { type: "ai/setBackend"; backend: "cloud" }
  /** Webview asks the host to refresh the quota snapshot from the
   *  backend (`GET /me/quota`). Live tab fires this on mount and on a
   *  refresh-now button. */
  | { type: "quota/get" }
  | { type: "feature/toggle"; feature: "inlineErrors" | "didYouKnow"; enabled: boolean }
  | { type: "explainMode/set"; mode: "text" | "voice" | "both" }
  | { type: "chat/search"; query: string }
  | { type: "chat/clearHistory" }
  | { type: "echo/open" }
  /** Webview → host: "give me the full persisted history from
   *  globalState so the history panel can browse past sessions even
   *  when the current chat view has been cleared by a 'New chat'
   *  click." Response: `chat/fullHistory`. */
  | { type: "chat/getFullHistory" }
  /** Webview → host: list all chat sessions for the user. Response:
   *  `chat/sessions`. */
  | { type: "chat/listSessions" }
  /** Webview → host: switch the live chat view to a different session.
   *  Response: `chat/sessionSwitched`. */
  | { type: "chat/switchSession"; sessionId: string }
  /** Webview → host: start a fresh conversation. The session is minted
   *  lazily on the first message, so this just clears the active id. */
  | { type: "chat/newSession" }
  | { type: "chat/renameSession"; sessionId: string; title: string }
  | { type: "chat/deleteSession"; sessionId: string }
  | { type: "map/request" }
  | { type: "map/fileSummary"; path: string }
  | { type: "map/openFile"; path: string }
  | { type: "tour/start"; intent: "codebase" }
  | { type: "tour/next" }
  | { type: "tour/stop" }
  | { type: "explainBack/submit"; explanation: string }
  | { type: "explainBack/stop" }
  | { type: "learning/done" }
  | { type: "learning/hint" }
  | { type: "learning/show" }
  | { type: "learning/stop" }
  | {
      /** User picked one of the two fork chips ("Just do it" / "Learn it
       *  with me") under an assistant message. Host either fires the
       *  learning session (learn) or synthesizes a "go ahead, do it"
       *  follow-up turn (just-do-it). */
      type: "learning/forkChosen";
      choice: "just-do-it" | "learn";
      goal: string;
      messageId: string;
    }
  | { type: "debug/log"; tag: string; message: string }
  | { type: "notes/list" }
  | { type: "notes/create"; title?: string }
  | { type: "notes/update"; id: string; title?: string; body?: string }
  | { type: "notes/delete"; id: string }
  | { type: "echo/msg"; payload: EchoWebviewToHost }
  /** Webview → host: 5-question onboarding probe completion. Host
   *  forwards to `POST /iq/onboarding` so the matchKeys go through
   *  `applyMatchKeys` and the self-declared field is mixed in via
   *  `applySelfDeclaration`. Phase A's load-bearing signal here is the
   *  declared field — the `onboarding.*` matchKeys don't yet have HMM
   *  likelihoods authored, but they're recorded as evidence for future
   *  iterations. */
  | {
      type: "iq/onboardingComplete";
      payload: { field: Iq3FieldId; matchKeys: string[] };
    }
  /** Webview → host: periodic self-rating answer. Host forwards to
   *  `POST /iq/self-rating` (Task 17), which records it as a
   *  declarative-evidence event in the HMM. `rating` is 1-10
   *  (beginner → senior); `note` is an optional free-text reason
   *  the user can leave for their future self. */
  | {
      type: "iq/selfRating";
      payload: { rating: number; note?: string };
    }
  /** Webview → host: ask for an immediate `/iq/me` fetch. Sent by the
   *  IQ dashboard on mount so the user doesn't wait up to a full 30s
   *  poll cycle to see their headline. The host also replays the last
   *  cached headline synchronously on webview mount, so this is a
   *  belt-and-braces freshness nudge rather than the primary path. */
  | { type: "iq/refresh" }
  /** Webview → host: anonymous "found something weird?" feedback on
   *  Code IQ scoring. Host forwards to `POST /iq/feedback`, which
   *  persists the trimmed text + a server timestamp ONLY — no userId,
   *  even though the endpoint is auth-gated against spam. */
  | {
      type: "iq/feedback";
      payload: { text: string };
    };

/** A single user-authored note in the Notes tab. Stored locally in
 *  globalState; cloud sync TBD. `body` is plain markdown. */
export interface Note {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export type HostToWebview =
  | { type: "chat/append"; message: ChatMessage }
  | { type: "chat/history"; messages: ChatMessage[] }
  /** Host → webview: full persisted history for the browse panel.
   *  Distinct from `chat/history` which the webview uses to replace
   *  its main `messages` state on mount — `chat/fullHistory` is a
   *  read-only snapshot the history panel consumes without clobbering
   *  the current chat view. */
  | { type: "chat/fullHistory"; messages: ChatMessage[] }
  /** Host → webview: complete list of the user's sessions plus which is
   *  currently active. Triggered by `chat/listSessions` or by host-side
   *  mutations (create / delete / clear). */
  | {
      type: "chat/sessions";
      sessions: ChatSession[];
      currentSessionId: string | null;
    }
  /** Host → webview: the active session changed; here are its messages. */
  | {
      type: "chat/sessionSwitched";
      sessionId: string;
      messages: ChatMessage[];
    }
  | { type: "chat/sessionRenamed"; sessionId: string; title: string }
  | {
      type: "chat/sessionDeleted";
      sessionId: string;
      nextSessionId: string | null;
    }
  | { type: "chat/searchResults"; results: { message: ChatMessage; snippet: string }[] }
  | { type: "notes/state"; notes: Note[] }
  | { type: "chat/loading"; loading: boolean }
  | {
      type: "chat/error";
      error: string;
      /** Set when the error is a daily-quota 429 from the backend. The
       *  webview renders these specially (banner with reset countdown +
       *  link to the Profile usage panel) instead of the generic red
       *  error line — so the user sees clearly *why* their message was
       *  rejected and when they can try again. */
      quota?: {
        kind: "chat_messages" | "tool_calls" | "voice_minutes" | "scan" | "teach" | "tts" | "stt" | "verify" | "classify";
        used: number;
        limit: number;
        resetAt: number;
      };
    }
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
      /** Forwarded straight from `MeResponse.internal` so the webview can
       *  gate dev-only surfaces. Always false until /me resolves; the gate
       *  stays closed until proven open. */
      internal: boolean;
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
      /** Host → webview: response to `voice/ttsRequest`. Either
       *  `audioBase64` is set (success) or `error` is set (failure).
       *  `requestId` mirrors the request so the webview can pair up
       *  concurrent calls (cached filler + main reply, etc.). */
      type: "voice/ttsResponse";
      requestId: string;
      audioBase64?: string;
      error?: string;
    }
  | {
      /** Host → webview: response to `voice/ttsStatusRequest`. Same
       *  fields as the /tts/status JSON, plus `requestId` for pairing. */
      type: "voice/ttsStatusResponse";
      requestId: string;
      ready: boolean;
      warmupError: string | null;
      stage?: "idle" | "downloading" | "loading" | "ready" | "error";
      progress?: number;
      loadedBytes?: number;
      totalBytes?: number;
      networkError?: string;
    }
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
  /** Live Review master-switch state. Distinct from `liveReview/state`
   *  (which is in-flight scan activity). The webview uses this to bop
   *  a red attention dot on the Live tab when 24/7 review is OFF so
   *  the user knows scanning isn't running. */
  | { type: "liveReview/enabled"; enabled: boolean }
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
  /** Host pushes today's per-user quota usage so the Live tab can
   *  render the "Today's usage" panel + cost pill. Sent on init,
   *  on `quota/get` requests, and after every 429 toast. */
  | { type: "quota/snapshot"; snapshot: QuotaSnapshot }
  /** Host pushes the currently selected backend. Always "cloud" since
   *  on-device was retired 2026-05-01; kept for wire compatibility with
   *  older webview builds that still listen for this. */
  | { type: "ai/backend"; backend: "cloud" }
  /** Host reports the current `protege.explainMode` so the Live tab's
   *  3-option toggle (Text / Voice / Both) can reflect state at a glance.
   *  Sent on activate + whenever the setting changes (via user clicking
   *  the Live toggle OR editing settings.json directly). */
  | { type: "explainMode/state"; mode: "text" | "voice" | "both" }
  /** Host reports the most recent cloud query. The webview shows this
   *  as a "last call" chip so the user sees the round-trip just ran. */
  | {
      type: "ai/lastCall";
      backend: "cloud";
      atMs: number;
      durationMs: number;
      ok: boolean;
      /** Set when the call failed; surfaced loudly on the chip. */
      fallback?: {
        requested: "cloud";
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
  /** Runtime config sent on webview ready. Currently just the backend
   *  URL — the webview hits it directly for /tts and /log, and used to
   *  hardcode `localhost:8787`. Host-side `BACKEND_URL` is the source
   *  of truth so the webview always matches whichever server the host
   *  is calling. */
  | { type: "config/backend"; url: string }
  | { type: "map/data"; data: ProjectMapData }
  | { type: "map/fileSummaryResult"; path: string; summary: string | null }
  | { type: "tour/state"; state: TourState | null }
  | { type: "tour/narrationReady"; index: number; narration: string }
  | { type: "explainBack/state"; state: ExplainBackSession | null }
  | { type: "learning/state"; state: LearningSession | null }
  | {
      /** Micro-step lesson-session snapshot. Sent on every chat turn
       *  when a teaching-text lesson is active. Null when the lesson
       *  ends or no lesson is in flight. Webview renders LessonBanner
       *  off this state. */
      type: "lesson/state";
      state: LessonStateSnapshot | null;
    }
  | {
      /** Broadcast the in-progress session trace when `protege.learning.devLogging`
       *  is on. Panel reads it to render the Dev drawer. Null = clear. */
      type: "learning/devTrace";
      trace: LearningSessionTrace | null;
    }
  | { type: "ownership/changed"; path: string; summary: OwnershipSummary }
  /** IQ3 headline pushed by the realtime bridge — polls /iq/me on a 30s
   *  cadence (plus an immediate fire on activate) and forwards the latest
   *  headline so the webview's IqDashboard can render score + pillars +
   *  field vector without polling on its own. */
  | { type: "iq/headline"; payload: Iq3Headline }
  | { type: "echo/msg"; payload: EchoHostToWebview };

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
      /** Count of assertion-style calls (`expect(`, `assert*(`, `toBe`,
       *  `toEqual`, etc.) in newly-added lines. Drives Verification ::
       *  assertionDensity. Optional for back-compat with older producers. */
      assertionsAdded?: number;
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
    }
  | {
      /** Iq3 v2 producer-sprint event. Fired on file save with a count
       *  of post-save diagnostics. Drives Verification::writesTestFiles
       *  and Execution::compilesCleanOnSave matchers. */
      type: "file_saved";
      ts: number;
      path: string;
      errorCount: number;
    }
  | {
      /** Iq3 v2 producer-sprint event. Fired on a non-trivial text edit.
       *  Drives Comprehension::pausesBeforeLargeEdits via idle-gap analysis. */
      type: "text_change";
      ts: number;
      file: string;
      charsAdded: number;
      charsRemoved: number;
    }
  | {
      /** Iq3 v2 producer-sprint event. Periodic 200-char keystroke
       *  burst marker — used by `text_change` idle-gap analysis as a
       *  "user was typing" signal. */
      type: "keystroke_batch";
      ts: number;
      file: string;
      chars: number;
    }
  | Iq3NewEvent;

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
      /** Batched persist for the "Save changes" flow. Webview buffers all
       *  concept mastery edits locally, then commits them in one RPC so
       *  tiles don't reshuffle between every click. Host POSTs each
       *  concept, then refetches the dashboard ONCE at the end. */
      type: "echo_saveConceptStatuses";
      changes: Array<{ concept: string; status: ConceptKnownStatus }>;
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
    }
  | {
      /** Login-first: emitted by the Echo webview's sign-in gate when the
       *  user clicks "Sign in with GitHub". The host pops the OAuth dialog
       *  via `getGitHubUser({ createIfNone: true })` and re-runs the
       *  dashboard fetch when the session resolves. */
      type: "echo_signIn";
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
    }
  | {
      /** Login-first: emitted by the host when the Echo webview tries to
       *  hit the backend without a GitHub session. The webview renders a
       *  sign-in gate; clicking the button posts back `auth/login` (on the
       *  main HostToWebview channel) so the host can pop the OAuth dialog. */
      type: "echo_authRequired";
    };

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
  /** How the lines came to exist.
   *  - "typed": user keystrokes / fast typing / formatter output — owned by default.
   *  - "auto-inserted": AI tool wrote into the editor (Cursor Tab, Copilot, Claude Code apply).
   *  - "pasted": user pasted from clipboard — distinct from AI insert because the user
   *    chose the bytes (probably from elsewhere) but didn't author them. */
  origin: "typed" | "auto-inserted" | "pasted";
  /** ms epoch when the user successfully explained / drilled this range,
   *  or null if still unreviewed. Typed regions may have `explainedAt`
   *  null — they still count as owned. */
  explainedAt: number | null;
  /** ms epoch when this region was first recorded. Drives the auto-
   *  expire behaviour for unreviewed auto-inserted regions — stale
   *  "AI blocks" from hours-old sessions shouldn't reappear forever.
   *  Optional for backward compatibility with regions recorded before
   *  the field was introduced (they're treated as stale on load). */
  createdAt?: number;
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

/* ========== Learning Mode ========== */

/** One step in a LearningPlan. The plan is generated once at session
 *  start; step states mutate as the user progresses through them. */
export interface LearningStep {
  /** Stable id assigned by the planner — validator calls reference this
   *  so an out-of-order validation still targets the right step. */
  id: string;
  /** Short title shown as the row header. Under 60 chars. */
  title: string;
  /** Optional one-sentence mental model — the WHY of this step. Shown
   *  above whatToDo in the panel. Absent for legacy plans generated
   *  before the pedagogy prompt change; fallback is just whatToDo. */
  whyItMatters?: string;
  /** 2–3 sentences describing the OUTCOME, never the code. */
  whatToDo: string;
  /** One sentence, verifiable from the file contents alone. The
   *  validator compares current file state against this. */
  successCriteria: string;
  /** One-sentence nudge, revealed only when the user clicks "Hint".
   *  Ladder rung, not the answer. */
  hint: string;
  /** Optional last-resort reference snippet. Shown when the user clicks
   *  "Show me" — costs the step its "pass" credit since it's no longer
   *  self-built. */
  referenceSnippet?: string;
  /** Current UI/validation state. */
  status: "pending" | "current" | "passed" | "partial" | "failed" | "off-track" | "shown";
  /** Number of "I'm done" attempts this step has seen. */
  attempts: number;
  /** Whether the user has revealed the hint for this step. Resets on
   *  session restart; purely UI hint. */
  hintRevealed: boolean;
  /** Last validator feedback, if any. Set by every /validate call. */
  lastNote?: string;
  /** Extra positive thing the validator noticed ("you also refactored
   *  X — clean"). Displayed as a secondary line under the main note. */
  lastBonus?: string;
  /** Validator's retry nudge on non-pass outcomes. */
  lastHintFromValidator?: string;
}

/** The plan emitted by the plan-generator LLM. Frozen at session start. */
export interface LearningPlan {
  /** One-sentence restatement of what the user will build. */
  goal: string;
  /** Ordered 3–5 steps. */
  steps: LearningStep[];
  /** Validator-friendly estimate used only for the header copy. */
  estimatedMinutes: number;
  /** Concept slugs from the registry, for mastery attribution on
   *  session complete. E.g. ["react/useState", "conditional-rendering"]. */
  conceptsTagged: string[];
  /** Range of the file this session covers — used by markExplained on
   *  completion so the Map tab's dot rises. */
  ownershipRange: { startLine: number; endLine: number };
}

export interface LearningSession {
  /** Stable session id (uuid). Used as the git-note anchor + persistence key. */
  id: string;
  /** User's verbatim goal as they typed it. */
  goal: string;
  /** File the session is scoped to. */
  path: string;
  /** Language id for syntax highlighting in the panel. */
  language: string;
  /** Frozen plan generated at start. */
  plan: LearningPlan;
  /** Current active step index (0-based). */
  currentStepIndex: number;
  /** ms epoch when the session started. */
  startedAt: number;
  /** ms epoch when the session was marked complete or abandoned. Null while active. */
  completedAt: number | null;
  /** True while the validator's LLM call is in flight for the current
   *  step — the panel disables "I'm done" to prevent double-clicks. */
  validating: boolean;
  /** Outcome — populated when completedAt is set. */
  outcome?: "complete" | "abandoned";
}

/** Lightweight per-session record persisted to globalState after
 *  completion. Feeds the "Learning log" list in the Profile overlay. */
export interface LearningSessionLogEntry {
  id: string;
  goal: string;
  path: string;
  startedAt: number;
  completedAt: number;
  outcome: "complete" | "abandoned";
  stepsPassed: number;
  stepsTotal: number;
  totalAttempts: number;
  elapsedMs: number;
  conceptsTagged: string[];
  /** Optional full-fidelity trace for iterating on teaching quality.
   *  Captured when `protege.learning.devLogging` is on; older entries
   *  retain only the summary above. See plans/create-a-plan-how-buzzing-walrus.md. */
  trace?: LearningSessionTrace;
}

/** Current schema version for LearningSessionTrace. Bump on breaking changes;
 *  parsers should skip traces with an unknown version. */
export const LEARNING_TRACE_SCHEMA_VERSION = 1;

/** Full-fidelity capture of one Learning Mode session — raw Haiku plan,
 *  every validator call, reveal events. Stored in globalState (capped, see
 *  learningMode.ts) and/or exported to disk via `protege.learning.exportSession`.
 *  Purely observational: never re-calls the model, just stores what was already
 *  sent/returned during the live session. */
export interface LearningSessionTrace {
  traceSchemaVersion: number;
  sessionId: string;
  goal: string;
  planRaw: string;            // raw Haiku output text (pre-parse)
  plan: LearningPlan;          // parsed plan
  events: LearningTraceEvent[];
  /** Set when trace was trimmed to fit the globalState size cap. Oldest
   *  events drop first; newest (including session-ended) kept. */
  truncated?: boolean;
}

export type LearningTraceEvent =
  | {
      kind: "plan-generated";
      at: string;
      elapsedMs: number;
    }
  | {
      kind: "validation";
      at: string;
      stepId: string;
      attempt: number;
      fileBefore: string;        // truncated to ~2KB
      fileNow: string;           // truncated to ~2KB
      verdictRaw: string;        // raw Haiku text (pre-parse)
      verdict: {
        status: "pass" | "partial" | "fail" | "off-track";
        note?: string;
        hint?: string;
        caught_bonus?: string;
        ready_for_next?: boolean;
      };
      elapsedMs: number;
    }
  | { kind: "hint-revealed"; at: string; stepId: string }
  | { kind: "show-revealed"; at: string; stepId: string }
  | { kind: "session-ended"; at: string; outcome: "complete" | "abandoned" | "replaced" };

export * from "./iq3/index.js";
