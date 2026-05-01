import { getSupabase } from "./supabase.js";

/**
 * Per-user daily quotas — beta-tier cost ceiling.
 *
 * Single Supabase table `user_quotas` keyed by (user_id, day). One row
 * per user per UTC day; counters increment on every guarded route, $
 * estimate accumulates from token-derived per-call cost.
 *
 * Limits are tuned for "real use shouldn't notice, runaway loops do."
 * Tweak from the rollup view (`user_quotas_weekly`) once we have data.
 *
 * Activation gate: only enforces when `PROTEGE_QUOTAS=on`. Local dev
 * and existing deployments keep working until that flag is flipped.
 */

export type QuotaKind =
  | "scan"
  | "teach"
  | "tts"
  | "stt"
  | "verify"
  | "classify";

/**
 * Internal per-route counters. These are the caps the middleware
 * actually enforces against. Each counter is its own column so we
 * can tune individually + rollup for telemetry.
 *
 * The user-facing panel rolls these into 3 friendlier categories:
 *   chat_messages = teach
 *   tool_calls    = (separate column tool_calls, populated by /chat
 *                    response.toolUses.length)
 *   voice_minutes = (separate column voice_minutes, accumulated by
 *                    /tts from text length + /stt from audio duration)
 *
 * The other counters (scan, verify, classify) stay tracked for cost
 * control but aren't shown in the panel — they're plumbing the user
 * doesn't have to think about.
 */
export const QUOTA_LIMITS: Record<QuotaKind, number> = {
  scan: 300,
  teach: 100, // user-facing "Chat messages" — bumped 80 → 100 per beta tier
  tts: 40, // internal cap; user sees voice_minutes in the panel
  stt: 60, // internal cap; user sees voice_minutes in the panel
  verify: 500,
  classify: 500,
};

/** User-facing limits surfaced in the Profile page "Usage today" panel.
 *  These are what users see and self-regulate against. */
export const USER_FACING_LIMITS = {
  chat_messages: 100, // alias of teach
  tool_calls: 25, // sum of tool_uses returned by /chat
  voice_minutes: 25, // tts text-derived + stt audio-derived
} as const;

export const DAILY_USD_HARD_CAP = 2.0;

const COLUMN_BY_KIND: Record<QuotaKind, string> = {
  scan: "scan_calls",
  teach: "teach_calls",
  tts: "tts_calls",
  stt: "stt_calls",
  verify: "verify_calls",
  classify: "classify_calls",
};

export function quotasEnforced(): boolean {
  return process.env.PROTEGE_QUOTAS === "on";
}

/**
 * Health-check the quota subsystem at startup so logs make it
 * blindingly obvious whether the table is reachable. Also exposes the
 * latest probe state to `/me/quota`'s `meta` block so the extension
 * panel can paint a "● connected" / "○ not configured" indicator.
 *
 * State machine:
 *   "unknown"       — probe not run yet (very early activation)
 *   "no-supabase"   — SUPABASE_URL or SUPABASE_*_KEY missing in env
 *   "table-missing" — Supabase reachable but `user_quotas` table not
 *                     present (run the SQL migration in beta-quotas.md)
 *   "connected"     — everything works
 *   "error"         — Supabase reachable but the probe query errored
 *                     (RLS denying service role? wrong column shape?)
 */
export type QuotaProbeStatus =
  | "unknown"
  | "no-supabase"
  | "table-missing"
  | "connected"
  | "error";

let lastProbe: { status: QuotaProbeStatus; detail?: string } = {
  status: "unknown",
};

export function getQuotaProbeStatus(): {
  status: QuotaProbeStatus;
  detail?: string;
} {
  return lastProbe;
}

/** True unless the probe has positively identified the schema as
 *  unusable. Returns true on "unknown" (probe hasn't run — typical in
 *  unit tests) and "connected"; false on "no-supabase" and
 *  "table-missing". The point is to silence the per-request error spam
 *  in dev when the migration hasn't been applied — the startup probe
 *  already logs it once. */
function isQuotaSchemaReady(): boolean {
  return (
    lastProbe.status === "connected" || lastProbe.status === "unknown"
  );
}

/**
 * Run a single read against `user_quotas` to confirm the table exists
 * and the service role can see it. Called once on backend startup.
 * Logs the result loudly so a misconfigured env doesn't fail silently
 * with "panel always shows 0/100" symptoms.
 */
