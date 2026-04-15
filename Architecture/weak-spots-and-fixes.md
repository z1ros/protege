# Architecture Weak Spots — Identified & Fixed

## 1. Claude API is a Single Point of Failure

**The problem:** If Anthropic has an outage (and they do), the entire teaching engine dies. No mentor chat, no code analysis, no lessons, no challenges. The product becomes a streak counter with a broken brain.

**The fix: Graceful AI degradation ladder**

```
AI STATUS         WHAT WORKS                          USER SEES
─────────────────────────────────────────────────────────────────
Fully online      Everything                          Normal
─────────────────────────────────────────────────────────────────
High latency      Local analysis instant, AI delayed  "Protege is thinking..."
(> 5s response)   Queue AI requests, batch them       Inline bugs still instant
─────────────────────────────────────────────────────────────────
Partial outage    Local analysis + cached responses   "AI mentor is slow right now.
                  Common bugs have pre-written         Local analysis is active."
                  explanations (no AI needed)          
─────────────────────────────────────────────────────────────────
Full outage       Local-only mode:                    "AI mentor is offline.
                  - AST concept detection              I'm still tracking your
                  - Rule-based bug detection            skills and catching
                  - Streak tracking                    common bugs locally."
                  - Skill tree (cached data)           
                  - Behavioral pattern detection       
─────────────────────────────────────────────────────────────────
```

**Implementation:**
- Pre-cache the top 50 most common bug explanations (missing await, == vs ===, null reference, etc.) — these cover ~40% of all findings
- Store the user's last 100 AI responses locally for reference
- Health check endpoint that pings Claude API every 60s, sets a status flag
- Extension reads the flag and adjusts UI accordingly
- Consider a secondary AI provider (OpenAI, Gemini) as emergency fallback for critical functions only (not ideal for consistency, but better than nothing)

---

## 2. Concept Detection ≠ Understanding Detection

**The problem:** The AST parser can detect "user wrote `useState`" but cannot know if they UNDERSTAND state management. Someone can copy-paste a useState call without knowing what it does. The mastery score would go up when understanding hasn't changed.

**Current gap:** The architecture says "used correctly without AI help (+3)" but how do you know they didn't just copy from Stack Overflow or their own old code?

**The fix: Multi-signal understanding verification**

```
Signal                              What it tells us          Weight
──────────────────────────────────────────────────────────────────────
Typed character by character        Likely from memory          High
  (typing speed consistent, 
  no burst paste)

Used in a NEW context               Transfer ability            Very High
  (different project, different
  file pattern than before)

Correct on first try                 Solid understanding         High
  (no undo/redo, no error,
  no pause)

Modified after paste                 Adapting, not just copying  Medium
  (pasted something, then
  changed it meaningfully)

Explained in chat                    Can articulate the concept  Very High
  ("why did you use X here?"
  → correct answer)

Fixed own bug related to concept     Debugging understanding     High
  (without AI help)

Bulk paste, no modification          Likely copied, no learning  Negative
Fast paste + immediate move on       Didn't engage with code     Negative
```

**New scoring approach:**

```
INSTEAD OF: +3 for "used correctly"

USE: +1 for used
     +1 if typed (not pasted)
     +1 if correct on first try
     +2 if new context
     +3 if explained correctly when asked
     -2 if bulk pasted and moved on
     -1 if needed to check documentation immediately before
```

**Periodic understanding checks (non-annoying):**

After a concept reaches "Functional" level, Protege occasionally asks:
- "Quick check: you just used useEffect. Can you tell me in one sentence when you'd use it vs. useMemo?" (1 in 10 times, not every time)
- If they answer well → confidence boost to mastery score
- If they can't answer → mastery stays but transfer_state drops to "fragile"
- These checks should feel like conversation, not quizzes
- Max 1 check per session, only for concepts at the threshold between levels

---

## 3. WebSocket Scalability Problem

**The problem:** One persistent WebSocket per user. At 10K users = 10K connections. At 100K = 100K connections. At 1M = impossible on a single server. WebSockets are stateful, which makes horizontal scaling hard.

**The fix: Hybrid connection model**

