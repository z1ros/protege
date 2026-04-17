# Database Connection Plan — Make Everything Real

## Current state (honest)

| Feature | Data source | Real? |
|---|---|---|
| Code IQ number | Computed from local JSON | ✓ Real but local-only |
| Five pillars | Computed on every /me call | ✓ Real but not persisted |
| Engineering level | Computed on every /me call | ✓ Real but not persisted |
| Skill detection (60+ concepts) | AST + regex + AI, saved to local JSON | ✓ Real but local-only |
| 1,395 skill taxonomy | Bundled JSON file | ✓ Real but static |
| Trajectory chart | 3 years of MOCK sigmoid data | ✗ FAKE |
| Percentile rank | Hardcoded | ✗ FAKE |
| Mistakes card | Hardcoded mock | ✗ FAKE |
| Radar chart | Hardcoded mock | ✗ FAKE |
| Today card | Hardcoded mock | ✗ FAKE |
| Focus card | Hardcoded mock | ✗ FAKE |
| Mode cards | Hardcoded mock | ✗ FAKE |
| Streak | Real from local save days | ✓ Real but local-only |
| Milestones | Real, checked on every save | ✓ Real but local-only |
| Synergies | Real, computed from concepts | ✓ Real |
| Velocity | Real from velocity log | ✓ Real but local-only |
| Profile name | Real (from GitHub auth) | ✓ Real |
| Member since | Hardcoded "Apr 2026" | ✗ FAKE |
| Chat history | In-memory (lost on reload) | ✗ Not persisted |
| Memories | Local JSON | ✓ Real but local-only |

**Bottom line: 11 real features trapped in local JSON, 8 fake dashboard widgets, 1 unpersisted feature.**

---

## What goes into the database (15 prompts)

### Prompt 1: Set up Supabase project + run schema

> **User action required.** Create a Supabase project and run the schema SQL.
> Then add `SUPABASE_URL` and `SUPABASE_ANON_KEY` to `apps/backend/.env`.
>
> After this, every prompt below can execute against real cloud storage.

---

### Prompt 2: User identity — real profile from GitHub + Supabase

> When user signs in via GitHub:
> 1. `ensureCloudUser()` creates/updates the `users` row
> 2. `users.created_at` becomes the REAL "member since" date
> 3. Profile page reads from DB, not hardcoded "Apr 2026"
> 4. GitHub avatar + login persist across sessions
>
> On every API call, the backend resolves the user from the auth header:
> - Has `Authorization: Bearer <github_token>` → look up by GitHub ID
> - Has `x-user-id: <uuid>` → legacy local-only fallback
>
> Files: `routes/me.ts`, `store.ts`, `ProfilePage.tsx`

---

### Prompt 3: Concepts → Supabase (the core data)

> Every `recordConcepts()` call writes to BOTH local JSON AND Supabase.
> Already wired (fire-and-forget). But needs:
> 1. Dedup: if Supabase already has the concept, UPDATE don't INSERT
> 2. Context scores: `best_context_score` column tracks peak sophistication
> 3. Read path: `/me` should read from Supabase FIRST, fall back to local
> 4. Conflict resolution: if local has data that Supabase doesn't (offline period), sync on reconnect
>
> Files: `store.ts`, `supabase.ts`

---

### Prompt 4: Code IQ + Pillars → Supabase

> After every `computeSnapshot()`, write the composite IQ + 5 pillar scores to `users`:
> ```sql
> ALTER TABLE users ADD COLUMN code_iq INT DEFAULT 0;
> ALTER TABLE users ADD COLUMN pillar_depth INT DEFAULT 0;
> ALTER TABLE users ADD COLUMN pillar_breadth INT DEFAULT 0;
> ALTER TABLE users ADD COLUMN pillar_velocity INT DEFAULT 0;
> ALTER TABLE users ADD COLUMN pillar_consistency INT DEFAULT 0;
> ALTER TABLE users ADD COLUMN pillar_quality INT DEFAULT 0;
> ALTER TABLE users ADD COLUMN level TEXT DEFAULT 'novice';
> ```
>
> This enables:
> - Leaderboard sorted by Code IQ
> - Percentile computed from real data (SELECT COUNT(*) WHERE code_iq < $1)
> - Public profile API returning real IQ
>
> Files: `supabase.ts`, `store.ts`

