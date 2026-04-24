import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Supabase client — connects to the cloud database for persistent storage.
 *
 * When SUPABASE_URL and SUPABASE_ANON_KEY are set in .env, all user data
 * (Code IQ, concepts, milestones, streaks, memories) syncs to Postgres.
 *
 * When they're NOT set, the backend falls back to the local JSON store.
 * This lets development work without a Supabase project.
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY ?? "";

let client: SupabaseClient | null = null;

/**
 * Prefer the service-role key when present (backend is trusted; service role
 * bypasses RLS which is required for the v6 Echo dual-write path). Fall back
 * to the anon key so existing deployments keep working.
 *
 * The service key is NEVER logged or returned to the client. Only a short
 * "connected" breadcrumb is emitted, with neither key in it.
 */
export function getSupabase(): SupabaseClient | null {
  if (!SUPABASE_URL) return null;
  const key = SUPABASE_SERVICE_KEY || SUPABASE_ANON_KEY;
  if (!key) return null;
  if (!client) {
    client = createClient(SUPABASE_URL, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    console.log(
      "[protege] Supabase connected:",
      SUPABASE_URL,
      SUPABASE_SERVICE_KEY ? "(service role)" : "(anon)"
    );
  }
  return client;
}

export function isSupabaseEnabled(): boolean {
  return !!SUPABASE_URL && (!!SUPABASE_SERVICE_KEY || !!SUPABASE_ANON_KEY);
}

/* ==========================================================
   Cloud store — mirrors the JSON store API but writes to Supabase.
   Each function has the same signature as store.ts so the routes
   can call either one based on isSupabaseEnabled().
   ========================================================== */

/**
 * Find or create a user by GitHub ID.
 * Called on first auth — creates the row if it doesn't exist.
 */
export async function ensureCloudUser(
  githubId: string,
  login: string,
  email: string | null,
  avatarUrl: string | null
): Promise<string> {
  const sb = getSupabase();
  if (!sb) throw new Error("Supabase not configured");

  // Upsert: create if new, update login/avatar if returning
  const { data, error } = await sb
    .from("users")
    .upsert(
      {
        github_id: githubId,
        login,
        email,
        avatar_url: avatarUrl,
      },
      { onConflict: "github_id" }
    )
    .select("id")
    .single();

  if (error) throw new Error(`ensureCloudUser: ${error.message}`);
  return data.id;
}

/**
 * Optional Rv5/Rv6 sticky-authorship extras attached to a concept row.
 * `hasBeenAuthored`/`firstAuthoredAt` are monotonic true+timestamp; once
 * set, never flipped back. `language` is sticky — only overwritten when
 * the existing column is null. `authorshipRatio` is the latest detection.
 * All four are optional; pre-v6 callers omit them and keep working.
 */
export interface ConceptStateCloudExtras {
  hasBeenAuthored?: boolean;
  firstAuthoredAt?: string | null;
  language?: string | null;
  authorshipRatio?: number | null;
}

/**
 * Record concepts to Supabase — upserts each concept row. Optional
 * `extras` piggyback the sticky Rv5.A columns (`has_been_authored`,
 * `first_authored_at`, `language`, `authorship_ratio`) without
 * breaking pre-v6 callers.
 */
export async function recordCloudConcepts(
  userId: string, // Supabase user UUID
  concepts: string[],
  contextScores: Record<string, number>,
  filePath: string,
  hasErrors: boolean,
  extras: Record<string, ConceptStateCloudExtras> = {}
): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;

  const now = new Date().toISOString();

  for (const name of concepts) {
    const ctxScore = contextScores[name] ?? 1.0;
    const extra = extras[name];

    // Try to update existing
    const { data: existing } = await sb
      .from("concepts")
      .select(
        "id, times_used, distinct_files, quality_flags, best_context_score, has_been_authored, first_authored_at, language"
      )
      .eq("user_id", userId)
      .eq("concept_name", name)
      .single();

    if (existing) {
      const distinctFiles: string[] = existing.distinct_files ?? [];
      if (!distinctFiles.includes(filePath)) distinctFiles.push(filePath);

      const patch: Record<string, unknown> = {
        times_used: existing.times_used + 1,
        distinct_files: distinctFiles,
        quality_flags: hasErrors
          ? Math.min((existing.quality_flags ?? 0) + 1, 6)
          : existing.quality_flags,
        best_context_score: Math.max(existing.best_context_score ?? 1.0, ctxScore),
        last_used_at: now,
      };
      if (extra) {
        // hasBeenAuthored is monotonic — only flip false→true, never true→false.
        if (extra.hasBeenAuthored === true && existing.has_been_authored !== true) {
          patch.has_been_authored = true;
          if (extra.firstAuthoredAt) {
            patch.first_authored_at = extra.firstAuthoredAt;
          } else if (!existing.first_authored_at) {
            patch.first_authored_at = now;
          }
        }
        // language is sticky — only set when the existing value is null.
        if (!existing.language && typeof extra.language === "string" && extra.language.length > 0) {
          patch.language = extra.language;
        }
        if (
          extra.authorshipRatio === null ||
          (typeof extra.authorshipRatio === "number" && Number.isFinite(extra.authorshipRatio))
        ) {
          patch.authorship_ratio = extra.authorshipRatio;
        }
      }

      const { error } = await sb
        .from("concepts")
        .update(patch)
        .eq("id", existing.id)
        .eq("user_id", userId);
      if (error) {
        console.warn("[protege] recordCloudConcepts update failed:", error.message);
      }
    } else {
      const insertRow: Record<string, unknown> = {
        user_id: userId,
        concept_name: name,
        times_used: 1,
        distinct_files: [filePath],
        quality_flags: hasErrors ? 1 : 0,
        best_context_score: ctxScore,
        first_seen_at: now,
        last_used_at: now,
      };
      if (extra) {
        if (extra.hasBeenAuthored === true) {
          insertRow.has_been_authored = true;
          insertRow.first_authored_at = extra.firstAuthoredAt ?? now;
        }
        if (typeof extra.language === "string" && extra.language.length > 0) {
          insertRow.language = extra.language;
        }
        if (
          extra.authorshipRatio === null ||
          (typeof extra.authorshipRatio === "number" && Number.isFinite(extra.authorshipRatio))
        ) {
          insertRow.authorship_ratio = extra.authorshipRatio;
        }
      }
      const { error } = await sb.from("concepts").insert(insertRow);
      if (error) {
        console.warn("[protege] recordCloudConcepts insert failed:", error.message);
      }
    }
  }
}

