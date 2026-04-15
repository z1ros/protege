# Caching Strategy + Architecture Cleanup

## The Caching Problem Right Now

The architecture has NO caching strategy. Every AI call hits the API fresh. Every skill tree render fetches from the database. Every share card is generated on demand. This is slow AND expensive.

Caching is the difference between $6K/month and $600/month for 1,000 users.

---

## Complete Caching Map

### Layer 1: Extension Cache (Client-Side, Instant)

Lives in: VS Code `ExtensionContext.globalState` + in-memory

```
┌────────────────────────────┬──────────┬─────────────────────────────────┐
│ What's Cached              │ TTL      │ Invalidation                    │
├────────────────────────────┼──────────┼─────────────────────────────────┤
│ User profile               │ Session  │ On explicit profile update      │
│ (level, goals, style)      │          │                                 │
├────────────────────────────┼──────────┼─────────────────────────────────┤
│ Concept mastery snapshot   │ 5 min    │ After skill engine update       │
│ (all concepts + scores)    │          │ (server pushes new data via WS) │
├────────────────────────────┼──────────┼─────────────────────────────────┤
│ Skill tree structure       │ 24 hours │ On tree version change          │
│ (node hierarchy, names)    │          │ (rarely changes)                │
├────────────────────────────┼──────────┼─────────────────────────────────┤
│ Streak data                │ 1 min    │ After coding activity           │
│ (current count, freeze)    │          │                                 │
├────────────────────────────┼──────────┼─────────────────────────────────┤
│ Bug explanation cache      │ 30 days  │ On app update                   │
│ (top 50 common bugs,       │          │ (shipped with extension)        │
│  pre-written explanations) │          │                                 │
├────────────────────────────┼──────────┼─────────────────────────────────┤
│ Last AI analysis results   │ Per file │ On next save of same file       │
│ (findings for current file)│          │                                 │
├────────────────────────────┼──────────┼─────────────────────────────────┤
│ Daily challenge             │ 24 hours│ New challenge pushed via WS     │
│ (today's problem + tests)  │          │                                 │
├────────────────────────────┼──────────┼─────────────────────────────────┤
│ Pair partner status        │ 1 min    │ Partner activity pushed via WS  │
├────────────────────────────┼──────────┼─────────────────────────────────┤
│ AST detection rules        │ 7 days   │ On extension update             │
│ (concept → AST pattern map)│          │                                 │
└────────────────────────────┴──────────┴─────────────────────────────────┘
```

**Key insight:** The skill tree STRUCTURE (what nodes exist, their hierarchy) changes maybe once a month. The user's MASTERY DATA (scores per node) changes every session. Cache them separately with different TTLs.

### Layer 2: Redis Cache (Server-Side, Fast)

Lives in: Redis (Upstash serverless)

