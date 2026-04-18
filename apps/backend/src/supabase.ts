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

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient | null {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    console.log("[protege] Supabase connected:", SUPABASE_URL);
  }
  return client;
}

export function isSupabaseEnabled(): boolean {
  return !!SUPABASE_URL && !!SUPABASE_ANON_KEY;
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
 * Record concepts to Supabase — upserts each concept row.
 */
export async function recordCloudConcepts(
  userId: string, // Supabase user UUID
  concepts: string[],
  contextScores: Record<string, number>,
  filePath: string,
  hasErrors: boolean
): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;

  const now = new Date().toISOString();

  for (const name of concepts) {
    const ctxScore = contextScores[name] ?? 1.0;

    // Try to update existing
    const { data: existing } = await sb
      .from("concepts")
      .select("id, times_used, distinct_files, quality_flags, best_context_score")
      .eq("user_id", userId)
      .eq("concept_name", name)
      .single();

    if (existing) {
      const distinctFiles: string[] = existing.distinct_files ?? [];
      if (!distinctFiles.includes(filePath)) distinctFiles.push(filePath);

      await sb
        .from("concepts")
        .update({
          times_used: existing.times_used + 1,
          distinct_files: distinctFiles,
          quality_flags: hasErrors
            ? Math.min((existing.quality_flags ?? 0) + 1, 6)
            : existing.quality_flags,
          best_context_score: Math.max(existing.best_context_score ?? 1.0, ctxScore),
          last_used_at: now,
        })
        .eq("id", existing.id);
    } else {
      await sb.from("concepts").insert({
        user_id: userId,
        concept_name: name,
        times_used: 1,
        distinct_files: [filePath],
        quality_flags: hasErrors ? 1 : 0,
        best_context_score: ctxScore,
        first_seen_at: now,
        last_used_at: now,
      });
    }
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