/**
 * v6 Rv6.B targeted extras patch — updates only the Rv5 sticky columns on a
 * `concepts` row. Unlike `recordCloudConcepts`, this does NOT bump
 * `times_used`, `distinct_files`, or `last_used_at`. Used by the shadow-write
 * hooks for `setConceptAuthorshipRatio`, `setConceptAuthoredFlag`, and
 * `setConceptLanguage` so they don't double-count usage every time the
 * authorship signal changes.
 *
 * Stickiness:
 *   - `hasBeenAuthored` is monotonic (false → true only).
 *   - `firstAuthoredAt` stays at its original value once set.
 *   - `language` only writes when the existing column is null.
 *   - `authorshipRatio` always overwrites (latest detection wins).
 *
 * No-op when the concept row doesn't exist yet — caller should create via
 * `recordCloudConcepts` first (the /concept-used path already does).
 */
export async function cloudPatchConceptExtras(
  userId: string,
  conceptName: string,
  extras: ConceptStateCloudExtras
): Promise<void> {
  if (!isSupabaseEnabled()) return;
  const sb = getSupabase();
  if (!sb) return;

  const { data: existing, error: readErr } = await sb
    .from("concepts")
    .select("id, has_been_authored, first_authored_at, language")
    .eq("user_id", userId)
    .eq("concept_name", conceptName)
    .maybeSingle();
  if (readErr) {
    console.warn("[protege] cloudPatchConceptExtras read failed:", readErr.message);
    return;
  }
  if (!existing) return;

  const patch: Record<string, unknown> = {};
  const now = new Date().toISOString();

  if (extras.hasBeenAuthored === true && existing.has_been_authored !== true) {
    patch.has_been_authored = true;
    if (extras.firstAuthoredAt) {
      patch.first_authored_at = extras.firstAuthoredAt;
    } else if (!existing.first_authored_at) {
      patch.first_authored_at = now;
    }
  }

  if (!existing.language && typeof extras.language === "string" && extras.language.length > 0) {
    patch.language = extras.language;
  }

  if (
    extras.authorshipRatio === null ||
    (typeof extras.authorshipRatio === "number" && Number.isFinite(extras.authorshipRatio))
  ) {
    patch.authorship_ratio = extras.authorshipRatio;
  }

  if (Object.keys(patch).length === 0) return;

  const { error } = await sb
    .from("concepts")
    .update(patch)
    .eq("id", existing.id)
    .eq("user_id", userId);
  if (error) {
    console.warn("[protege] cloudPatchConceptExtras update failed:", error.message);
  }
}