```
┌──────────────────────────────┬──────────┬───────────────────────────────┐
│ What's Cached                │ TTL      │ Key Pattern                   │
├──────────────────────────────┼──────────┼───────────────────────────────┤
│ AI response cache            │ 24 hours │ ai:{bug_type}:{lang}:{level}  │
│ (common bug explanations)    │          │                               │
│ "Missing await" at beginner  │          │ ai:missing_await:ts:beginner  │
│ level = same explanation     │          │                               │
│ for every user               │          │                               │
├──────────────────────────────┼──────────┼───────────────────────────────┤
│ User session state           │ 4 hours  │ session:{user_id}             │
│ (current mode, file,         │          │                               │
│  intervention count,         │          │                               │
│  behavioral buffer)          │          │                               │
├──────────────────────────────┼──────────┼───────────────────────────────┤
│ Streak state                 │ 48 hours │ streak:{user_id}              │
│ (current count, last active, │          │                               │
│  freeze status)              │          │                               │
├──────────────────────────────┼──────────┼───────────────────────────────┤
│ Daily challenge              │ 24 hours │ daily_challenge:{date}        │
│ (today's problem, cached     │          │                               │
│  once, served to everyone)   │          │                               │
├──────────────────────────────┼──────────┼───────────────────────────────┤
│ Daily challenge leaderboard  │ 30 sec   │ leaderboard:{date}:{bracket}  │
│ (top 50 per skill bracket)   │          │                               │
├──────────────────────────────┼──────────┼───────────────────────────────┤
│ Share card URLs              │ 7 days   │ card:{user_id}:{type}:{date}  │
│ (already-generated cards)    │          │                               │
├──────────────────────────────┼──────────┼───────────────────────────────┤
│ Tip of the session           │ Session  │ tip:{user_id}:{session_id}    │
│ (which tips already shown    │          │                               │
│  this session, to avoid      │          │                               │
│  repeats)                    │          │                               │
├──────────────────────────────┼──────────┼───────────────────────────────┤
│ User mastery summary         │ 5 min    │ mastery:{user_id}:summary     │
│ (pre-computed: top skills,   │          │                               │
│  weak skills, IQ score —     │          │                               │
│  avoids querying 100+ rows   │          │                               │
│  on every AI call)           │          │                               │
└──────────────────────────────┴──────────┴───────────────────────────────┘
```

### Layer 3: CDN Cache (Public Content, Global)

Lives in: Cloudflare CDN (in front of R2 storage + protege.dev)

```
┌──────────────────────────────┬──────────┬───────────────────────────────┐
│ What's Cached                │ TTL      │ Notes                         │
├──────────────────────────────┼──────────┼───────────────────────────────┤
│ Share card images            │ 30 days  │ Immutable once generated.     │
│ (daily grid, weekly report,  │          │ New card = new URL.           │
│  wrapped, milestones)        │          │ Never invalidated, just       │
│                              │          │ generate new ones.            │
├──────────────────────────────┼──────────┼───────────────────────────────┤
│ Public profile page          │ 5 min    │ ISR (Incremental Static       │
│ (protege.dev/username)       │          │ Regeneration in Next.js)      │
│                              │          │ Rebuilds in background.       │
├──────────────────────────────┼──────────┼───────────────────────────────┤
│ OG images for profiles       │ 1 hour   │ Regenerated when skill tree   │
│ (social media previews)      │          │ changes significantly.        │
├──────────────────────────────┼──────────┼───────────────────────────────┤
│ Challenge landing pages      │ 5 min    │ ISR. Shows participant count  │
│ (protege.dev/challenge/xyz)  │          │ which updates periodically.   │
├──────────────────────────────┼──────────┼───────────────────────────────┤
│ Learning path pages          │ 1 hour   │ Static. Rarely changes.       │
├──────────────────────────────┼──────────┼───────────────────────────────┤
│ Tip gallery                  │ 1 hour   │ ISR. New tips added slowly.   │
│ (protege.dev/tips)           │          │                               │
├──────────────────────────────┼──────────┼───────────────────────────────┤
│ Landing page + static assets │ 7 days   │ Standard static caching.      │
└──────────────────────────────┴──────────┴───────────────────────────────┘
```

### Layer 4: Claude API Prompt Caching

Claude supports prompt caching — if the same system prompt prefix is reused, Anthropic caches it and charges 90% less for the cached portion.