export async function probeQuotaTable(): Promise<void> {
  const sb = getSupabase();
  if (!sb) {
    lastProbe = {
      status: "no-supabase",
      detail: "SUPABASE_URL or SUPABASE_*_KEY missing in env",
    };
    console.warn(
      "[quotas] STARTUP PROBE · status=no-supabase · " +
        "set SUPABASE_URL and SUPABASE_SERVICE_KEY (or _ANON_KEY) in .env"
    );
    return;
  }
  // limit(1) is enough to confirm the table exists + RLS lets us see it.
  const { error } = await sb.from("user_quotas").select("user_id").limit(1);
  if (!error) {
    lastProbe = { status: "connected" };
    console.log(
      `[quotas] STARTUP PROBE · status=connected · enforce=${quotasEnforced() ? "on" : "off"}`
    );
    return;
  }
  // Supabase reports the table missing in two distinct shapes:
  //   - 42P01 = Postgres "relation does not exist" (direct PG error)
  //   - PGRST205 + message "Could not find the table ... in the schema
  //     cache" = PostgREST hasn't indexed the table (often because it
  //     genuinely doesn't exist). Either way, run the migration.
  const code = (error as { code?: string }).code ?? "";
  const msg = error.message || "";
  const looksLikeMissingTable =
    code === "42P01" ||
    code === "PGRST205" ||
    /Could not find the table .* in the schema cache/i.test(msg);
  if (looksLikeMissingTable) {
    lastProbe = {
      status: "table-missing",
      detail: msg,
    };
    console.warn(
      "[quotas] STARTUP PROBE · status=table-missing · run the user_quotas " +
        "SQL migration from ~/.claude/plans/beta-quotas.md (CREATE TABLE + ALTER TABLE)"
    );
    return;
  }
  lastProbe = { status: "error", detail: msg };
  console.warn(
    `[quotas] STARTUP PROBE · status=error · ${msg}`
  );
}

/** Today's date in UTC, formatted yyyy-mm-dd. The quota table partitions
 *  by this so resets happen at 00:00 UTC. */
function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Epoch ms of the next 00:00 UTC — when today's row stops mattering
 *  and a new one begins. Used by the client UI to show "resets in N". */
export function nextResetMs(): number {
  const now = new Date();
  const next = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
      0,
      0,
      0,
      0
    )
  );
  return next.getTime();
}

interface QuotaRow {
  user_id: string;
  day: string;
  scan_calls: number;
  teach_calls: number;
  tts_calls: number;
  stt_calls: number;
  verify_calls: number;
  classify_calls: number;
  /** Sum of tool_uses across /chat responses today. */
  tool_calls: number;
  /** Cumulative voice activity in minutes (TTS text-derived +
   *  STT audio-derived). Float so partial minutes accumulate. */
  voice_minutes: number;
  /** Cumulative chat engagement in minutes — time between consecutive
   *  user messages, capped at 60s per gap. Captures "user actively
   *  engaged in conversation" without inflating idle/away time. */
  chat_minutes: number;
  total_usd_estimate: number;
}

const EMPTY_ROW = (userId: string): QuotaRow => ({
  user_id: userId,
  day: utcDay(),
  scan_calls: 0,
  teach_calls: 0,
  tts_calls: 0,
  stt_calls: 0,
  verify_calls: 0,
  classify_calls: 0,
  tool_calls: 0,
  voice_minutes: 0,
  chat_minutes: 0,
  total_usd_estimate: 0,
});

/**
 * Fetch today's quota row for a user, creating an empty placeholder
 * (in memory only) if one doesn't exist yet. Returns null when Supabase
 * is unreachable so callers can fail-open during beta.
 */
export async function getTodayQuota(userId: string): Promise<QuotaRow | null> {
  if (!isQuotaSchemaReady()) return null;
  const sb = getSupabase();
  if (!sb) return null;
  const day = utcDay();
  const { data, error } = await sb
    .from("user_quotas")
    .select("*")
    .eq("user_id", userId)
    .eq("day", day)
    .maybeSingle();
  if (error) {
    console.warn("[quotas] fetch failed:", error.message);
    return null;
  }
  return (data as QuotaRow | null) ?? EMPTY_ROW(userId);
}

/**
 * Atomically check + pre-increment. Returns `{ allowed: false, ... }`
 * when the route count or $ cap would be exceeded; `{ allowed: true,
 * row }` otherwise (with the post-increment row for logging).
 *
 * Pre-incrementing closes the race where two concurrent requests both
 * see "1 under the limit" and both go through. Worst case the same
 * user gets one extra call past the cap; never two.
 */