```
DON'T maintain a WebSocket for every user 24/7.

INSTEAD:

1. WebSocket ONLY while user is actively coding
   - Connect on VS Code activate
   - Disconnect on VS Code deactivate (or 5min idle)
   - Most users code 2-4 hours/day → connections are short-lived

2. For notifications when VS Code is CLOSED:
   - Use Web Push API (service worker in protege.dev)
   - Or native OS push via a thin notification daemon
   - Or email for non-urgent (weekly reports)
   - DO NOT keep a WebSocket open just for notifications

3. Scale WebSockets horizontally:
   - Use Redis pub/sub as the message broker between WS servers
   - Any WS server can handle any user's connection
   - Sticky sessions NOT required — state is in Redis

Connection lifecycle:
  User opens VS Code → WS connect → authenticated → assigned to any server
  User codes → events flow over WS → responses come back over WS
  User stops coding (5min idle) → WS downgraded to long-poll (cheaper)
  User closes VS Code → WS disconnect → future notifs via push/email
  
At scale:
  100K active coders at peak = ~20K concurrent WS connections
  (most users don't code at the same time)
  Handled by 5-10 WS servers behind a load balancer
```

---

## 4. Mutual Streak Timezone Problem

**The problem:** User A is in New York (UTC-5), User B is in Tokyo (UTC+9). They're in a mutual streak. "Both coded today" — but whose "today"? When A's day ends, B's next day has already started. If we use A's midnight, B might lose the streak unfairly.

**The fix: Rolling 24-hour window**

```
INSTEAD OF: "both coded on the same calendar day"

USE: "both coded within the same 36-hour window"

Window definition:
  A streak day starts at 00:00 in the EARLIER timezone
  and ends at 23:59 in the LATER timezone.
  
  Example: A is UTC-5, B is UTC+9 (14h difference)
  Streak day = 00:00 UTC-5 to 23:59 UTC+9 = 38-hour window
  
  As long as both code within this window, the streak holds.
  
  This is generous enough that timezone shouldn't cause unfair breaks,
  but still requires daily coding from both.

Alternative (simpler):
  Each user's streak is checked against THEIR OWN timezone.
  Mutual streak increments at the END of the day for whichever
  user's timezone is later. If at that point both have coded
  in their respective "today" → streak increments.
```

---

## 5. Skill Tree Maintenance Problem

**The problem:** The skill tree is a hardcoded hierarchy. But new frameworks ship constantly. React Server Components didn't exist 3 years ago. Bun didn't exist. Who adds new nodes? Who restructures? What happens to existing mastery data when the tree changes?

**The fix: Dynamic skill tree with versioning**

```
skill_tree_nodes (
  node_id       UUID PRIMARY KEY,
  name          VARCHAR(128) UNIQUE,
  parent_id     UUID REFERENCES skill_tree_nodes,
  path          VARCHAR(512),           -- "Web Dev > React > Server Components"
  category      VARCHAR(128),           -- frontend/backend/devops/etc.
  status        VARCHAR(32),            -- active/deprecated/merged
  added_in_version INTEGER DEFAULT 1,
  deprecated_in_version INTEGER,        -- null if still active
  merged_into   UUID REFERENCES skill_tree_nodes,  -- if merged
  description   TEXT,
  detection_rules JSONB,               -- AST patterns that detect this concept
  created_at    TIMESTAMP
)

Tree update process:
  1. Monthly review: AI scans trending tech + community requests
  2. New nodes added with status='active'
  3. Old nodes never deleted — marked deprecated, merged_into points to replacement
  4. User's concept_mastery rows auto-migrate:
     - If concept merged: scores merge (take higher score)
     - If concept deprecated: row stays, stops decaying, shown as "legacy" in UI
     - If concept renamed: transparent rename, no data loss
  
  Version log:
  skill_tree_versions (
    version    INTEGER PRIMARY KEY,
    changes    JSONB,    -- [{action: "add", node: "Bun runtime"}, ...]
    applied_at TIMESTAMP
  )

Detection rules (how AST finds concepts without AI):
  {
    "name": "React useState",
    "detection_rules": {
      "imports": ["useState from 'react'"],
      "patterns": ["const [*, set*] = useState(*)"],
      "file_types": [".tsx", ".jsx"]
    }
  }
  
  This makes concept detection data-driven, not hardcoded.
  New frameworks = new detection rules, no code change needed.
```

---

## 6. Code IQ Gaming / Inflation

**The problem:** A user could artificially inflate their Code IQ by writing unnecessary complex code. Use `Array.reduce` where a simple `for` loop works. Import advanced patterns just to trigger concept detection. Or worse — write concept-heavy throwaway code, get the score bump, delete the file.

**The fix: Quality-weighted scoring + anti-gaming**