/**
 * Sync user-level stats to Supabase (IQ, pillars, streak, milestones, etc.)
 * Called after every recordConcepts to keep the cloud in sync.
 */
export async function syncUserStats(
  userId: string, // Supabase user UUID
  stats: {
    codeIq: number;
    longestStreak: number;
    saveDays: string[];
    dailyIq: unknown[];
    velocityLog: unknown[];
    pillarSnapshots: unknown[];
    unlockedMilestones: string[];
    unlockedMilestoneAt: Record<string, string>;
  }
): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;

  await sb
    .from("users")
    .update({
      longest_streak: stats.longestStreak,
      save_days: stats.saveDays,
      daily_iq: stats.dailyIq,
      velocity_log: stats.velocityLog,
      pillar_snapshots: stats.pillarSnapshots,
      unlocked_milestones: stats.unlockedMilestones,
      unlocked_milestone_at: stats.unlockedMilestoneAt,
    })
    .eq("id", userId);
}

/**
 * Record a gain event to Supabase.
 */
export async function recordCloudGain(
  userId: string,
  gain: {
    concept: string;
    cluster: string;
    deltaIq: number;
    file: string;
    kind: string;
  }
): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;

  await sb.from("gains").insert({
    user_id: userId,
    concept: gain.concept,
    cluster: gain.cluster,
    delta_iq: gain.deltaIq,
    file: gain.file,
    kind: gain.kind,
  });
}

/**
 * Fetch the cross-device preferences blob for a user. Returns an empty
 * object if the user has none (or if Supabase isn't configured).
 */
export async function getCloudPreferences(
  userId: string
): Promise<Record<string, unknown>> {
  const sb = getSupabase();
  if (!sb) return {};

  const { data, error } = await sb
    .from("users")
    .select("preferences")
    .eq("id", userId)
    .single();

  if (error || !data) return {};
  const prefs = (data as { preferences?: Record<string, unknown> }).preferences;
  return prefs && typeof prefs === "object" ? prefs : {};
}

/**
 * Merge a partial preferences patch into the user's preferences column.
 * Overwrites the keys present in `patch`; leaves others intact.
 */
export async function saveCloudPreferences(
  userId: string,
  patch: Record<string, unknown>
): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;

  const current = await getCloudPreferences(userId);
  const merged = { ...current, ...patch };

  const { error } = await sb
    .from("users")
    .update({ preferences: merged })
    .eq("id", userId);

  if (error) {
    console.warn("[protege] saveCloudPreferences failed:", error.message);
  }
}

/**
 * Get leaderboard data — top users by concept count.
 * Anonymized: only shows login + avatar + stats.
 */
export async function getLeaderboard(
  limit = 20
): Promise<Array<{
  login: string;
  avatarUrl: string | null;
  totalConcepts: number;
  longestStreak: number;
}>> {
  const sb = getSupabase();
  if (!sb) return [];

  const { data, error } = await sb
    .from("leaderboard")
    .select("login, avatar_url, total_concepts, longest_streak")
    .limit(limit);

  if (error || !data) return [];

  return data.map((row) => ({
    login: row.login,
    avatarUrl: row.avatar_url,
    totalConcepts: Number(row.total_concepts),
    longestStreak: Number(row.longest_streak),
  }));
}

/**
 * Get user's percentile rank among all users.
 */
export async function getUserPercentile(
  userId: string
): Promise<{ rank: number; total: number; percentile: number }> {
  const sb = getSupabase();
  if (!sb) return { rank: 0, total: 0, percentile: 0 };

  // Count total users
  const { count: total } = await sb
    .from("users")
    .select("id", { count: "exact", head: true });

  // Count users with fewer concepts than this user
  const { data: userConcepts } = await sb
    .from("concepts")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);

  const myCount = (userConcepts as any)?.length ?? 0;

  // Simple percentile: how many users have fewer concepts
  const { count: below } = await sb
    .rpc("count_users_with_fewer_concepts", { target_count: myCount });

  const totalUsers = total ?? 1;
  const rank = totalUsers - (below ?? 0);
  const percentile = totalUsers > 1
    ? Math.round(((totalUsers - rank) / (totalUsers - 1)) * 100)
    : 100;

  return { rank, total: totalUsers, percentile };
}