export async function checkAndIncrement(
  userId: string,
  kind: QuotaKind
): Promise<
  | { allowed: true; row: QuotaRow }
  | {
      allowed: false;
      reason: "route-cap" | "dollar-cap";
      kind: QuotaKind;
      used: number;
      limit: number;
      resetAt: number;
    }
> {
  if (!isQuotaSchemaReady()) {
    // Probe said the table is unusable — fail-open silently to keep
    // request paths working in dev without spamming the log.
    return { allowed: true, row: EMPTY_ROW(userId) };
  }
  const sb = getSupabase();
  if (!sb) {
    // Fail-open when Supabase is down — beta reliability over strict
    // ceilings. Caller still gets a synthetic "allowed" result so the
    // request can proceed.
    return { allowed: true, row: EMPTY_ROW(userId) };
  }
  const day = utcDay();
  const column = COLUMN_BY_KIND[kind];
  const limit = QUOTA_LIMITS[kind];

  // Read current row (may not exist yet).
  const { data: current, error: readErr } = await sb
    .from("user_quotas")
    .select("*")
    .eq("user_id", userId)
    .eq("day", day)
    .maybeSingle();
  if (readErr) {
    console.warn("[quotas] read failed:", readErr.message);
    return { allowed: true, row: EMPTY_ROW(userId) };
  }

  const row = (current as QuotaRow | null) ?? EMPTY_ROW(userId);

  // Check caps BEFORE incrementing.
  if (row.total_usd_estimate >= DAILY_USD_HARD_CAP) {
    return {
      allowed: false,
      reason: "dollar-cap",
      kind,
      used: row.total_usd_estimate,
      limit: DAILY_USD_HARD_CAP,
      resetAt: nextResetMs(),
    };
  }
  const usedForKind = (row[column as keyof QuotaRow] as number) ?? 0;
  if (usedForKind >= limit) {
    return {
      allowed: false,
      reason: "route-cap",
      kind,
      used: usedForKind,
      limit,
      resetAt: nextResetMs(),
    };
  }

  // Pre-increment via UPSERT. The row is created-if-missing with this
  // kind's counter at 1; otherwise the existing counter is bumped.
  const incremented: QuotaRow = {
    ...row,
    [column]: usedForKind + 1,
    user_id: userId,
    day,
  };
  const { error: writeErr } = await sb.from("user_quotas").upsert(
    incremented,
    { onConflict: "user_id,day" }
  );
  if (writeErr) {
    console.warn("[quotas] upsert failed:", writeErr.message);
    return { allowed: true, row };
  }
  return { allowed: true, row: incremented };
}

/**
 * Add a $ delta to today's running estimate. Called from the route
 * handler AFTER it knows the actual token usage of the call.
 *
 * No-op when Supabase is unreachable.
 */
export async function addCostUsd(
  userId: string,
  deltaUsd: number
): Promise<void> {
  if (deltaUsd <= 0) return;
  if (!isQuotaSchemaReady()) return;
  const sb = getSupabase();
  if (!sb) return;
  const day = utcDay();
  // Read-modify-UPSERT. UPSERT (not UPDATE) so the helper works even
  // when no quota row exists yet for today — required because the gate
  // path that normally creates the row (`checkAndIncrement`) is bypassed
  // when PROTEGE_QUOTAS is off, and we still want $ accumulation to be
  // observable in the panel for telemetry. Concurrent calls can race
  // here, but $ accuracy is a budget signal not a billing source of
  // truth — close-enough is fine.
  const { data, error } = await sb
    .from("user_quotas")
    .select("total_usd_estimate")
    .eq("user_id", userId)
    .eq("day", day)
    .maybeSingle();
  if (error) {
    console.warn("[quotas] addCostUsd read failed:", error.message);
    return;
  }
  const current = (data?.total_usd_estimate as number | undefined) ?? 0;
  const { error: writeErr } = await sb.from("user_quotas").upsert(
    {
      user_id: userId,
      day,
      total_usd_estimate: current + deltaUsd,
    },
    { onConflict: "user_id,day" }
  );
  if (writeErr) {
    console.warn("[quotas] addCostUsd write failed:", writeErr.message);
  }
}

/**
 * Estimate the USD cost of a single call from token counts and tier.
 * Mirrors the per-million pricing the extension uses so server + client
 * agree on the running total.
 */