```
Anti-gaming signals:
  - Code deleted within 5 minutes of writing → no score credit
  - Concept used but not in a meaningful context → reduced credit
    (e.g., writing `const x = new Map()` and never using x)
  - Sudden spike in concept usage → flag for review
    (normal: 2-3 new concepts/week, suspicious: 15 in one day)
  - Code that doesn't compile/run → no credit for concepts in it
  - Concept used in a file that's never saved/committed → reduced credit

Quality multiplier:
  Each concept usage gets a quality score (0.0 to 1.5):
  
  quality = base_credit
    × context_relevance   (was this the right tool for the job? 0.5-1.2)
    × code_health         (does the surrounding code work? 0.8-1.0)
    × persistence         (still in codebase after 24h? 0.5-1.0)
    × originality         (typed vs. pasted? 0.7-1.0)
  
  This naturally rewards good code and penalizes gaming.
  A reduce() that makes code cleaner gets full credit.
  A reduce() shoved in for no reason gets 0.3x credit.
```

---

## 7. AI Context Window Bloat

**The problem:** The system prompt includes student profile, mastery data, behavior data, code context, and conversation history. For a user with 100+ mastered concepts, the mastery block alone could be thousands of tokens. At $15/M tokens for Sonnet, this gets expensive fast. And it wastes context window on irrelevant data.

**The fix: Relevance-filtered context assembly**

```
INSTEAD OF: send ALL concept_mastery rows every time

USE: smart context assembly per request

Step 1: Identify relevant concepts
  - Parse current file → detect which concepts are in play
  - E.g., editing a React component with fetch → relevant concepts:
    React components, JSX, hooks, async/await, fetch API, error handling
  - Only include THESE concepts' mastery data in the prompt

Step 2: Summarize the rest
  - Instead of 100 rows of mastery data, send:
    "Student has 47 concepts at Functional+, strongest in frontend (IQ 680),
     weakest in DevOps (IQ 120). Full mastery data available on request."
  - AI can ask for specific concept data if needed

Step 3: Compress conversation history
  - Last 3 messages: full text
  - Messages 4-10: summarized ("discussed useState, user had misconception 
    about async state updates, corrected")
  - Messages 11+: dropped

Step 4: Cache the stable parts
  - Student profile changes rarely → cache for entire session
  - Use Claude's prompt caching: system prompt with profile = cached
  - Only the code diff + recent messages are uncached (cheap)

Token budget per AI call:
  System prompt (cached):  ~800 tokens
  Relevant mastery:        ~200 tokens (only current concepts)
  Behavior summary:        ~100 tokens
  Code context:            ~300 tokens (diff + 10 lines surrounding)
  Conversation:            ~500 tokens (last 3 messages)
  ────────────────────────────────────
  Total:                   ~1,900 tokens input per call
  
  vs. naive approach:      ~8,000+ tokens (sending everything)
  
  = 75% cost reduction on input tokens
```

---

## 8. No A/B Testing Infrastructure

**The problem:** How do we know which onboarding flow converts better? Which intervention style retains users? Which tip format gets shared more? Without A/B testing, we're guessing. And guessing at scale is expensive.

**The fix: Built-in experiment framework**

```
experiments (
  experiment_id   UUID PRIMARY KEY,
  name            VARCHAR(255),
  description     TEXT,
  status          VARCHAR(32),       -- draft/running/completed/archived
  target_audience VARCHAR(128),      -- all/beginners/intermediate/advanced
  variants        JSONB,             -- [{"name": "A", "weight": 50}, {"name": "B", "weight": 50}]
  metric          VARCHAR(128),      -- retention_7d / share_rate / intervention_click_rate / etc.
  started_at      TIMESTAMP,
  ended_at        TIMESTAMP,
  winner          VARCHAR(64),
  confidence      DECIMAL(5,4)
)

experiment_assignments (
  user_id        UUID REFERENCES users,
  experiment_id  UUID REFERENCES experiments,
  variant        VARCHAR(64),
  assigned_at    TIMESTAMP,
  PRIMARY KEY (user_id, experiment_id)
)

Things to A/B test early:
  1. Onboarding: 3-question vs. 5-question interview
  2. Hint frequency: 3/hour vs. 5/hour vs. on-demand only
  3. Daily grid format: minimal vs. detailed
  4. Streak freeze: available from day 1 vs. earned after 7-day streak
  5. Tip format: code-only vs. code + explanation vs. interactive
  6. Share prompt timing: end of session vs. after milestone vs. never prompt
```

---

## 9. Data Retention — Tables Grow Unbounded