```
CACHE-FRIENDLY PROMPT STRUCTURE:

┌─────────────────────────────────────────────────┐
│ STATIC SYSTEM PROMPT (cached across all calls)  │  ← cached
│                                                 │
│ "You are Protege, a coding mentor..."           │
│ (base instructions, rules, formatting)          │
│ ~500 tokens, same for every user                │
├─────────────────────────────────────────────────┤
│ USER PROFILE BLOCK (cached within session)      │  ← cached
│                                                 │
│ "Student: beginner, goals: learn React,         │
│  style: hints-first, personality: explorer"     │
│ ~200 tokens, changes rarely within a session    │
├─────────────────────────────────────────────────┤
│ RELEVANT MASTERY (cached ~5 min)                │  ← cached
│                                                 │
│ "Relevant skills: async/await (0.32, fragile),  │
│  error handling (0.28, shaky)"                  │
│ ~150 tokens, only skills for current file       │
├─────────────────────────────────────────────────┤
│ DYNAMIC CONTEXT (never cached, changes always)  │  ← not cached
│                                                 │
│ Current file diff, recent errors,               │
│ behavioral signals, user's message              │
│ ~300-500 tokens                                 │
└─────────────────────────────────────────────────┘

Cache hit rate estimate:
  - Static system prompt: 100% (same always)
  - User profile: ~95% (changes once per session)
  - Relevant mastery: ~80% (same file = same concepts)
  - Dynamic context: 0% (always new)

Effective cost:
  Total tokens: ~1,200
  Cached tokens: ~850 (at 10% of full price)
  Uncached tokens: ~350 (full price)
  
  Effective input cost per call: ~450 "token equivalents"
  = ~62% savings on input tokens from prompt caching alone
```

### The Big Caching Win: AI Response Deduplication

This is the highest-impact, lowest-effort cache.

```
INSIGHT: 40% of AI code analysis findings are IDENTICAL across users.

"Missing await on res.json()" — same explanation for everyone.
"== should be ===" — same explanation for everyone.
"SQL injection via string concatenation" — same explanation for everyone.

These don't need unique AI calls. Cache the response.

HOW:

1. When AI returns a finding, hash the key attributes:
   cache_key = hash(bug_type + language + user_level)
   
   Example: hash("missing_await" + "typescript" + "beginner")
   → "a3f8c2d1..."

2. Store in Redis:
   SET ai:finding:a3f8c2d1 "{explanation: '...', fix: '...'}" EX 86400

3. On next user with same bug at same level:
   → Cache HIT → return instantly, no API call
   
4. Cache miss → call AI → store response → serve

Expected cache hit rate: 30-40% of all code analysis calls
= 30-40% fewer AI API calls
= at scale, this saves thousands of dollars per month

IMPORTANT: only cache the EXPLANATION, not the line number or 
file-specific context. The cache returns the teaching content,
which is then applied to the specific user's code location.
```

---

## Cleanup: Remove Over-Engineering (This is B2C)

The architecture got bloated with enterprise features. Protege is B2C — individual developers learning and growing. Strip out what doesn't belong in v1-v2.

### Remove Entirely (Not Building This)

```
REMOVED:
  ✗ organizations table
  ✗ org_members table
  ✗ Team skill map / manager dashboard
  ✗ Team challenges
  ✗ SSO / admin controls
  ✗ "Usage analytics + training recommendations" for managers
  ✗ Enterprise pricing tier
  ✗ SOC 2 compliance mention
  ✗ Notification Service email channel (keep push + VS Code only)
  ✗ A/B testing framework (use PostHog feature flags instead — don't build your own)
  ✗ Experiment tables (use PostHog)

WHY: These are distractions. Enterprise is a different product, different 
sales motion, different engineering. If Protege works for individuals, 
enterprise comes later with a separate effort. Don't architect for it now.
```

### Simplify (Over-Designed)

