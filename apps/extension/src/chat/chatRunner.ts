import * as vscode from "vscode";
import type {
  ChatBackend,
  ChatMode,
  ChatRunRequest,
  ChatRunResponse,
  ChatTier,
  LessonStateSnapshot,
  OAITurn,
  ToolCall,
  ToolResult,
} from "@protege/types";
import { BACKEND_URL, authedFetch, NotAuthenticatedError } from "../user/protegeClient.js";

/**
 * Thrown when /chat returns 429 with the daily-quota body shape. Carries
 * the structured fields the webview needs to render a friendly banner
 * (used / limit / resetAt) instead of a generic red error line.
 *
 * Caught in `webviewHost.ts` and converted to a `chat/error` message
 * with the `quota` field populated.
 */
export class QuotaExceededChatError extends Error {
  readonly kind: string;
  readonly used: number;
  readonly limit: number;
  readonly resetAt: number;

  constructor(payload: {
    kind: string;
    used: number;
    limit: number;
    resetAt: number;
    message?: string;
  }) {
    super(payload.message ?? "daily quota exceeded");
    this.name = "QuotaExceededChatError";
    this.kind = payload.kind;
    this.used = payload.used;
    this.limit = payload.limit;
    this.resetAt = payload.resetAt;
  }
}
import { executeTool, buildWorkspaceContext } from "../ai/tools.js";
import { isTeachingMessage } from "../intent/teachingTrigger.js";

/**
 * We import the user's backend preference via dynamic require to avoid
 * a circular import (aiBackend imports runSingleQuery from here). Live-
 * binding dynamic lookup is safe because this is only called inside
 * request functions, long after both modules have finished loading.
 */
function resolveCloudBackend(): ChatBackend {
  // TEMP: Sonnet is disabled across the app — every cloud call routes to
  // Haiku. The branching below is reduced to "always haiku" so the chat
  // path matches `aiBackend.ts`'s coercion. To restore Sonnet: bring
  // back the `getAiBackend()` lookup and the `if (choice === "sonnet")`
  // branch.
  return "haiku";
}

/** Claude runs as long as it needs to for legitimate tasks. The
 *  heartbeat log every HEARTBEAT_ROUNDS surfaces stuck loops via
 *  `Protege: Show Logs`. RUNAWAY_LIMIT is a deliberately-high safety
 *  cap (no legitimate request approaches it) that bounds a pathological
 *  runaway — without it, a misbehaving tool-call chain can burn quota
 *  + cost indefinitely. Anthropic's upstream rate limits also apply. */
const HEARTBEAT_ROUNDS = 25;
const RUNAWAY_LIMIT = 200;

interface RunnerCallbacks {
  onTool?: (
    call: ToolCall,
    status: "running" | "done" | "error"
  ) => void;
  log?: (line: string) => void;
  /** Fired whenever the backend returns lesson-session state. Used by
   *  webviewHost to broadcast `lesson/state` to the chat panel so the
   *  in-app banner can update per turn. Null = lesson ended or none active. */
  onLessonState?: (state: LessonStateSnapshot | null) => void;
}

export interface RunChatOptions {
  mode?: ChatMode;
  /** Prior conversation turns (user + assistant) loaded from globalState.
   *  When passed, Claude sees the recent history and can resolve pronouns
   *  ("yes, do that"), follow-up questions, and carry context across voice
   *  turns where the user can't see what was just said. */
  history?: OAITurn[];
  /** Abort signal for user-initiated cancel (composer Stop button). When
   *  fired mid-fetch, native fetch throws AbortError; between rounds the
   *  loop check below throws synchronously so we don't kick off another
   *  /chat call after the user already said stop. */
  signal?: AbortSignal;
}

/**
 * Runs the tool-enabled chat loop client-side.
 * - First call seeds with workspace context + the user's message.
 * - If backend returns toolCalls, we execute them here and send results back.
 * - Loop until backend returns a final reply or we hit MAX_TOOL_ROUNDS.
 */