**The problem:** `behavioral_events` table gets a row every 30 seconds per active user. 1000 users × 4 hours/day × 120 events/hour = 480,000 rows/day = 175 million rows/year. `tip_deliveries` and `coding_sessions` also grow fast. PostgreSQL will slow down.

**The fix: Tiered data lifecycle**

```
HOT DATA (PostgreSQL, full detail, < 30 days):
  - behavioral_events
  - tip_deliveries
  - coding_sessions
  - All actively queried tables

WARM DATA (PostgreSQL, aggregated, 30-365 days):
  - behavioral_events → aggregated into daily_behavior_summary
    (one row per user per day with pattern counts, not raw events)
  - tip_deliveries → aggregated into tip_performance
    (one row per tip with reaction counts)
  - coding_sessions stays (one row per session is manageable)

COLD DATA (S3/R2 archive, > 365 days):
  - Raw behavioral_events exported as Parquet files
  - Available for analytics/ML but not queried in real-time

Retention policy jobs (daily cron):
  1. Aggregate behavioral_events older than 30 days → daily_behavior_summary
  2. Delete raw behavioral_events older than 30 days
  3. Archive cold data older than 365 days to R2

New table:
daily_behavior_summary (
  user_id               UUID NOT NULL,
  date                  DATE NOT NULL,
  total_events          INTEGER,
  undo_redo_cycles      INTEGER,
  definition_jumps      INTEGER,
  build_fail_loops      INTEGER,
  long_pauses           INTEGER,
  fast_inserts          INTEGER,
  ai_assists            INTEGER,
  total_coding_minutes  INTEGER,
  concepts_detected     JSONB,
  patterns_detected     JSONB,
  PRIMARY KEY (user_id, date)
)

This keeps PostgreSQL lean while preserving all data for analytics.
```

---

## 10. Session Detection is Fragile

**The problem:** "Session ends when VS Code closes or 30min idle" is too crude.

Real scenarios it doesn't handle:
- User has 2 VS Code windows open (different projects)
- User switches to browser for 45 min to read docs (not idle, just not in editor)
- User closes VS Code, reopens 5 min later (is that 1 session or 2?)
- VS Code crashes (no clean deactivate, events lost)
- User puts laptop to sleep mid-session

**The fix: Resilient session management**

```
Session lifecycle (state machine):

  INACTIVE ──(VS Code opens)──→ STARTING
  STARTING ──(auth + load)────→ ACTIVE
  ACTIVE   ──(no edits 10m)───→ IDLE
  IDLE     ──(edit detected)──→ ACTIVE
  IDLE     ──(no edits 30m)───→ ENDING
  ENDING   ──(summary done)───→ INACTIVE
  
  ANY STATE ──(VS Code crash)──→ RECOVERING
  RECOVERING ──(VS Code opens)─→ STARTING (merge with previous if < 5min gap)

Crash recovery:
  - Events are written to local SQLite (not just memory) every 10 seconds
  - On next activation, extension checks for un-flushed events
  - If found: "I see you had an unfinished session. Let me sync your progress."
  - Merge into previous session if gap < 5 minutes
  - Start new session if gap > 5 minutes

Multi-window handling:
  - Each VS Code window has its own observer
  - All windows share the same WebSocket connection (via IPC)
  - Events tagged with window_id and project_name
  - Sessions are per-project, not per-window
  - Skill updates aggregate across all windows

Sleep/wake handling:
  - Extension listens for system sleep/wake events
  - On sleep: flush events, pause session timer
  - On wake: resume session, re-establish WebSocket
  - Gap during sleep doesn't count as idle time
```

---

## 11. No Team/Enterprise Architecture

**The problem:** The vision mentions team plans and enterprise. The architecture has zero support for this. At scale, this is where the real money is ($30/dev/month × 100 devs = $3K/month per company).

**The fix: Organization layer**

