-- ============================================================
-- Protege Supabase Schema
--
-- Run this in your Supabase SQL Editor after creating a project.
-- Mirrors the JSON store (store.ts) exactly — same field names,
-- same types, just in Postgres with Row-Level Security.
--
-- Setup steps:
-- 1. Create a Supabase project at https://supabase.com
-- 2. Enable GitHub OAuth: Dashboard → Auth → Providers → GitHub
--    (needs a GitHub OAuth App: Settings → Developer → OAuth Apps)
-- 3. Run this SQL in the SQL Editor
-- 4. Copy your project URL + anon key into .env:
--    SUPABASE_URL=https://xxx.supabase.co
--    SUPABASE_ANON_KEY=eyJ...
-- ============================================================

-- Users table — one row per authenticated user
CREATE TABLE IF NOT EXISTS users (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  github_id TEXT UNIQUE NOT NULL,
  login TEXT NOT NULL,
  email TEXT,
  avatar_url TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  longest_streak INT DEFAULT 0,
  save_days TEXT[] DEFAULT '{}',
  daily_iq JSONB DEFAULT '[]',
  velocity_log JSONB DEFAULT '[]',
  pillar_snapshots JSONB DEFAULT '[]',
  unlocked_milestones TEXT[] DEFAULT '{}',
  unlocked_milestone_at JSONB DEFAULT '{}',
  -- cross-device user preferences (ai_backend, feature flags, etc.)
  preferences JSONB DEFAULT '{}'
);

-- Idempotent migration for existing databases that predate the preferences column.
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferences JSONB DEFAULT '{}';

-- Concepts — one row per user × concept
CREATE TABLE IF NOT EXISTS concepts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  concept_name TEXT NOT NULL,
  times_used INT DEFAULT 0,
  distinct_files TEXT[] DEFAULT '{}',
  quality_flags INT DEFAULT 0,
  best_context_score REAL DEFAULT 1.0,
  first_seen_at TIMESTAMPTZ DEFAULT now(),
  last_used_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, concept_name)
);

-- File states — tracks content hashes for dedup + error counts for quality
CREATE TABLE IF NOT EXISTS files (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  last_hash TEXT NOT NULL,
  last_saved_at TIMESTAMPTZ DEFAULT now(),
  last_error_count INT DEFAULT 0,
  UNIQUE(user_id, file_path)
);

-- Gain events — ring buffer of recent IQ changes
CREATE TABLE IF NOT EXISTS gains (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  concept TEXT NOT NULL,
  cluster TEXT NOT NULL,
  delta_iq INT NOT NULL,
  file TEXT,
  kind TEXT DEFAULT 'concept',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Chat messages — conversation history
CREATE TABLE IF NOT EXISTS chats (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Memories — mentor knowledge about the user
CREATE TABLE IF NOT EXISTS memories (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('profile', 'struggle', 'win', 'decision', 'preference', 'context')),
  content TEXT NOT NULL,
  use_count INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  last_used_at TIMESTAMPTZ DEFAULT now()
);

-- Sessions — daily session tracking for continuity
CREATE TABLE IF NOT EXISTS sessions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  started_at TIMESTAMPTZ DEFAULT now(),
  last_active_at TIMESTAMPTZ DEFAULT now(),
  files_touched TEXT[] DEFAULT '{}',
  concepts_used TEXT[] DEFAULT '{}',
  end_summary TEXT,
  UNIQUE(user_id, date)
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_concepts_user ON concepts(user_id);
CREATE INDEX IF NOT EXISTS idx_concepts_user_name ON concepts(user_id, concept_name);
CREATE INDEX IF NOT EXISTS idx_files_user ON files(user_id);
CREATE INDEX IF NOT EXISTS idx_gains_user ON gains(user_id);
CREATE INDEX IF NOT EXISTS idx_gains_created ON gains(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chats_user ON chats(user_id);
CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user_date ON sessions(user_id, date);

-- ============================================================
-- Row-Level Security — each user can only access their own data
-- ============================================================

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE concepts ENABLE ROW LEVEL SECURITY;
ALTER TABLE files ENABLE ROW LEVEL SECURITY;
ALTER TABLE gains ENABLE ROW LEVEL SECURITY;
ALTER TABLE chats ENABLE ROW LEVEL SECURITY;
ALTER TABLE memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;

-- Users: can read/update own row
CREATE POLICY users_self ON users
  FOR ALL USING (id = auth.uid());

-- All other tables: user_id must match auth.uid()
CREATE POLICY concepts_self ON concepts
  FOR ALL USING (user_id = auth.uid());

CREATE POLICY files_self ON files
  FOR ALL USING (user_id = auth.uid());

CREATE POLICY gains_self ON gains
  FOR ALL USING (user_id = auth.uid());

CREATE POLICY chats_self ON chats
  FOR ALL USING (user_id = auth.uid());

CREATE POLICY memories_self ON memories
  FOR ALL USING (user_id = auth.uid());

CREATE POLICY sessions_self ON sessions
  FOR ALL USING (user_id = auth.uid());

-- ============================================================
-- Leaderboard view — anonymous, shows only aggregate stats
-- ============================================================

CREATE OR REPLACE VIEW leaderboard AS
SELECT
  u.login,
  u.avatar_url,
  count(c.id) AS total_concepts,
  coalesce(sum(c.times_used), 0) AS total_uses,
  u.longest_streak,
  u.created_at
FROM users u
LEFT JOIN concepts c ON c.user_id = u.id
GROUP BY u.id, u.login, u.avatar_url, u.longest_streak, u.created_at
ORDER BY total_concepts DESC;

-- Grant read access to the leaderboard for all authenticated users
GRANT SELECT ON leaderboard TO authenticated;