export async function runChat(
  userId: string,
  userMessage: string,
  cb: RunnerCallbacks = {},
  opts: RunChatOptions = {}
): Promise<string> {
  // Mode resolution order: explicit caller mode > teach-shaped first message > text.
  // The teaching upgrade only fires on the FIRST message of a thread (no
  // history) so short mid-lesson replies like "ok" or "got it" don't flip
  // the mode out from under the lesson.
  const isFirstMessage = !opts.history || opts.history.length === 0;
  const inferredTeaching =
    opts.mode === undefined &&
    isFirstMessage &&
    isTeachingMessage(userMessage);
  const mode: ChatMode =
    opts.mode ?? (inferredTeaching ? "teaching-text" : "text");
  if (inferredTeaching) {
    console.log(
      `[protege] runChat: teaching-text mode triggered from first-message classifier`
    );
  }
  const workspace = await buildWorkspaceContext();

  // Seed with recent conversation history so Claude can resolve follow-up
  // questions ("yes, do that"). Empty on first turn.
  let messages: OAITurn[] = opts.history ? [...opts.history] : [];
  let newUserMessage: string | undefined = userMessage;
  let toolResults: ToolResult[] | undefined = undefined;

  const backend = resolveCloudBackend();

  for (let round = 0; ; round++) {
    // Honor an aborted signal between rounds so we don't fire the next
    // /chat call after the user clicked Stop while a tool was running.
    if (opts.signal?.aborted) {
      throw opts.signal.reason instanceof Error
        ? opts.signal.reason
        : new DOMException("Aborted", "AbortError");
    }
    if (round > 0 && round % HEARTBEAT_ROUNDS === 0) {
      cb.log?.(
        `[protege] chat still running at round ${round} — reload window if stuck`
      );
    }
    if (round >= RUNAWAY_LIMIT) {
      cb.log?.(
        `[protege] chat hit runaway cap at round ${RUNAWAY_LIMIT} — aborting to protect quota`
      );
      throw new Error(
        `chat tool-call loop exceeded ${RUNAWAY_LIMIT} rounds`
      );
    }
    const body: ChatRunRequest = {
      userId,
      workspace: round === 0 ? workspace : undefined,
      messages,
      newUserMessage,
      toolResults,
      mode,
      backend,
    };

    // authedFetch handles 401 silently: it re-probes VS Code for the
    // current GitHub session (no UI), retries once, and only throws
    // NotAuthenticatedError if the session is genuinely gone. That
    // replaces the raw fetch that used to propagate the backend's
    // "invalid or expired token" string straight into the chat bubble.
    let res: Response;
    try {
      res = await authedFetch(`${BACKEND_URL}/chat`, {
        method: "POST",
        body: JSON.stringify(body),
        signal: opts.signal,
      });
    } catch (err) {
      if (err instanceof NotAuthenticatedError) {
        throw new Error("Sign in with GitHub to use Protege.");
      }
      throw err;
    }

    const raw = await res.text();
    let data: ChatRunResponse & {
      error?: string;
      kind?: string;
      used?: number;
      limit?: number;
      resetAt?: number;
    } = { messages: [] };
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(
        `Backend non-JSON (HTTP ${res.status}): ${raw.slice(0, 200)}`
      );
    }
    // 429 daily-quota response: throw a typed error so the host can
    // render a friendly banner (with countdown + Profile link) instead
    // of the generic red error line. The shape mirrors what
    // `enforceQuotaInline` returns in apps/backend/src/middleware/quota.ts.
    if (
      res.status === 429 &&
      data.error === "daily quota exceeded" &&
      typeof data.kind === "string" &&
      typeof data.used === "number" &&
      typeof data.limit === "number" &&
      typeof data.resetAt === "number"
    ) {
      throw new QuotaExceededChatError({
        kind: data.kind,
        used: data.used,
        limit: data.limit,
        resetAt: data.resetAt,
      });
    }
    if (!res.ok || data.error) {
      throw new Error(data.error ?? `HTTP ${res.status}`);
    }

    messages = data.messages;
    newUserMessage = undefined;
    toolResults = undefined;

    // Forward lesson state to the host whenever the backend includes it.
    // This fires once per round (server-tool round, terminal reply, etc.) —
    // the host dedupes by storing only the latest state and broadcasting
    // a single `lesson/state` message per turn.
    if (data.lessonState !== undefined) {
      cb.onLessonState?.(data.lessonState);
    }

    if (data.reply !== undefined) {
      cb.log?.(`[protege] chat final round=${round + 1}`);
      return data.reply;
    }

    if (!data.toolCalls || data.toolCalls.length === 0) {
      return "";
    }

    // Execute tool calls, collect results
    const results: ToolResult[] = [];
    for (const call of data.toolCalls) {
      cb.onTool?.(call, "running");
      cb.log?.(`[protege] tool → ${call.name} ${JSON.stringify(call.arguments)}`);
      const result = await executeTool(call);
      cb.onTool?.(call, result.error ? "error" : "done");
      results.push(result);
    }
    toolResults = results;
  }
  // Unreachable — the for-loop has no exit condition except `return`
  // inside the body on a final reply or empty toolCalls. Keeping this
  // pragma line so TypeScript knows the function does in fact return.
}