```
organizations (
  org_id        UUID PRIMARY KEY,
  name          VARCHAR(255),
  slug          VARCHAR(128) UNIQUE,
  plan          VARCHAR(32),          -- team/enterprise
  max_seats     INTEGER,
  admin_user_id UUID REFERENCES users,
  created_at    TIMESTAMP
)

org_members (
  org_id    UUID REFERENCES organizations,
  user_id   UUID REFERENCES users,
  role      VARCHAR(32),              -- admin/manager/member
  joined_at TIMESTAMP,
  PRIMARY KEY (org_id, user_id)
)

Team features:
  1. Team skill map: aggregate skill tree showing team strengths and gaps
     "Your team is strong in React but nobody knows Docker"
  
  2. Manager dashboard (protege.dev/org/acme):
     - Team Code IQ distribution
     - Skills coverage heatmap
     - Growth trends per member (anonymized option)
     - "3 team members are learning TypeScript this month"
     - Suggested training priorities based on project stack
  
  3. Team challenges:
     - Manager creates a team goal: "Everyone reaches Level 3 in Testing by Q3"
     - Progress tracked on team dashboard
     - Team streaks: "Your team has coded every day for 23 days"
  
  4. Privacy for teams:
     - Members control what manager sees
     - Options: full detail / skill levels only / aggregate only
     - Code is NEVER visible to managers through Protege
     - Individual mastery scores can be hidden (only team aggregate shown)

  5. Onboarding integration:
     - New hire joins org → gets a learning path matching the team's stack
     - "Your team uses React, TypeScript, and Prisma. Let's get you up to speed."
     - Manager sees: "New hire reached Functional level in React (week 2)"
```

---

## 12. Learning Paths Are Too Linear

**The problem:** Current paths are a flat sequence: A → B → C → D. But real learning is non-linear. A user might already know C. Or they might need a detour into X before they can understand D. The linear model forces everyone through the same order.

**The fix: Adaptive path engine**

```
INSTEAD OF: fixed sequence [A, B, C, D, E]

USE: dependency graph with skip/detour logic

Path structure:
{
  "name": "Full-Stack Web Dev",
  "nodes": [
    { "concept": "HTML basics",       "prerequisites": [] },
    { "concept": "CSS basics",        "prerequisites": ["HTML basics"] },
    { "concept": "JavaScript basics", "prerequisites": ["HTML basics"] },
    { "concept": "DOM manipulation",  "prerequisites": ["HTML basics", "JavaScript basics"] },
    { "concept": "React components",  "prerequisites": ["JavaScript basics", "DOM manipulation"] },
    { "concept": "React hooks",       "prerequisites": ["React components"] },
    { "concept": "Node.js basics",    "prerequisites": ["JavaScript basics"] },
    { "concept": "REST APIs",         "prerequisites": ["Node.js basics"] },
    { "concept": "Database basics",   "prerequisites": [] },
    { "concept": "Full-stack app",    "prerequisites": ["React hooks", "REST APIs", "Database basics"] }
  ]
}

Adaptive behavior:
  1. AUTO-SKIP: if user already has concept at Functional+ → skip it
     "You already know CSS basics (Level 6). Skipping to JavaScript."
  
  2. DETOUR: if user struggles with a concept → insert prerequisite
     User stuck on React hooks? Check: do they understand closures?
     If not → "Let's take a quick detour into closures first."
  
  3. BRANCH: user can choose order for independent concepts
     "Database basics and Node.js are independent. Which do you want first?"
  
  4. PACE: adjust estimated time based on user's learning speed
     User completing concepts 2x faster than average? Shorten estimates.
     User taking longer? Extend estimates, offer more practice.

This means two users on the same "Full-Stack Web Dev" path
will have completely different experiences based on their 
existing knowledge and learning speed.
```

---

## 13. Share Card Generation Won't Scale

**The problem:** Using Puppeteer to render HTML→PNG for every share card is slow (~2-5 seconds per card) and memory-heavy. At 10K users generating daily grids + weekly reports, that's 10K+ Puppeteer renders per day. Puppeteer spins up a headless Chrome per render. This will blow up server memory.

**The fix: Satori (no browser needed) + aggressive caching**

```
Rendering pipeline:

  Option A (recommended): Satori + Resvg
    - Satori: converts JSX/HTML to SVG (no browser, pure JS, ~50ms)
    - Resvg: converts SVG to PNG (Rust-based, ~20ms)
    - Total: ~70ms per card vs. ~3000ms with Puppeteer
    - Memory: ~50MB vs. ~500MB for Puppeteer
    - This is what @vercel/og uses under the hood
  
  Option B (fallback for complex cards): Pre-rendered templates
    - Wrapped cards with complex animations → pre-render template once
    - Swap in user-specific data as text overlays
    - Cache the base template, only render the dynamic layer

Caching strategy:
  - Daily grid: generated once per session, cached 24h
  - Weekly report: generated once, cached 7 days
  - Skill tree card: regenerated only when skill tree changes
  - Wrapped: generated once per quarter/year, cached indefinitely
  
  Cache key: {user_id}:{card_type}:{date}
  Storage: R2 with CDN (Cloudflare cache, ~10ms to serve)
  
  Most requests hit CDN cache, not the renderer.
  Only new/updated cards trigger actual rendering.
```