export function estimateCallCostUsd(
  tier: "cheap" | "premium",
  inTokens: number,
  outTokens: number
): number {
  if (tier === "cheap") {
    // gpt-4o-mini class: $0.15/Mtok in, $0.60/Mtok out.
    return (inTokens * 0.15 + outTokens * 0.6) / 1_000_000;
  }
  // gpt-4.1 / gpt-5 class: ~$2.50/Mtok in, ~$10/Mtok out.
  return (inTokens * 2.5 + outTokens * 10) / 1_000_000;
}

/**
 * Public-shape view of today's usage, returned by `/me/quota`. Three
 * user-facing categories the Live tab renders as progress bars + a
 * $ pill. The internal granular counters (scan, verify, classify) are
 * still tracked in the DB for cost control, but they're plumbing the
 * user doesn't need to see — keeping the panel down to 3 rows that
 * map to "things I am visibly doing in the app."
 */
export interface QuotaSnapshot {
  userId: string;
  day: string;
  resetAt: number;
  usage: {
    /** /chat premium-tier turns. Each user message + assistant reply
     *  pair counts as one. */
    chat_messages: { used: number; limit: number };
    /** Tool invocations the assistant made inside /chat (read_file,
     *  edit_file, grep, etc.). Sum of `result.toolUses.length` across
     *  all chat turns today. */
    tool_calls: { used: number; limit: number };
    /** Combined TTS + STT minutes today. TTS contributes
     *  text_length / 750 chars-per-minute; STT contributes the audio
     *  blob's actual duration. */
    voice_minutes: { used: number; limit: number };
    /** Cumulative chat engagement in minutes today. Sum of capped
     *  gaps between consecutive user messages. Display-only (no cap
     *  enforcement); useful for "voice X% / chat Y%" splits. */
    chat_minutes: { used: number };
    /** Daily $ ceiling — token-derived best-effort estimate. */
    cost: { used: number; limitUsd: number };
  };
  /** Subsystem health — populated from the startup probe + current
   *  enforcement flag. Surfaced in the panel as a small status dot so
   *  users (and we) can tell at a glance whether counters are real or
   *  whether something is misconfigured server-side. */
  meta: {
    enforced: boolean;
    probe: QuotaProbeStatus;
    probeDetail?: string;
  };
}

export function snapshotFromRow(
  userId: string,
  row: QuotaRow | null
): QuotaSnapshot {
  const r = row ?? EMPTY_ROW(userId);
  return {
    userId,
    day: r.day,
    resetAt: nextResetMs(),
    usage: {
      chat_messages: {
        used: r.teach_calls,
        limit: USER_FACING_LIMITS.chat_messages,
      },
      tool_calls: {
        used: r.tool_calls,
        limit: USER_FACING_LIMITS.tool_calls,
      },
      voice_minutes: {
        // Round to 1 decimal for display so "6.4 / 20" reads cleanly
        // instead of "6.42857 / 20".
        used: Math.round(r.voice_minutes * 10) / 10,
        limit: USER_FACING_LIMITS.voice_minutes,
      },
      chat_minutes: {
        used: Math.round(r.chat_minutes * 10) / 10,
      },
      cost: { used: r.total_usd_estimate, limitUsd: DAILY_USD_HARD_CAP },
    },
    meta: {
      enforced: quotasEnforced(),
      probe: lastProbe.status,
      probeDetail: lastProbe.detail,
    },
  };
}

/**
 * Accumulate tool-call count for today's row. Called from /chat after
 * the model returns, with the count of tool_uses in the response.
 *
 * Caps at the user-facing limit — even though the route counter
 * (teach_calls) might still have room, hitting the tool-call ceiling
 * means the next /chat call gets a 429 (handled separately by the
 * inline check below). For now this just records actual use; the
 * inline pre-check in /chat enforces.
 */
export async function addToolCalls(
  userId: string,
  delta: number
): Promise<void> {
  if (delta <= 0) return;
  if (!isQuotaSchemaReady()) return;
  const sb = getSupabase();
  if (!sb) return;
  const day = utcDay();
  const { data, error } = await sb
    .from("user_quotas")
    .select("tool_calls")
    .eq("user_id", userId)
    .eq("day", day)
    .maybeSingle();
  if (error) {
    console.warn("[quotas] addToolCalls read failed:", error.message);
    return;
  }
  const current = (data?.tool_calls as number | undefined) ?? 0;
  // UPSERT — see addCostUsd comment for rationale.
  const { error: writeErr } = await sb.from("user_quotas").upsert(
    { user_id: userId, day, tool_calls: current + delta },
    { onConflict: "user_id,day" }
  );
  if (writeErr) {
    console.warn("[quotas] addToolCalls write failed:", writeErr.message);
  }
}

