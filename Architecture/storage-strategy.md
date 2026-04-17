# Storage Strategy: Local + Supabase Hybrid

## The Rule

**Local = fast, private, works offline.**
**Supabase = persistent, cross-device, enables social features.**

Not everything needs to go to the cloud. Here's the split:

## What goes WHERE

### Supabase (cloud) — the stuff that MATTERS long-term

| Data | Why cloud | Table |
|---|---|---|
| **Code IQ score** | Cross-device sync, leaderboards, profile card | `users.code_iq` |
| **Engineering level** | Public profile, peer comparison | `users.level` |
| **Five pillar scores** | Progress tracking across devices | `users.pillars` (JSONB) |
| **Detected concepts + mastery** | The core learning data — can't lose this | `concepts` |
| **Milestones unlocked** | Achievements persist forever | `users.unlocked_milestones` |
| **Streak (current + longest)** | Motivation, leaderboard ranking | `users.streak_current`, `users.longest_streak` |
| **Velocity log** | Weekly learning speed history | `users.velocity_log` (JSONB) |
| **Daily IQ snapshots** | Trajectory chart with real data | `users.daily_iq` (JSONB) |
| **Pillar snapshots** | Daily breakdown deltas | `users.pillar_snapshots` (JSONB) |
| **Synergy data** | Which synergies are active | Computed on read (not stored) |
| **Memories** | Mentor knowledge about the user | `memories` |
| **Session summaries** | "Yesterday you worked on..." | `sessions` |
| **GitHub identity** | Auth + profile | `users.github_id`, `users.login` |

### Local only (extension globalState) — the stuff that's ephemeral or too noisy

| Data | Why local | Where |
|---|---|---|
| **File content hashes** | Changes every save, huge volume, privacy | `globalState` |
| **Raw findings from analyzer** | Ephemeral, regenerated on each save | In-memory only |
| **Chat conversation history** | Private, potentially sensitive code | `globalState` (later: optional cloud sync) |
| **Settings/preferences** | Theme, model, voice — per-machine | `globalState` |
| **Highlight decorations** | Editor state, not data | In-memory only |
| **Context scores per file** | Derived, not source of truth | In-memory only |
| **On-device model cache** | 1GB+ binary, machine-specific | Filesystem |

### Computed on read (not stored anywhere)

| Data | Why computed | Source |
|---|---|---|
| **Synergy pairs + gaps** | Derived from concept clusters | `computeSynergies(domainCounts)` |
| **Level requirements checklist** | Derived from pillars + concepts | `computeLevel(...)` |
| **Recommendations** | Derived from what's missing | `computeSnapshot(...)` |
| **IQ breakdown deltas** | Derived from today vs yesterday snapshot | `computeSnapshot(...)` |
| **Percentile rank** | Computed from all users in `users` table | SQL query |

## Sync Flow

```
User saves a file
  ↓
Extension (local):
  1. Detect concepts (AST + regex + AI) → instant
  2. Check file hash against local cache → skip if unchanged
  3. Record concepts locally (in-memory for this session)
  ↓
Backend API:
  4. POST /concept-used → backend upserts to Supabase
  5. Backend computes new IQ + pillars + level
  6. Returns updated snapshot to extension
  ↓
Extension:
  7. Broadcasts to webview (iq/update with all fields)
  8. Caches the snapshot in globalState (offline fallback)
```

## Offline Mode

When Supabase is unreachable:
1. Extension stores concept events in a local queue (`globalState.pendingSync`)
2. On next successful API call, flush the queue
3. Dashboard shows last-known IQ with a "syncing..." indicator
4. Never block the user — offline coding still detects concepts and shows local IQ

## Migration Path

**Phase 1 (now):** Backend writes to BOTH local JSON AND Supabase.
Read from Supabase first, fall back to local JSON.
This way nothing breaks if Supabase is down.

**Phase 2 (after Supabase is stable):** Remove local JSON entirely.
Backend is purely Supabase-backed.
Extension still caches in globalState for offline.

**Phase 3 (multi-user):** Add leaderboard endpoint,
percentile computation, team features.
All powered by SQL queries against the `users` + `concepts` tables.