/* ==========================================================
   v6 — Echo durability layer
   ----------------------------------------------------------
   Cloud helpers for every Echo-era table. These mirror the
   local store.ts helpers row-for-row so Rv6.B can wire them
   in as shadow-writes next to the existing mutations.

   Rules for every helper below:
     - `!isSupabaseEnabled()` → silent no-op (matches the
       existing preferences pattern).
     - Every query uses `.eq('user_id', userId)` — no exception.
     - Errors are console.warn'd, never thrown. The local store
       stays authoritative if Supabase is down.
     - Bulk inserts use `insert([rows])` in chunks of ≤ 500 rows.
     - Upserts use `onConflict` with the composite PK.
     - No service-key values ever appear in logs.

   Columns on the wire are snake_case (Postgres); types exposed
   to TS callers are camelCase.
   ========================================================== */

const SUPABASE_MAX_BATCH = 500;

/**
 * Chunk an arbitrary array into ≤ SUPABASE_MAX_BATCH slices. Helper for
 * bulk inserts so we never send a mega-payload to PostgREST.
 */
function chunkForSupabase<T>(rows: T[], size: number = SUPABASE_MAX_BATCH): T[][] {
  if (rows.length <= size) return [rows];
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/* ---------- echo_events ---------- */

export interface EchoEventCloudInput {
  type: string;
  ts: number;
  file?: string;
  payload: Record<string, unknown>;
}

export interface EchoEventCloudRow {
  type: string;
  ts: number;
  file: string | null;
  payload: Record<string, unknown>;
}

export async function cloudAppendEchoEvents(
  userId: string,
  events: EchoEventCloudInput[]
): Promise<void> {
  if (!isSupabaseEnabled()) return;
  if (events.length === 0) return;
  const sb = getSupabase();
  if (!sb) return;

  const rows = events.map((e) => ({
    user_id: userId,
    event_type: e.type,
    ts: e.ts,
    file: e.file ?? null,
    payload: e.payload ?? {},
  }));

  for (const chunk of chunkForSupabase(rows)) {
    const { error } = await sb.from("echo_events").insert(chunk);
    if (error) {
      console.warn("[protege] cloudAppendEchoEvents failed:", error.message);
      return;
    }
  }
}

export async function cloudReadEchoEvents(
  userId: string,
  sinceMs: number,
  untilMs?: number
): Promise<EchoEventCloudRow[]> {
  if (!isSupabaseEnabled()) return [];
  const sb = getSupabase();
  if (!sb) return [];

  let query = sb
    .from("echo_events")
    .select("event_type, ts, file, payload")
    .eq("user_id", userId)
    .gte("ts", sinceMs)
    .order("ts", { ascending: true });
  if (typeof untilMs === "number") query = query.lte("ts", untilMs);

  const { data, error } = await query;
  if (error || !data) {
    if (error) console.warn("[protege] cloudReadEchoEvents failed:", error.message);
    return [];
  }

  return data.map((r) => {
    const row = r as {
      event_type: string;
      ts: number;
      file: string | null;
      payload: Record<string, unknown> | null;
    };
    return {
      type: row.event_type,
      ts: Number(row.ts),
      file: row.file ?? null,
      payload: row.payload ?? {},
    };
  });
}

/* ---------- behavior_daily_rollups ---------- */

export interface BehaviorRollupCloudRow {
  userId: string;
  date: string;
  activeMinutes: number;
  totalMinutes: number;
  sessionsCount: number;
  sessionMinutes: number;
  hourHistogram: number[];
  linesAdded: number;
  linesRemoved: number;
  linesNet: number;
  filesTouched: string[];
  fileHops: number;
  archetypeHint: string | null;
}

export async function cloudUpsertBehaviorRollup(
  row: BehaviorRollupCloudRow
): Promise<void> {
  if (!isSupabaseEnabled()) return;
  const sb = getSupabase();
  if (!sb) return;

  const payload = {
    user_id: row.userId,
    date: row.date,
    active_minutes: row.activeMinutes,
    total_minutes: row.totalMinutes,
    sessions_count: row.sessionsCount,
    session_minutes: row.sessionMinutes,
    hour_histogram: row.hourHistogram,
    lines_added: row.linesAdded,
    lines_removed: row.linesRemoved,
    lines_net: row.linesNet,
    files_touched: row.filesTouched,
    file_hops: row.fileHops,
    archetype_hint: row.archetypeHint,
    updated_at: new Date().toISOString(),
  };

  const { error } = await sb
    .from("behavior_daily_rollups")
    .upsert(payload, { onConflict: "user_id,date" });
  if (error) {
    console.warn("[protege] cloudUpsertBehaviorRollup failed:", error.message);
  }
}

export async function cloudReadBehaviorRollups(
  userId: string,
  startDate: string,
  endDate: string
): Promise<BehaviorRollupCloudRow[]> {
  if (!isSupabaseEnabled()) return [];
  const sb = getSupabase();
  if (!sb) return [];

  const { data, error } = await sb
    .from("behavior_daily_rollups")
    .select(
      "user_id, date, active_minutes, total_minutes, sessions_count, session_minutes, hour_histogram, lines_added, lines_removed, lines_net, files_touched, file_hops, archetype_hint"
    )
    .eq("user_id", userId)
    .gte("date", startDate)
    .lte("date", endDate)
    .order("date", { ascending: true });

  if (error || !data) {
    if (error) console.warn("[protege] cloudReadBehaviorRollups failed:", error.message);
    return [];
  }

  return data.map((r) => {
    const row = r as {
      user_id: string;
      date: string;
      active_minutes: number | null;
      total_minutes: number | null;
      sessions_count: number | null;
      session_minutes: number | null;
      hour_histogram: number[] | null;
      lines_added: number | null;
      lines_removed: number | null;
      lines_net: number | null;
      files_touched: string[] | null;
      file_hops: number | null;
      archetype_hint: string | null;
    };
    const hist = Array.isArray(row.hour_histogram) && row.hour_histogram.length === 24
      ? row.hour_histogram
      : new Array(24).fill(0);
    return {
      userId: row.user_id,
      date: row.date,
      activeMinutes: row.active_minutes ?? 0,
      totalMinutes: row.total_minutes ?? 0,
      sessionsCount: row.sessions_count ?? 0,
      sessionMinutes: row.session_minutes ?? 0,
      hourHistogram: hist,
      linesAdded: row.lines_added ?? 0,
      linesRemoved: row.lines_removed ?? 0,
      linesNet: row.lines_net ?? 0,
      filesTouched: Array.isArray(row.files_touched) ? row.files_touched : [],
      fileHops: row.file_hops ?? 0,
      archetypeHint: row.archetype_hint ?? null,
    };
  });
}

/* ---------- concept_statuses ---------- */

export type ConceptStatusValue = "unset" | "known" | "not_known";

export interface ConceptStatusCloudRow {
  concept: string;
  status: ConceptStatusValue;
  updatedAt: string;
}

export async function cloudSetConceptStatus(
  userId: string,
  concept: string,
  status: ConceptStatusValue
): Promise<void> {
  if (!isSupabaseEnabled()) return;
  const sb = getSupabase();
  if (!sb) return;

  const { error } = await sb
    .from("concept_statuses")
    .upsert(
      {
        user_id: userId,
        concept,
        status,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,concept" }
    );
  if (error) {
    console.warn("[protege] cloudSetConceptStatus failed:", error.message);
  }
}

export async function cloudReadConceptStatuses(
  userId: string
): Promise<ConceptStatusCloudRow[]> {
  if (!isSupabaseEnabled()) return [];
  const sb = getSupabase();
  if (!sb) return [];

  const { data, error } = await sb
    .from("concept_statuses")
    .select("concept, status, updated_at")
    .eq("user_id", userId);

  if (error || !data) {
    if (error) console.warn("[protege] cloudReadConceptStatuses failed:", error.message);
    return [];
  }

  return data.map((r) => {
    const row = r as {
      concept: string;
      status: ConceptStatusValue;
      updated_at: string;
    };
    return {
      concept: row.concept,
      status: row.status,
      updatedAt: row.updated_at,
    };
  });
}

/* ---------- concept_encounters ---------- */

export interface ConceptEncounterCloudRow {
  userId: string;
  concept: string;
  filePath: string;
  language: string | null;
  seenAt: string;
  authorshipRatioAtTime: number | null;
}

export async function cloudAppendConceptEncounter(
  row: ConceptEncounterCloudRow
): Promise<void> {
  if (!isSupabaseEnabled()) return;
  const sb = getSupabase();
  if (!sb) return;

  const { error } = await sb.from("concept_encounters").insert({
    user_id: row.userId,
    concept: row.concept,
    file_path: row.filePath,
    language: row.language,
    seen_at: row.seenAt,
    authorship_ratio_at_time: row.authorshipRatioAtTime,
  });
  if (error) {
    console.warn("[protege] cloudAppendConceptEncounter failed:", error.message);
  }
}

export async function cloudReadConceptEncounters(
  userId: string,
  sinceMs: number,
  untilMs?: number
): Promise<ConceptEncounterCloudRow[]> {
  if (!isSupabaseEnabled()) return [];
  const sb = getSupabase();
  if (!sb) return [];

  const sinceIso = new Date(sinceMs).toISOString();
  let query = sb
    .from("concept_encounters")
    .select(
      "user_id, concept, file_path, language, seen_at, authorship_ratio_at_time"
    )
    .eq("user_id", userId)
    .gte("seen_at", sinceIso)
    .order("seen_at", { ascending: true });
  if (typeof untilMs === "number") {
    query = query.lte("seen_at", new Date(untilMs).toISOString());
  }

  const { data, error } = await query;
  if (error || !data) {
    if (error) console.warn("[protege] cloudReadConceptEncounters failed:", error.message);
    return [];
  }

  return data.map((r) => {
    const row = r as {
      user_id: string;
      concept: string;
      file_path: string;
      language: string | null;
      seen_at: string;
      authorship_ratio_at_time: number | null;
    };
    return {
      userId: row.user_id,
      concept: row.concept,
      filePath: row.file_path,
      language: row.language ?? null,
      seenAt: row.seen_at,
      authorshipRatioAtTime:
        typeof row.authorship_ratio_at_time === "number"
          ? row.authorship_ratio_at_time
          : null,
    };
  });
}

/* ---------- file_authorship_counters ---------- */

export interface FileAuthorshipCloudRow {
  userId: string;
  filePath: string;
  humanChars: number;
  aiChars: number;
  updatedAt: string;
}

/**
 * Atomic bump: read-then-upsert the per-file counters so both sides'
 * deltas add into the existing totals. Deltas may be negative input
 * from the caller but are clamped to ≥ 0 before writing so the cloud
 * row never goes below zero.
 */
export async function cloudBumpFileAuthorship(
  userId: string,
  filePath: string,
  humanDelta: number,
  aiDelta: number
): Promise<void> {
  if (!isSupabaseEnabled()) return;
  if (!filePath) return;
  const h = Math.max(0, Number.isFinite(humanDelta) ? humanDelta : 0);
  const a = Math.max(0, Number.isFinite(aiDelta) ? aiDelta : 0);
  if (h === 0 && a === 0) return;

  const sb = getSupabase();
  if (!sb) return;

  const { data: existing, error: readErr } = await sb
    .from("file_authorship_counters")
    .select("human_chars, ai_chars")
    .eq("user_id", userId)
    .eq("file_path", filePath)
    .maybeSingle();
  if (readErr) {
    console.warn("[protege] cloudBumpFileAuthorship read failed:", readErr.message);
    return;
  }

  const prevHuman = existing?.human_chars ?? 0;
  const prevAi = existing?.ai_chars ?? 0;

  const { error } = await sb
    .from("file_authorship_counters")
    .upsert(
      {
        user_id: userId,
        file_path: filePath,
        human_chars: prevHuman + h,
        ai_chars: prevAi + a,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,file_path" }
    );
  if (error) {
    console.warn("[protege] cloudBumpFileAuthorship upsert failed:", error.message);
  }
}

export async function cloudReadFileAuthorshipRows(
  userId: string
): Promise<FileAuthorshipCloudRow[]> {
  if (!isSupabaseEnabled()) return [];
  const sb = getSupabase();
  if (!sb) return [];

  const { data, error } = await sb
    .from("file_authorship_counters")
    .select("user_id, file_path, human_chars, ai_chars, updated_at")
    .eq("user_id", userId);

  if (error || !data) {
    if (error) console.warn("[protege] cloudReadFileAuthorshipRows failed:", error.message);
    return [];
  }

  return data.map((r) => {
    const row = r as {
      user_id: string;
      file_path: string;
      human_chars: number | null;
      ai_chars: number | null;
      updated_at: string;
    };
    return {
      userId: row.user_id,
      filePath: row.file_path,
      humanChars: row.human_chars ?? 0,
      aiChars: row.ai_chars ?? 0,
      updatedAt: row.updated_at,
    };
  });
}

/* ---------- line_rewrite_counters ---------- */

export interface LineRewriteCloudRow {
  userId: string;
  filePath: string;
  lineFingerprint: string;
  rewriteCount: number;
  lastContent: string;
  lastRewriteAt: string;
}

/**
 * Bump per-line rewrite counters. Each touch increments the matching
 * (user_id, file_path, line_fingerprint) row by 1 and stamps the latest
 * sample content + timestamp. Reads the current counts once per batch so
 * chunked upserts add on top of any existing values.
 */
export async function cloudUpsertLineRewriteCounters(
  userId: string,
  filePath: string,
  touches: Array<{ fingerprint: string; sampleContent: string; ts: number }>
): Promise<void> {
  if (!isSupabaseEnabled()) return;
  if (!filePath) return;
  if (touches.length === 0) return;

  const sb = getSupabase();
  if (!sb) return;

  const fingerprints = Array.from(new Set(touches.map((t) => t.fingerprint)));
  const { data: existing, error: readErr } = await sb
    .from("line_rewrite_counters")
    .select("line_fingerprint, rewrite_count")
    .eq("user_id", userId)
    .eq("file_path", filePath)
    .in("line_fingerprint", fingerprints);
  if (readErr) {
    console.warn("[protege] cloudUpsertLineRewriteCounters read failed:", readErr.message);
    return;
  }

  const prev = new Map<string, number>();
  for (const r of existing ?? []) {
    const row = r as { line_fingerprint: string; rewrite_count: number | null };
    prev.set(row.line_fingerprint, row.rewrite_count ?? 0);
  }

  // Collapse touches — if the same fingerprint appears twice in the batch,
  // keep the largest ts and its sampleContent.
  const merged = new Map<
    string,
    { fingerprint: string; sampleContent: string; ts: number; count: number }
  >();
  for (const t of touches) {
    const cur = merged.get(t.fingerprint);
    if (cur) {
      cur.count += 1;
      if (t.ts >= cur.ts) {
        cur.ts = t.ts;
        cur.sampleContent = t.sampleContent;
      }
    } else {
      merged.set(t.fingerprint, { ...t, count: 1 });
    }
  }

  const rows = Array.from(merged.values()).map((t) => ({
    user_id: userId,
    file_path: filePath,
    line_fingerprint: t.fingerprint,
    rewrite_count: (prev.get(t.fingerprint) ?? 0) + t.count,
    last_content: t.sampleContent,
    last_rewrite_at: new Date(t.ts).toISOString(),
    updated_at: new Date().toISOString(),
  }));

  for (const chunk of chunkForSupabase(rows)) {
    const { error } = await sb
      .from("line_rewrite_counters")
      .upsert(chunk, { onConflict: "user_id,file_path,line_fingerprint" });
    if (error) {
      console.warn("[protege] cloudUpsertLineRewriteCounters upsert failed:", error.message);
      return;
    }
  }
}

export async function cloudReadLineRewriteCounters(
  userId: string,
  sinceMs: number
): Promise<LineRewriteCloudRow[]> {
  if (!isSupabaseEnabled()) return [];
  const sb = getSupabase();
  if (!sb) return [];

  const { data, error } = await sb
    .from("line_rewrite_counters")
    .select(
      "user_id, file_path, line_fingerprint, rewrite_count, last_content, last_rewrite_at"
    )
    .eq("user_id", userId)
    .gte("last_rewrite_at", new Date(sinceMs).toISOString())
    .order("last_rewrite_at", { ascending: false });

  if (error || !data) {
    if (error) console.warn("[protege] cloudReadLineRewriteCounters failed:", error.message);
    return [];
  }

  return data.map((r) => {
    const row = r as {
      user_id: string;
      file_path: string;
      line_fingerprint: string;
      rewrite_count: number | null;
      last_content: string | null;
      last_rewrite_at: string;
    };
    return {
      userId: row.user_id,
      filePath: row.file_path,
      lineFingerprint: row.line_fingerprint,
      rewriteCount: row.rewrite_count ?? 0,
      lastContent: row.last_content ?? "",
      lastRewriteAt: row.last_rewrite_at,
    };
  });
}

/* ---------- commit_stories ---------- */

export interface CommitStoryCloudRow {
  userId: string;
  commitSha: string;
  commitTs: string;
  message: string;
  activeMinutes: number;
  undoCount: number;
  pasteCount: number;
  aiAcceptCount: number;
  filesTouched: string[];
  peakFocusMin: number;
}

export async function cloudUpsertCommitStory(
  row: CommitStoryCloudRow
): Promise<void> {
  if (!isSupabaseEnabled()) return;
  const sb = getSupabase();
  if (!sb) return;

  const { error } = await sb.from("commit_stories").upsert(
    {
      user_id: row.userId,
      commit_sha: row.commitSha,
      commit_ts: row.commitTs,
      message: row.message,
      active_minutes: row.activeMinutes,
      undo_count: row.undoCount,
      paste_count: row.pasteCount,
      ai_accept_count: row.aiAcceptCount,
      files_touched: row.filesTouched,
      peak_focus_min: row.peakFocusMin,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,commit_sha" }
  );
  if (error) {
    console.warn("[protege] cloudUpsertCommitStory failed:", error.message);
  }
}

export async function cloudReadCommitStories(
  userId: string,
  startMs: number,
  endMs: number
): Promise<CommitStoryCloudRow[]> {
  if (!isSupabaseEnabled()) return [];
  const sb = getSupabase();
  if (!sb) return [];

  const { data, error } = await sb
    .from("commit_stories")
    .select(
      "user_id, commit_sha, commit_ts, message, active_minutes, undo_count, paste_count, ai_accept_count, files_touched, peak_focus_min"
    )
    .eq("user_id", userId)
    .gte("commit_ts", new Date(startMs).toISOString())
    .lte("commit_ts", new Date(endMs).toISOString())
    .order("commit_ts", { ascending: false });

  if (error || !data) {
    if (error) console.warn("[protege] cloudReadCommitStories failed:", error.message);
    return [];
  }

  return data.map((r) => {
    const row = r as {
      user_id: string;
      commit_sha: string;
      commit_ts: string;
      message: string;
      active_minutes: number | null;
      undo_count: number | null;
      paste_count: number | null;
      ai_accept_count: number | null;
      files_touched: string[] | null;
      peak_focus_min: number | null;
    };
    return {
      userId: row.user_id,
      commitSha: row.commit_sha,
      commitTs: row.commit_ts,
      message: row.message,
      activeMinutes: row.active_minutes ?? 0,
      undoCount: row.undo_count ?? 0,
      pasteCount: row.paste_count ?? 0,
      aiAcceptCount: row.ai_accept_count ?? 0,
      filesTouched: Array.isArray(row.files_touched) ? row.files_touched : [],
      peakFocusMin: row.peak_focus_min ?? 0,
    };
  });
}

/* ---------- repo_concept_index ---------- */

export interface RepoConceptIndexCloudRow {
  userId: string;
  workspaceRoot: string;
  concept: string;
  language: string | null;
  fileCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export async function cloudUpsertRepoConceptIndex(
  row: RepoConceptIndexCloudRow
): Promise<void> {
  if (!isSupabaseEnabled()) return;
  if (!row.userId || !row.workspaceRoot || !row.concept) return;
  const sb = getSupabase();
  if (!sb) return;

  const { error } = await sb.from("repo_concept_index").upsert(
    {
      user_id: row.userId,
      workspace_root: row.workspaceRoot,
      concept: row.concept,
      language: row.language,
      file_count: Math.max(0, row.fileCount),
      first_seen_at: row.firstSeenAt,
      last_seen_at: row.lastSeenAt,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,workspace_root,concept" }
  );
  if (error) {
    console.warn("[protege] cloudUpsertRepoConceptIndex failed:", error.message);
  }
}

export async function cloudReadRepoConceptIndex(
  userId: string,
  workspaceRoot: string
): Promise<RepoConceptIndexCloudRow[]> {
  if (!isSupabaseEnabled()) return [];
  const sb = getSupabase();
  if (!sb) return [];

  const { data, error } = await sb
    .from("repo_concept_index")
    .select(
      "user_id, workspace_root, concept, language, file_count, first_seen_at, last_seen_at"
    )
    .eq("user_id", userId)
    .eq("workspace_root", workspaceRoot);

  if (error || !data) {
    if (error) console.warn("[protege] cloudReadRepoConceptIndex failed:", error.message);
    return [];
  }

  return data.map((r) => {
    const row = r as {
      user_id: string;
      workspace_root: string;
      concept: string;
      language: string | null;
      file_count: number | null;
      first_seen_at: string;
      last_seen_at: string;
    };
    return {
      userId: row.user_id,
      workspaceRoot: row.workspace_root,
      concept: row.concept,
      language: row.language ?? null,
      fileCount: row.file_count ?? 0,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
    };
  });
}