---

### Prompt 5: Kill the trajectory mock — use real daily IQ snapshots

> The trajectory chart currently shows 3 years of fake sigmoid data.
> Replace with the REAL `daily_iq` array from the user's store.
>
> The data is already collected (dailyIq entries on every save).
> The chart just needs to read from it instead of `generateDailyTrajectory()`.
>
> For new users with <7 days of data: show what we have + a message
> "Keep coding to fill this chart. Each day adds a data point."
>
> Files: `ConceptsDashboard.tsx` (TrajectoryCard), remove `generateDailyTrajectory()`

---

### Prompt 6: Kill the Today card mock — use real gain events

> The Today card shows hardcoded `useTransition +18, Optimistic updates +22`.
> Replace with REAL `recentGains` filtered to today's date.
>
> The data exists: `MeResponse.recentGains` has the last 12 gain events
> with timestamps. Filter to `today` and display.
>
> If no gains today: "No concepts earned today. Save a file to start."
>
> Files: `ConceptsDashboard.tsx` (TodayCard)

---

### Prompt 7: Kill the Mistakes card mock — use real quality data

> The Mistakes card shows hardcoded "Bugs: 12→1, Edge cases: 8→2".
> Replace with REAL data from the Quality pillar:
> - `cleanSaveRate` → "X% of your saves are clean"
> - `fixRate` → "You fix Y% of issues"
> - `recurringBugCount` → "Z recurring patterns"
>
> Pull from `MeResponse.pillars.quality.explanation` which already
> contains this data as a string. Parse it or pass structured data.
>
> Files: `ConceptsDashboard.tsx` (MistakesCard)

---

### Prompt 8: Kill the Radar chart mock — use real pillar data

> The radar chart shows hardcoded [Focus 0.82, Depth 0.58, Breadth 0.74, etc].
> Replace with the REAL five pillars:
> - Depth: `pillars.depth.score / pillars.depth.max`
> - Breadth: same
> - Velocity: same
> - Consistency: same
> - Quality: same
>
> Pentagon with 5 axes. Each axis 0..1 (score/max). Real data.
>
> Files: `ConceptsDashboard.tsx` (RadarCard)

---

### Prompt 9: Kill the Percentile mock — use real Supabase query

> The percentile card shows hardcoded "Top 18%, IQ 487, Peer avg 312".
> Replace with a REAL query:
> ```sql
> SELECT COUNT(*) as total FROM users;
> SELECT COUNT(*) as below FROM users WHERE code_iq < $1;
> percentile = (total - below) / total * 100
> ```
>
> Add to `/me` response: `percentile: number, peerAvgIq: number`
>
> For single-user (no Supabase): show "Sign in to see your ranking"
>
> Files: `supabase.ts` (getUserPercentile), `store.ts`, `me.ts`, `ConceptsDashboard.tsx`

---

### Prompt 10: Kill the Focus card mock — use real recommendations

> The Focus card shows hardcoded "State Mgmt, 58%".
> Replace with the REAL top recommendation from `MeResponse.recommendations[0]`:
> - Concept name
> - Cluster it belongs to
> - Why it was recommended
>
> Files: `ConceptsDashboard.tsx` (FocusCard)

---

### Prompt 11: Chat history persistence

> Chat messages are currently in webview React state — lost on reload.
> Save to Supabase `chats` table:
> - On every `chat/append`, write to DB
> - On webview `ready`, load last 50 messages from DB
> - Broadcast as `chat/history` message to webview
>
> This gives continuity: close the panel, reopen, your conversation is there.
>
> Files: `webviewHost.ts`, `supabase.ts`, `App.tsx` (new chat/history handler)