---

## 14. No Error Recovery for Lost Events

**The problem:** If WebSocket drops or VS Code crashes, behavioral events in the in-memory buffer are lost. The user coded for 30 minutes, observer tracked everything, then crash — all that data gone. Mastery scores for that session don't update. Streak might not register.

**The fix: Local persistence with write-ahead log**

```
Extension event pipeline with durability:

  Code Observer → Event Buffer (memory, fast)
                        │
                        ├──→ Every 10 seconds: write to local SQLite
                        │    (write-ahead log, survives crashes)
                        │
                        ├──→ Every 30 seconds: batch send to backend
                        │    (if online)
                        │
                        └──→ On successful backend ACK:
                             mark events as "synced" in local SQLite

  On crash recovery (next VS Code launch):
    1. Read local SQLite for un-synced events
    2. Send to backend with "backfill" flag
    3. Backend processes them, updates mastery/streaks
    4. Clear synced events from local SQLite
    5. "Welcome back! I synced your progress from last session."

  Local SQLite schema:
    event_log (
      event_id    TEXT PRIMARY KEY,
      event_type  TEXT,
      event_data  TEXT,      -- JSON
      session_id  TEXT,
      created_at  INTEGER,   -- unix timestamp
      synced      INTEGER DEFAULT 0
    )
    
  SQLite is perfect here: embedded, no server, crash-safe,
  handles concurrent writes from multiple VS Code windows.
  File location: ~/.protege/events.db
```

---

## 15. Privacy Model Has a Contradiction

**The problem:** The architecture says "code never leaves the machine without consent" but also says "send diffs for AI analysis on save." The default behavior is unclear. If the default is to send code, the privacy claim is misleading. If the default is to NOT send code, the product barely works.

**The fix: Transparent opt-in with clear tiers**

```
On first install, BEFORE any code is sent:

"Protege needs to read your code to help you learn.
 Choose your comfort level:

 🟢 Full (recommended): I can read your code to find bugs, 
    suggest improvements, and teach you in context. 
    Code is processed and immediately deleted — never stored or 
    used for training.

 🟡 Metadata only: I'll track which languages, frameworks, and 
    patterns you use, but won't read your actual code. 
    I can still teach you, but I can't find specific bugs.

 🟠 Local only: Everything stays on your machine. I'll use 
    local analysis only. Limited but fully private.

 You can change this anytime in settings."

Implementation:
  - privacy_level stored in learning_profile: full / metadata / local
  - Extension checks this BEFORE every outbound request
  - If "local": never call AI with code content, only use AST results
  - If "metadata": send concept names, file types, error types — no code
  - If "full": send diffs as designed
  - Status bar shows current level: 🟢 / 🟡 / 🟠
  - Clicking it opens settings to change

This is honest, clear, and gives users real control.
No fine print. No "by using this you agree to..." buried in ToS.
```

---

## Summary: Architecture Changes to Make

| Weak Spot | Fix | Where to Update |
|-----------|-----|-----------------|
| Claude API single point of failure | Degradation ladder + cached explanations | AI Service, Extension |
| Concept ≠ understanding | Multi-signal verification + occasional understanding checks | Skill Engine |
| WebSocket won't scale | Connect only while coding, push notifications otherwise | Extension, Backend infra |
| Timezone mutual streaks | Rolling window per timezone pair | Social Service |
| Skill tree is static | Dynamic tree with versioning + detection rules as data | New table, Skill Engine |
| Code IQ gaming | Quality multiplier + anti-gaming signals | Skill Engine |
| AI context too large | Relevance-filtered assembly + prompt caching | AI Service |
| No A/B testing | Experiment framework with variant assignment | New tables, all services |
| Tables grow forever | Tiered retention: hot → warm → cold | New cron jobs, new summary table |
| Session detection fragile | State machine + crash recovery + multi-window | Extension core |
| No team/enterprise | Organization layer with team dashboard | New tables, Web App |
| Paths too linear | Dependency graph with skip/detour/branch | Skill Engine, Learning Paths |
| Card rendering won't scale | Satori instead of Puppeteer + CDN caching | Content Service |
| Events lost on crash | Local SQLite write-ahead log | Extension core |
| Privacy contradiction | Explicit 3-tier opt-in on first install | Extension onboarding, Privacy |