/**
 * Accumulate voice minutes for today's row. /tts derives minutes from
 * text length (~750 chars/min for typical TTS); /stt derives from
 * audio blob duration.
 */
export async function addVoiceMinutes(
  userId: string,
  minutes: number
): Promise<void> {
  if (minutes <= 0) return;
  if (!isQuotaSchemaReady()) return;
  const sb = getSupabase();
  if (!sb) return;
  const day = utcDay();
  const { data, error } = await sb
    .from("user_quotas")
    .select("voice_minutes")
    .eq("user_id", userId)
    .eq("day", day)
    .maybeSingle();
  if (error) {
    console.warn("[quotas] addVoiceMinutes read failed:", error.message);
    return;
  }
  const current = (data?.voice_minutes as number | undefined) ?? 0;
  // UPSERT — see addCostUsd comment for rationale.
  const { error: writeErr } = await sb.from("user_quotas").upsert(
    { user_id: userId, day, voice_minutes: current + minutes },
    { onConflict: "user_id,day" }
  );
  if (writeErr) {
    console.warn("[quotas] addVoiceMinutes write failed:", writeErr.message);
  }
}

/**
 * Add to the user's daily chat-engagement minutes. Caller passes the
 * pre-computed gap (minutes) — typically the time between consecutive
 * user messages, capped at 60s per gap so an idle/away pause doesn't
 * inflate the counter. See `recordChatEngagement` in routes/chat.ts.
 */
export async function addChatMinutes(
  userId: string,
  minutes: number
): Promise<void> {
  if (minutes <= 0) return;
  if (!isQuotaSchemaReady()) return;
  const sb = getSupabase();
  if (!sb) return;
  const day = utcDay();
  const { data, error } = await sb
    .from("user_quotas")
    .select("chat_minutes")
    .eq("user_id", userId)
    .eq("day", day)
    .maybeSingle();
  if (error) {
    console.warn("[quotas] addChatMinutes read failed:", error.message);
    return;
  }
  const current = (data?.chat_minutes as number | undefined) ?? 0;
  const { error: writeErr } = await sb.from("user_quotas").upsert(
    { user_id: userId, day, chat_minutes: current + minutes },
    { onConflict: "user_id,day" }
  );
  if (writeErr) {
    console.warn("[quotas] addChatMinutes write failed:", writeErr.message);
  }
}

/**
 * Pre-check + bump tool-calls. Used by /chat to gate calls that would
 * push a user past the daily 25 tool-call cap before the LLM runs.
 */
export async function checkToolCallLimit(
  userId: string,
  pendingToolUses: number
): Promise<{ allowed: true } | { allowed: false; used: number; limit: number; resetAt: number }> {
  if (!isQuotaSchemaReady() || pendingToolUses <= 0) return { allowed: true };
  const sb = getSupabase();
  if (!sb) return { allowed: true };
  const day = utcDay();
  const { data } = await sb
    .from("user_quotas")
    .select("tool_calls")
    .eq("user_id", userId)
    .eq("day", day)
    .maybeSingle();
  const used = (data?.tool_calls as number | undefined) ?? 0;
  if (used >= USER_FACING_LIMITS.tool_calls) {
    return {
      allowed: false,
      used,
      limit: USER_FACING_LIMITS.tool_calls,
      resetAt: nextResetMs(),
    };
  }
  return { allowed: true };
}

/**
 * Pre-check voice minutes against the cap. Used by /tts and /stt to
 * gate calls that would push past the 20-minute daily ceiling before
 * the audio is generated/transcribed.
 */
export async function checkVoiceMinutesLimit(
  userId: string
): Promise<{ allowed: true } | { allowed: false; used: number; limit: number; resetAt: number }> {
  if (!isQuotaSchemaReady()) return { allowed: true };
  const sb = getSupabase();
  if (!sb) return { allowed: true };
  const day = utcDay();
  const { data } = await sb
    .from("user_quotas")
    .select("voice_minutes")
    .eq("user_id", userId)
    .eq("day", day)
    .maybeSingle();
  const used = (data?.voice_minutes as number | undefined) ?? 0;
  if (used >= USER_FACING_LIMITS.voice_minutes) {
    return {
      allowed: false,
      used,
      limit: USER_FACING_LIMITS.voice_minutes,
      resetAt: nextResetMs(),
    };
  }
  return { allowed: true };
}