---

### Prompt 12: Memories → Supabase

> Mentor memories (profile facts, struggles, wins, decisions, preferences)
> are stored in local JSON. Move to Supabase `memories` table:
> - `addMemory()` writes to both local + cloud
> - `getMemorySnapshot()` reads from cloud first, falls back to local
> - `removeMemory()` deletes from both
>
> This means switching devices keeps your mentor's knowledge about you.
>
> Files: `store.ts` (memory functions), `supabase.ts`

---

### Prompt 13: Streak + Milestones → Supabase

> Already partially wired via `syncUserStats()`.
> Ensure:
> - `save_days` array persists to cloud (enables cross-device streak)
> - `unlocked_milestones` persists (achievements don't reset on new machine)
> - `longest_streak` persists
>
> Files: `supabase.ts` (already has syncUserStats)

---

### Prompt 14: Offline queue + sync indicator

> When Supabase is unreachable (no internet, server down):
> 1. Queue all writes in `globalState.pendingSync: ConceptEvent[]`
> 2. On next successful API call, flush the queue
> 3. Show a subtle "offline" indicator in the header (cloud icon with ✗)
> 4. Show "synced" checkmark when queue is empty
>
> Never block the user. Offline coding still works perfectly.
>
> Files: `store.ts`, `App.tsx` (sync indicator)

---

### Prompt 15: Skill taxonomy in database (optional, for admin)

> The 1,395 skills are currently a bundled JSON file.
> Optionally mirror to a `skills` table in Supabase:
> ```sql
> CREATE TABLE skills (
>   id TEXT PRIMARY KEY,
>   name TEXT NOT NULL,
>   domain TEXT NOT NULL,
>   topic TEXT NOT NULL,
>   difficulty INT NOT NULL,
>   pattern TEXT,
>   created_at TIMESTAMPTZ DEFAULT now()
> );
> ```
>
> This enables:
> - Admin dashboard to add/edit skills without extension release
> - Per-user skill discovery tracking (which of the 1,395 have they SEEN in code)
> - Community-contributed skill detection patterns
>
> NOT required for MVP — the bundled JSON works fine.
>
> Files: new migration script, `supabase.ts`

---

## Execution order

```
You do first:
  → Create Supabase project
  → Run schema SQL
  → Add env vars to .env
  → Tell me the URL + key

Then I execute:
  Prompt 2  (10 min) — Real user identity
  Prompt 3  (15 min) — Concepts to cloud
  Prompt 4  (10 min) — IQ + pillars to cloud
  Prompt 5  (15 min) — Kill trajectory mock → real data
  Prompt 6  (10 min) — Kill Today card mock → real data
  Prompt 7  (10 min) — Kill Mistakes mock → real quality data
  Prompt 8  (10 min) — Kill Radar mock → real pillar data
  Prompt 9  (15 min) — Kill Percentile mock → real Supabase query
  Prompt 10 (5 min)  — Kill Focus mock → real recommendations
  Prompt 11 (20 min) — Chat persistence
  Prompt 12 (10 min) — Memories to cloud
  Prompt 13 (5 min)  — Streak + milestones verified
  Prompt 14 (20 min) — Offline queue + sync indicator
  
Total: ~2.5 hours to go from "60% theater" to "100% real"
```

## What you need to do RIGHT NOW

1. Go to [supabase.com](https://supabase.com) → New Project
2. Copy the SQL from `Architecture/supabase-schema.sql` → paste in SQL Editor → Run
3. Go to Auth → Providers → GitHub → Enable (needs a GitHub OAuth App)
4. Copy the project URL + anon key
5. Add to `apps/backend/.env`:
   ```
   SUPABASE_URL=https://your-project.supabase.co
   SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
   ```
6. Tell me "done" and I'll execute Prompts 2-14 in sequence