```
SIMPLIFIED:

1. Notification Service
   BEFORE: Push + Email + WebSocket, quiet hours, smart timing, 3 channels
   AFTER:  VS Code notifications only (for now)
   
   WHY: Users are IN VS Code when they need notifications. Push notifications
   require a separate service, certificates, platform-specific code. 
   VS Code's built-in notifications work fine for v1.
   Later: add Web Push via protege.dev service worker (simple, no app needed).

2. Share Card Rendering
   BEFORE: Satori + Puppeteer fallback + CDN + R2 + multiple platform sizes
   AFTER:  Satori only. One card size (1200×630, works everywhere).
   
   WHY: One size fits Twitter, Discord, LinkedIn, iMessage preview.
   Instagram Stories (1080×1920) can wait — developers share on 
   Twitter/Discord, not Instagram.

3. Model Routing
   BEFORE: Haiku for classification, Sonnet for teaching, Opus for architecture
   AFTER:  Sonnet for everything, Haiku for free-tier budget overflow
   
   WHY: Managing 3 model tiers adds complexity. Sonnet is good enough for 
   everything at this stage. Use Haiku only when free-tier users hit their 
   daily limit — give them 3 more Haiku-powered chats instead of a hard wall.
   Opus is overkill for v1. Revisit when you have paying Master Mode users.

4. Skill Decay
   BEFORE: Per-concept decay rates with stability modifiers and usage modifiers
   AFTER:  Simple rule — unused concepts decay one sub-level after 30 days
   
   WHY: The complex formula looks smart on paper but is impossible to 
   calibrate without real user data. Start simple, tune with data later.
   
   Simple rule:
     - Not used in 30 days → drop from Expert to Competent
     - Not used in 60 days → drop from Competent to Functional
     - Not used in 90 days → drop from Functional to Familiar
     - Below Familiar → stays (you don't forget that arrays exist)
   
   This is good enough. Users see skills fading. They come back to refresh.
   Complex decay curves can come in v3 when you have 6 months of user data.

5. Learning Paths
   BEFORE: Dependency graphs with skip/detour/branch, community-created, ratings
   AFTER:  Linear paths with auto-skip for known concepts. Protege-curated only.
   
   WHY: Community paths need moderation, ratings, abuse prevention — all 
   infrastructure you don't need yet. Start with 5-10 curated paths.
   Auto-skip is the one smart feature worth keeping: "You already know CSS 
   (Level 6). Skipping to JavaScript."
   
   Community paths can come when you have 10K+ users creating demand for them.

6. Behavioral Events Storage
   BEFORE: Raw events → daily summaries → cold archive. Three tiers.
   AFTER:  Store daily summaries only. Don't store raw events on the server.
   
   WHY: Raw behavioral events are processed CLIENT-SIDE into patterns. 
   The server only needs the interpreted results. Storing raw events is 
   wasted storage. The local SQLite write-ahead log keeps raw events 
   temporarily for crash recovery, then discards them.
   
   What gets stored on server per day per user:
     - Concepts detected (JSONB array)
     - Patterns detected (JSONB array)  
     - Session stats (duration, files, lines, bugs caught)
     - Mastery score changes
   
   This is ONE row per user per day. Clean, lean, queryable.
```

---

## Simplified Database (B2C, No Bloat)

Tables that STAY (core product):
```
users
learning_profile
concept_mastery
learning_behavior
project_context
followup_queue
streaks
pairs
challenges
challenge_participants
daily_challenges
daily_challenge_submissions
badges
user_badges
learning_paths
user_path_progress
share_cards
tip_catalog
tip_deliveries
coding_sessions
bugs_caught_milestones
```

Tables REMOVED:
```
✗ organizations
✗ org_members
✗ experiments
✗ experiment_assignments
✗ behavioral_events (replaced by daily summary in coding_sessions)
✗ bugs_caught (individual row per bug is overkill — just count in coding_sessions)
```

Table SIMPLIFIED:
```
coding_sessions — add these fields, absorb daily summary role:
  + patterns_detected    JSONB    -- behavioral patterns from that session
  + concepts_new         JSONB    -- first-time concepts
  + bugs_by_type         JSONB    -- {"missing_await": 2, "null_ref": 1}
  + total_bugs_caught_cumulative INTEGER  -- running total, updated each session
```

Individual `bugs_caught` table removed. Bug count lives as a cumulative counter on `coding_sessions` (latest session has the current total). Milestones table stays for share card triggers.

---

## Vision Cross-Check: What's Missing?