/**
 * Lightweight one-shot query to Claude — no tool loop, no workspace context.
 * Used for quick inline operations (fix-it, explain, etc.) where we just need
 * a short text reply and don't want tool execution overhead.
 */
export async function runSingleQuery(
  prompt: string,
  opts: { mode?: ChatMode; noTools?: boolean; tier?: ChatTier } = {}
): Promise<string> {
  // Caller-trace diagnostic — same shape as aiBackend.ts so a single
  // grep on `runSingleQuery FIRE` in the extension console reveals
  // every direct (non-aiQuery) caller. teachConceptDispatch and
  // ghostMentor.runVoiceExplanation are the known direct callers; this
  // catches any new ones too.
  const callerTrace = (() => {
    const stack = new Error().stack ?? "";
    const lines = stack.split("\n").slice(1);
    for (const line of lines) {
      if (line.includes("chatRunner") || line.includes("aiBackend")) continue;
      const m = line.match(/at (\S+) \(.*?([^/\\]+:\d+):\d+\)/) ??
                line.match(/at .*?([^/\\]+:\d+):\d+/);
      if (m) return m.length === 3 ? `${m[1]} · ${m[2]}` : m[1];
      return line.trim();
    }
    return "unknown caller";
  })();
  const promptPreview = prompt.slice(0, 60).replace(/\s+/g, " ");
  console.log(
    `[protege] runSingleQuery FIRE · caller=${callerTrace} · prompt="${promptPreview}…"`
  );

  const body: ChatRunRequest = {
    messages: [],
    newUserMessage: prompt,
    mode: opts.mode ?? "text",
    backend: resolveCloudBackend(),
    tier: opts.tier ?? "premium",
    // Default to disabling tools for one-shot queries. Without this, Claude
    // may respond with a tool call (e.g. read_file) instead of the JSON/
    // string we're waiting for — and the one-shot loop can't consume tool
    // rounds, so the caller would get "" and silently fail (see reviewEngine
    // → "scan ran but 0 suggestions" mystery).
    noTools: opts.noTools ?? true,
  };

  let res: Response;
  try {
    res = await authedFetch(`${BACKEND_URL}/chat`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  } catch (err) {
    if (err instanceof NotAuthenticatedError) {
      throw new Error("Sign in with GitHub to use Protege.");
    }
    throw err;
  }

  const raw = await res.text();
  let data: ChatRunResponse & { error?: string } = { messages: [] };
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(
      `Backend non-JSON (HTTP ${res.status}): ${raw.slice(0, 200)}`
    );
  }
  if (!res.ok || data.error) {
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
  return data.reply ?? "";
}