Going through [improved-vision.md](../Vision/improved-vision.md) line by line:

```
VISION ITEM                              ARCHITECTURE STATUS
────────────────────────────────────────────────────────────
AI interview on first open               ✅ Onboarding flow spec'd
Figures out your level and goals         ✅ learning_profile
Asks what you want to learn              ✅ Onboarding flow
Shows HTML, removes it, "your turn"      ✅ Learn Mode lesson flow
Checks your work, gives feedback         ✅ AI Service + Code Observer
Shows h1/h2/h3 in HTML tree context      ⚠️ PARTIALLY MISSING — see below
Ask you to run code and check it out     ✅ Learn Mode step: "run it"
Learn a new library                      ✅ Learning paths
Analyzes code in real time               ✅ Code Observer + AI analysis
Identifies bugs before you push          ✅ Build Mode
Proactive feature suggestions            ✅ "Did you know" tips
Code IQ with your level                  ✅ Code IQ score
Skill tree with all skills               ✅ Skill tree visualization
Once you master something it opens up    ✅ Fog-of-war reveal
Streaks                                  ✅ Solo + mutual streaks
It is in VS Code                         ✅ VS Code extension
```

### The One Missing Thing: Visual Code Context

The original vision says:
> "show h1, h2, h3 tags, highlight them in html tree and explain"

This means showing the code in a VISUAL context — not just syntax, but how it relates to the rendered output and the DOM tree. The architecture doesn't have this.

**Fix: Add a "Visual Bridge" feature to Learn Mode**

```
VISUAL BRIDGE (Learn Mode only):

When teaching HTML/CSS/frontend concepts:
  1. Protege writes code in a file
  2. Extension opens a side-by-side preview (VS Code Simple Browser or Live Preview extension)
  3. Protege HIGHLIGHTS elements in both the code AND the preview:
     "See this <h1> tag? Look at the preview — it's the big title at the top."
  4. When user changes the code and saves → preview updates live
  5. Protege points out the connection:
     "You changed the color to blue — see how the title changed in the preview?"

Implementation:
  - Use VS Code's built-in Simple Browser (`vscode.env.openExternal` or webview)
  - Or recommend Live Server extension as a dependency
  - CodeLens annotations link code to visual output:
    "This <div> → the blue box in the preview"
  - For React: suggest dev tools, show component tree mapping

This is specific to Learn Mode with beginners learning HTML/CSS/React.
Not needed for Build or Master mode.
```

---

## Final Architecture State: What We're Actually Building

```
LAYER 1: VS CODE EXTENSION
  ├── Mentor Chat (sidebar webview, React)
  ├── Code Observer (silent, event listeners, async)
  ├── Local Analyzer (Tree-sitter AST + diff engine + rule-based bugs)
  ├── Skill Tree (webview panel, Canvas-rendered)
  ├── Status Bar (streak, IQ, Protege dot)
  ├── Share Engine (generates text grids, requests image cards)
  ├── Local Cache (ExtensionContext + in-memory)
  ├── Local SQLite (crash recovery write-ahead log)
  └── Visual Bridge (Learn Mode: side-by-side code + preview)

LAYER 2: BACKEND (single Node.js server, modules not microservices)
  ├── AI Module
  │   ├── Mentor chat (Sonnet, prompt-cached)
  │   ├── Code analysis (Sonnet, response-deduplicated)
  │   ├── Lesson generation (Sonnet)
  │   ├── Challenge generation (Sonnet)
  │   └── Onboarding interview (Sonnet)
  ├── Behavior Module
  │   ├── Receives interpreted patterns from extension
  │   ├── Confirms against mastery data
  │   ├── Decides intervention type + timing
  │   └── Sends intervention payload back via WebSocket
  ├── Skill Module
  │   ├── Concept mastery updates (from local AST + AI findings)
  │   ├── Code IQ calculation
  │   ├── Simple decay (30/60/90 day rule)
  │   ├── Gap analysis (vs. stated goals)
  │   └── Learning path progress tracking
  ├── Social Module
  │   ├── Solo + mutual streaks (Redis for state, PG for history)
  │   ├── Pairs (invite, dashboard data, nudge)
  │   ├── Challenges (create, join, track, leaderboard)
  │   └── Badges (check milestones, award)
  ├── Content Module
  │   ├── Daily grid generator (text + image via Satori)
  │   ├── Weekly report generator (Sunday cron job)
  │   ├── Wrapped generator (quarterly cron job)
  │   ├── Milestone card generator (on badge earn)
  │   └── Tip curation (impact scoring, promotion)
  ├── Data Layer
  │   ├── PostgreSQL (Neon): all persistent data
  │   ├── Redis (Upstash): caches, session state, streaks, leaderboards
  │   └── R2 (Cloudflare): share card images
  └── WebSocket Server
      ├── Authenticated connections (only while coding)
      ├── Redis pub/sub for horizontal scaling (later)
      └── Interventions, partner notifications, streak updates

LAYER 3: PROTEGE.DEV (Next.js on Vercel)
  ├── Landing page (marketing, install CTA)
  ├── Public profiles (protege.dev/username, ISR cached 5min)
  ├── Challenge pages (protege.dev/challenge/xyz, ISR cached 5min)
  ├── Pair invite pages (protege.dev/pair/xyz)
  ├── Weekly report view (shareable link)
  ├── Wrapped experience (multi-slide)
  ├── Tip gallery (top tips by impact score)
  └── OG image generation (for social previews)

WHAT WE'RE NOT BUILDING (YET):
  ✗ Team/enterprise features
  ✗ Custom notification service (VS Code native only)
  ✗ Complex skill decay formulas
  ✗ Community learning paths
  ✗ Multiple AI model routing
  ✗ Custom A/B testing framework (use PostHog)
  ✗ Raw event storage on server
  ✗ Mobile app
  ✗ JetBrains/Neovim support
```

---

## Caching Impact on Cost

```
WITHOUT CACHING:
  AI calls per user per hour: 5-10
  Average tokens per call: 2,500 input + 500 output
  Monthly cost per user (3h/day): ~$4.50
  1,000 users: ~$4,500/month

WITH FULL CACHING STRATEGY:
  Prompt caching: -62% on input tokens
  Response deduplication: -35% of calls eliminated entirely
  Local bug detection: -40% of calls never needed
  
  Effective AI calls per user per hour: 2-3
  Effective input tokens per call: ~450 (after prompt caching)
  
  Monthly cost per user (3h/day): ~$0.80
  1,000 users: ~$800/month
  
  SAVINGS: ~82% cost reduction

  Free tier (Haiku for overflow): ~$0.40/user/month
  Pro tier (Sonnet): ~$1.50/user/month at $15/month revenue = 90% margin
```

---

## What Changed From Previous Architecture

1. **Added:** Complete 4-layer caching strategy (client, Redis, CDN, prompt)
2. **Added:** AI response deduplication (30-40% fewer API calls)
3. **Added:** Visual Bridge for Learn Mode (code ↔ preview connection)
4. **Removed:** All team/enterprise tables and features
5. **Removed:** Custom A/B testing framework (use PostHog)
6. **Removed:** Raw behavioral_events table (use daily summaries only)
7. **Removed:** Individual bugs_caught table (cumulative counter in coding_sessions)
8. **Removed:** Email notifications (VS Code native only for now)
9. **Removed:** Multi-model routing complexity (Sonnet for everything, Haiku as overflow)
10. **Simplified:** Skill decay to 30/60/90 day rule
11. **Simplified:** Learning paths to linear + auto-skip (no dependency graphs yet)
12. **Simplified:** Share cards to single size (1200×630)
13. **Simplified:** Notification system to VS Code only
14. **Merged:** behavioral_events data into coding_sessions table
