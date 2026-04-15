# Protege — Full System Architecture (v2)

## System Map

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          USER'S EDITOR                                  │
│                     (VS Code / Cursor / Forks)                          │
│                                                                          │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────────────────┐│
│  │  Mentor    │ │  Code      │ │  Skill     │ │  Social & Share        ││
│  │  Chat      │ │  Observer  │ │  Tree      │ │  (Grid, Streaks,       ││
│  │  (Sidebar) │ │  (Silent)  │ │  (Webview) │ │   Challenges, Badges)  ││
│  └─────┬──────┘ └─────┬──────┘ └─────┬──────┘ └──────────┬─────────────┘│
│        │              │              │                    │              │
│  ┌─────┴──────────────┴──────────────┴────────────────────┴────────────┐ │
│  │                      EXTENSION CORE                                 │ │
│  │                                                                     │ │
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌────────────┐ │ │
│  │  │ Local        │ │ Event Bus    │ │ Session      │ │ Offline    │ │ │
│  │  │ Analyzer     │ │ & State Mgr  │ │ Tracker      │ │ Queue      │ │ │
│  │  │ (AST + diff) │ │              │ │              │ │            │ │ │
│  │  └──────────────┘ └──────────────┘ └──────────────┘ └────────────┘ │ │
│  └────────────────────────────┬────────────────────────────────────────┘ │
└───────────────────────────────┼──────────────────────────────────────────┘
                                │ WebSocket (events) + REST (on-demand)
                                ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                          PROTEGE CLOUD                                   │
│                                                                          │
│  ┌──────────┐ ┌───────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐ │
│  │ AI       │ │ Behavior  │ │ Skill    │ │ Social   │ │ Content      │ │
│  │ Service  │ │ Service   │ │ Engine   │ │ Service  │ │ & Share      │ │
│  │          │ │           │ │          │ │          │ │ Service      │ │
│  │ Mentor   │ │ Pattern   │ │ Code IQ  │ │ Streaks  │ │ Daily Grid   │ │
│  │ Analysis │ │ Confirm   │ │ Mastery  │ │ Pairs    │ │ Reports      │ │
│  │ Lessons  │ │ Decide    │ │ Decay    │ │ Challenges│ │ Wrapped     │ │
│  │ Tips     │ │ Intervene │ │ Gaps     │ │ Badges   │ │ Tip Curation │ │
│  │ Onboard  │ │           │ │ Paths    │ │ Profiles │ │ Card Render  │ │
│  └──────────┘ └───────────┘ └──────────┘ └──────────┘ └──────────────┘ │
│                                                                          │
│  ┌───────────────┐ ┌──────────────┐ ┌─────────────┐ ┌────────────────┐ │
│  │ Notification   │ │ Job Queue    │ │ Data Layer  │ │ Analytics      │ │
│  │ Service        │ │ (BullMQ)     │ │ PG + Redis  │ │ Pipeline       │ │
│  │ Push/Email/WS  │ │              │ │ + R2        │ │                │ │
│  └───────────────┘ └──────────────┘ └─────────────┘ └────────────────┘ │
└──────────────────────────────┬───────────────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                        PROTEGE.DEV (Web App)                             │
│                                                                          │
│  Landing · Profiles · Skill Trees · Reports · Challenge Pages            │
│  Wrapped · Leaderboards · Tip Gallery · Learning Path Browser            │
│  Install Deep Links · OG Image Previews                                  │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Part 1: Extension (Client)

### 1.1 Smart Local Analysis (Cost Efficiency)

The #1 architectural decision: **don't send every keystroke or every save to the AI.** Claude API calls are expensive. The extension must be smart about WHAT it sends and WHEN.

```
LOCAL ANALYZER (runs in extension, no API call):

1. AST PARSER (Tree-sitter or TypeScript compiler API)
   - Parses the current file locally
   - Detects concepts used WITHOUT AI:
     - Language features: async/await, generators, destructuring, etc.
     - Framework patterns: useState, useEffect, Express routes, etc.
     - Data structures: arrays, maps, sets, trees
     - Patterns: callbacks, promises, event listeners, observers
   - This handles ~70% of concept detection with ZERO API cost

2. DIFF ENGINE
   - Tracks what CHANGED since last save (not the whole file)
   - Only sends the diff + surrounding context to AI
   - If only whitespace/formatting changed → skip AI entirely
   - If change is trivial (rename variable, add comment) → skip AI

3. LOCAL PATTERN DETECTOR
   - Detects behavioral patterns CLIENT-SIDE (no network needed):
     - Undo/redo cycles
     - Definition jumps
     - File bouncing
     - Long pauses
     - Fast inserts (paste/AI detection)
     - Build-fail loops
   - Only sends INTERPRETED patterns to backend, not raw events
   - Reduces bandwidth by ~90% vs. streaming raw events

4. RULE-BASED BUG DETECTION
   - Common bugs caught without AI (like a teaching-focused linter):
     - Missing await on async functions
     - == vs === in JavaScript
     - Unused variables
     - Missing error handling on promises
     - SQL injection patterns
     - XSS vulnerabilities
   - These show INSTANTLY (no network latency)
   - AI is only called for complex/nuanced analysis

WHEN TO CALL THE AI:
┌─────────────────────────────────────┬─────────────────────────┐
│ Situation                           │ Action                  │
├─────────────────────────────────────┼─────────────────────────┤
│ User saves file, trivial change     │ Local analysis only     │
│ User saves file, meaningful change  │ Debounce 5s, then AI    │
│ User explicitly asks for help       │ AI immediately          │
│ Behavioral pattern detected         │ AI for teaching content │
│ User starts a lesson                │ AI for lesson flow      │
│ End of session                      │ AI for session summary  │
│ User idle > 2 min after error       │ AI for hint generation  │
└─────────────────────────────────────┴─────────────────────────┘

COST ESTIMATE:
  Without smart routing: ~50-100 AI calls/hour/user = $$$
  With smart routing:    ~5-10 AI calls/hour/user   = manageable
```

### 1.2 Offline Mode

```
When there's no internet connection:

STILL WORKS:
  - Local AST analysis (concept detection)
  - Local pattern detection (behavioral signals)
  - Rule-based bug detection
  - Streak tracking (syncs when back online)
  - Skill tree viewing (cached)
  - Code Observer (events queued locally)

DOESN'T WORK (gracefully degraded):
  - AI mentor chat → shows: "I'm offline — I'll catch up when you're back"
  - AI code analysis → falls back to local rules only
  - Share card generation → queued for later
  - Daily challenge → cached if pre-fetched, otherwise unavailable

SYNC ON RECONNECT:
  - Flush queued behavioral events
  - Send queued code diffs for deferred analysis
  - Update streaks
  - Generate any missed share cards
  - Pull latest daily challenge
```

### 1.3 The Four UI Surfaces

#### Surface 1: Mentor Chat (Sidebar Webview)
```
┌────────────────────────────┐
│  Protege          [⚙] [─] │
│────────────────────────────│
│                            │
│  💬 Protege:               │
│  Hey! You left a bug in    │
│  auth.ts:42 yesterday.     │
│  Want to fix it?           │
│                            │
│  [Fix it] [Show me] [Skip] │
│                            │
│  You: Show me              │
│                            │
│  💬 Protege:               │
│  Look at line 42 — if the  │
│  API fails, `user` is      │
│  undefined but you access  │
│  `.name` on line 43.       │
│                            │
│  Try wrapping it in a      │
│  try/catch. I'll check     │
│  your work.                │
│                            │
│────────────────────────────│
│ [Tabs: Chat | Pair | Tree] │
│────────────────────────────│
│ [Type a message...]    [→] │
└────────────────────────────┘
```

Tabs in the sidebar:
- **Chat** — mentor conversation
- **Pair** — Learn Together dashboard (partner's activity, mutual streak)
- **Tree** — compact skill tree view (full view opens as editor panel)

Context assembled per AI call:
```json
{
  "student": {
    "level": "beginner",
    "goals": ["learn async", "improve debugging"],
    "style": "hints-first",
    "personality": "explorer",
    "ai_reliance": "high"
  },
  "mastery": {
    "relevant_concepts": [
      { "name": "error handling", "level": "fragile", "score": 0.32 },
      { "name": "async/await", "level": "familiar", "score": 0.38 }
    ],
    "misconceptions": ["thinks state updates happen immediately"]
  },
  "context": {
    "file": "auth.ts",
    "language": "typescript",
    "diff": "...(only changed lines + 10 lines surrounding)...",
    "diagnostics": ["TypeError at line 42"],
    "session_mode": "build",
    "behavior_signals": ["undo_redo_cycle", "long_pause_after_error"]
  },
  "history": "...(last 10 messages, summarized if long)..."
}
```

#### Surface 2: Inline Code Hints
```
  40 │ async function getUser(id) {
  41 │   const res = await fetch(`/api/user/${id}`);
     │   ⚡ What if this fetch fails? (click to learn)        ← CodeLens (blue, tip)
  42 │   const user = res.json();
     │              ~~~~~~~~                                  ← Diagnostic (red squiggle)
     │   ⚠ Missing `await` — res.json() returns a Promise
  43 │   return user.name;
  44 │ }
```

Three hint types, three visual styles:
- **Red** (diagnostic squiggle) — definite bug. Always shown. Instant (local detection).
- **Yellow** (warning squiggle) — security/performance. Shown on save.
- **Blue** (CodeLens above line) — teaching tip. Max 1-2 per session. Only high-impact.

Noise control rules:
- Max 2 active hints visible at once
- If user dismisses same hint type 3x → reduce frequency by 50%
- If user clicks/engages with hints → slightly increase frequency
- Build mode: bugs only by default, tips on demand
- Learn mode: all hints active

#### Surface 3: Skill Tree (Webview Panel)

Opens as an editor tab (full panel) or compact sidebar view.

Interactive features:
- Zoom, pan, search
- Click any node → detail popup: level, score, times used, decay status, sub-skills
- Glow states: bright = mastered, dim = learning, dark = unexplored, pulsing orange = decaying
- "Gaps" overlay: highlights path from current skills to goal
- "Share" button → generates card (text + image)
- "Compare" button → side-by-side with paired friend or peer average

#### Surface 4: Status Bar
```
┌────────────────────────────────────────────────────────────────────┐
│ main ○ auth.ts                                                     │
│                    🔥 14  │  IQ 487  │  🎯 3/5  │  Protege ●      │
└────────────────────────────────────────────────────────────────────┘
  streak ──┘     score ──┘    daily ──┘    status ──┘
                              challenge
```

Each item is clickable:
- Streak → opens streak detail (solo + mutual streaks, freeze status, history)
- IQ → opens skill tree panel
- Daily challenge progress → opens challenge in sidebar
- Protege dot → toggles mentor chat. Green = active. Gray = offline/paused.

### 1.4 Code Observer

Runs silently. Collects signals. Never interrupts.

```
RAW VS CODE EVENTS                    LOCAL INTERPRETATION
──────────────────                     ────────────────────
onDidChangeTextDocument ──────────┐
onDidSaveTextDocument   ──────────┤
onDidOpenTextDocument   ──────────┤    ┌──────────────────────┐
onDidCloseTextDocument  ──────────┼───▶│  Event Processor     │
onDidChangeActiveEditor ──────────┤    │                      │
Terminal output         ──────────┤    │  Debounce → Classify │
Diagnostics changes     ──────────┤    │  → Pattern Detect    │
Debug session events    ──────────┘    │  → Concept Detect    │
                                       │  (all local, no API) │
                                       └──────────┬───────────┘
                                                  │
                                     ┌────────────┴────────────┐
                                     │                         │
                               Behavioral              Concept
                               Signals                 Signals
                               (patterns)              (AST-detected)
                                     │                         │
                                     ▼                         ▼
                              ┌─────────────┐          ┌──────────────┐
                              │ Send to     │          │ Update local │
                              │ backend     │          │ skill cache  │
                              │ (batched    │          │ + send to    │
                              │  every 30s) │          │ backend      │
                              └─────────────┘          └──────────────┘
```

Behavioral patterns detected locally:
| Pattern | Detection Rule | Interpretation |
|---------|---------------|----------------|
| Undo/redo cycle | Same area edited > 3x in 60s | Uncertainty, fragile understanding |
| Definition jump repeat | Same definition opened > 2x in 5min | Needs to re-anchor understanding |
| File bouncing | Switching between same 2-3 files > 4x in 2min | Reconstructing logic path |
| Long pause after error | No edits > 30s after diagnostic appears | Confused, possibly stuck |
| Fast insert | > 200 chars in < 2s | Pasted or AI-generated code |
| Build-fail loop | build → error → edit → build → error > 3x | Debugging not converging |
| Post-AI pause | No edits > 10s after AI code insertion | May not understand AI code |
| Explanation skip | Dismissed Protege hint in < 1s | Adjust format or reduce frequency |

### 1.5 Onboarding Flow (The "Wow" Moment)

The first 5 minutes must be magical. This is architected, not accidental.

```
STEP 1: INSTALL (0 seconds)
  User clicks "Install" on VS Code Marketplace
  Extension activates immediately

STEP 2: GREETING (5 seconds)
  Sidebar opens automatically with:
  "Hey! I'm Protege — your coding mentor. 
   Mind if I ask you a couple quick questions?"
  [Let's go] [Maybe later]

STEP 3: MICRO-INTERVIEW (60 seconds, 3-4 messages)
  Conversational, not a form. AI-driven.
  
  Q1: "Have you written code before?"
      → Determines: beginner / some experience / experienced
  
  Q2: "What excites you about coding?"
      → Determines: web / mobile / games / data / "just want to learn"
      → Sets: target_stack, learning_goals
  
  Q3: "How do you like to learn? Step-by-step guidance, or explore 
       and ask questions when stuck?"
      → Sets: mentor_style, explanation_preference
  
  Backend creates: learning_profile row with initial values

STEP 4: THE WOW (60-90 seconds)
  "Alright — let me show you something cool. Give me 30 seconds."
  
  BEGINNER PATH:
    Protege creates a file: my-first-page.html
    Writes basic HTML with the user's name (from GitHub profile):
    
    <html>
      <body style="background: #1a1a2e; color: white; font-family: sans-serif; 
                   text-align: center; padding-top: 100px;">
        <h1>Welcome, Yura 👋</h1>
        <p>You just created your first webpage.</p>
        <p style="color: #00ff88;">This is the beginning.</p>
      </body>
    </html>
    
    "Run this file — right-click → Open with Live Server, or just 
     open it in your browser."
    
    User sees THEIR NAME on a styled webpage. In 30 seconds.
    
    "That's HTML. You just wrote a webpage. Want me to show you 
     how to make it yours?"
    
    → This is the screenshot moment. First-ever webpage with their name.
  
  EXPERIENCED PATH:
    Protege scans the open workspace (if any):
    "I see you're working on a Next.js project. Let me take a quick look..."
    
    Runs local analysis + one AI call:
    "Found 3 things:
     1. A potential null reference in auth.ts:42
     2. Your API route doesn't handle errors — could crash in production
     3. You're importing a 200KB library but only using one function
     
     Want me to walk you through any of these?"
    
    → This is the "holy shit it actually found something" moment.

STEP 5: FIRST SKILL REGISTERED (30 seconds after wow)
  "By the way — I just added 'HTML Basics' to your skill tree."
  Shows a mini skill tree preview in the sidebar.
  One bright node on a dark tree.
  
  "This is your Code IQ — it tracks everything you learn. 
   It'll grow as you code. Want to see the full tree?"
  
  → User is hooked. They have something to grow.

TOTAL TIME: < 3 minutes from install to first skill node lit up.
```

---

## Part 2: Backend Services

### 2.1 AI Service

```
RESPONSIBILITIES:
  1. Mentor chat (conversational teaching)
  2. Code analysis (bugs, tips, patterns — only when local analyzer defers)
  3. Lesson generation (structured micro-lessons for Learn Mode)
  4. Challenge generation (problems matched to skill level)
  5. Onboarding interview (adaptive questions)
  6. Session summaries (end-of-session teaching recap)
  7. Personality detection (analyze coding patterns over time)

PROMPT ARCHITECTURE:
  System prompt is modular — assembled from user's data:
  
  ┌─────────────────────────────────────────────────────────────┐
  │ SYSTEM PROMPT                                               │
  │                                                             │
  │ [Base] You are Protege, a coding mentor that lives in the   │
  │ user's editor. You teach by doing — short, specific, tied   │
  │ to their actual code. Never lecture. Never be generic.      │
  │                                                             │
  │ [Student block] ← from learning_profile                     │
  │ Level: beginner | Goals: learn web dev | Style: hints-first │
  │ Personality: explorer | AI reliance: high                   │
  │                                                             │
  │ [Mastery block] ← from concept_mastery (relevant subset)    │
  │ Strong: HTML (0.82), CSS selectors (0.71)                   │
  │ Weak: async/await (0.32, fragile), error handling (0.28)    │
  │ Misconceptions: thinks setState is synchronous              │
  │                                                             │
  │ [Behavior block] ← from learning_behavior + current session │
  │ Currently: stuck (undo/redo cycle on line 42)               │
  │ Pattern: skips explanations, prefers short hints             │
  │ AI reliance areas: async, typing                            │
  │                                                             │
  │ [Code block] ← only the relevant diff + context             │
  │ File: auth.ts | Language: TypeScript                        │
  │ Changed lines: 38-45 | Errors: TypeError at 42             │
  │                                                             │
  │ [Rules block] ← mode-specific                               │
  │ Mode: BUILD → be concise, don't interrupt flow              │
  │ Max response: 3 sentences unless user asks for more         │
  │ If AI reliance high: give hints, not answers                │
  │ Reference THEIR code, not generic examples                  │
  └─────────────────────────────────────────────────────────────┘

COST OPTIMIZATION:
  - Use prompt caching (Claude supports this) — the system prompt 
    with student/mastery blocks rarely changes within a session
  - Batch analysis: collect 5s of saves, analyze once
  - Cache AI responses for common bugs (missing await, == vs ===)
  - Use Haiku for simple classifications, Sonnet/Opus for teaching
  
  Model routing:
  ┌────────────────────────────────┬──────────────┐
  │ Task                           │ Model        │
  ├────────────────────────────────┼──────────────┤
  │ Concept classification         │ Haiku        │
  │ Simple bug explanation         │ Haiku        │
  │ Mentor chat (short response)   │ Sonnet       │
  │ Lesson generation              │ Sonnet       │
  │ Complex code analysis          │ Sonnet       │
  │ Architecture review            │ Opus         │
  │ Personality type detection     │ Sonnet       │
  │ Session summary                │ Haiku        │
  │ Onboarding interview           │ Sonnet       │
  └────────────────────────────────┴──────────────┘
```

### 2.2 Behavior Service

The extension detects patterns locally. The backend CONFIRMS interpretations and DECIDES interventions.

```
CLIENT detects: "undo_redo_cycle on lines 38-45, concept: async/await"
                    │
                    ▼
SERVER confirms:
  1. Check concept_mastery → async/await score is 0.32 (fragile)
  2. Check learning_behavior → productive_struggle_tolerance = "medium"
  3. Check session state → 2 interventions already this hour (budget: 5)
  4. Check recent history → user engaged with last hint (didn't dismiss)
                    │
                    ▼
DECISION:
  - Should intervene? YES (fragile concept + pattern + budget available)
  - Type: LIGHT (user is in flow, don't disrupt heavily)
  - Delivery: CodeLens hint on line 42
  - Timing: NOW (user is clearly stuck)
  - Content: request AI Service to generate a short hint about await
                    │
                    ▼
RESPONSE to extension:
  {
    "action": "show_hint",
    "delivery": "codelens",
    "line": 42,
    "content": {
      "short": "This needs `await` — res.json() returns a Promise",
      "action_label": "Show me why",
      "detail_id": "fetch-await-explanation"  // fetched on click
    },
    "concept": "async/await",
    "intervention_level": "light"
  }

INTERVENTION BUDGET per session:
  - Build mode: 5/hour (mostly bugs, rare tips)
  - Learn mode: 15/hour (active teaching)
  - Master mode: 3/hour (high-value architecture insights only)
  
  Budget resets each hour. Unused budget does NOT roll over.
  
  Priority override: bugs and security issues always show regardless of budget.
```

### 2.3 Skill Engine

```
TWO-TIER CONCEPT DETECTION:

Tier 1: LOCAL (AST parser, instant, free)
  Extension parses code and detects:
  - Language: JavaScript/TypeScript/Python/etc.
  - Concepts used: specific APIs, patterns, structures
  - Framework usage: React hooks, Express middleware, etc.
  - Complexity signals: nesting depth, function length, abstraction level
  
  This updates a LOCAL skill cache immediately.
  Batched to backend every 30 seconds.

Tier 2: AI (Claude API, deferred, costs money)
  Called only when local detection isn't enough:
  - Understanding quality: "did they use it correctly?"
  - Pattern recognition: "is this a design pattern?"
  - Misconception detection: "do they misunderstand how this works?"
  - Transfer assessment: "can they use it in different contexts?"
  
  Called: on save (debounced), during lessons, during reviews.

MASTERY SCORING:

  Score components (0.00 to 1.00):

  correctness    (0.40 weight) — did they use it right?
  independence   (0.25 weight) — without AI/copy-paste?
  consistency    (0.20 weight) — across multiple sessions?
  transfer       (0.15 weight) — in different contexts/projects?

  mastery_score = (correctness × 0.40) + (independence × 0.25) 
                + (consistency × 0.20) + (transfer × 0.15)

  Mastery levels:
  ┌─────────────┬────────────┬─────────────────────────────────────┐
  │ Level       │ Score      │ What it means                       │
  ├─────────────┼────────────┼─────────────────────────────────────┤
  │ Exposure    │ 0.00-0.20  │ Seen it, maybe used once with help  │
  │ Familiar    │ 0.20-0.40  │ Can use with guidance                │
  │ Functional  │ 0.40-0.60  │ Works independently, sometimes rough│
  │ Competent   │ 0.60-0.80  │ Reliable, used across contexts      │
  │ Expert      │ 0.80-1.00  │ Deep understanding, can teach others│
  └─────────────┴────────────┴─────────────────────────────────────┘

  Transfer states:
  - fragile → works in one learned context only
  - shaky   → inconsistent across contexts
  - stable  → reliable, handles variations
  - robust  → deep, transferable, can improvise

SKILL DECAY (Spaced Repetition):

  Each concept has a decay curve:
  
  decay_rate = base_rate × stability_modifier × usage_modifier
  
  base_rate by transfer state:
    fragile: 0.10/week (fast decay)
    shaky:   0.06/week
    stable:  0.03/week
    robust:  0.01/week (very slow decay)
  
  stability_modifier:
    times_used < 5:   1.5x (decays faster if barely used)
    times_used 5-20:  1.0x
    times_used > 20:  0.7x (well-practiced decays slower)
  
  usage_modifier:
    unique_projects = 1: 1.3x (only used in one context)
    unique_projects > 3: 0.8x (proven across projects)
  
  Grace period before decay starts:
    fragile: 7 days
    shaky:   14 days
    stable:  30 days
    robust:  90 days
  
  When a skill decays below its level threshold:
    1. Skill tree node changes to orange/pulsing glow
    2. Follow-up Queue gets a "skill-refresh" item
    3. Next session: "Your CSS Grid knowledge is fading — 
       quick 3-min refresher?"

CODE IQ CALCULATION:

  code_iq = Σ (concept_score × concept_weight) / max_possible × 1000
  
  Weights by concept type:
    Core language:     1.5x  (JS fundamentals, Python basics)
    Framework:         1.2x  (React, Express, Django)
    Tools:             1.0x  (Git, Docker, CI/CD)
    Architecture:      1.8x  (design patterns, system design)
    Testing:           1.3x  (unit tests, TDD)
    Security:          1.4x  (auth, XSS prevention, SQL injection)
  
  Sub-scores:
    Frontend IQ  = weighted average of frontend concepts
    Backend IQ   = weighted average of backend concepts
    DevOps IQ    = weighted average of devops concepts
    Testing IQ   = weighted average of testing concepts

LEARNING PATHS:

  A learning path = ordered sequence of concepts with dependencies.
  
  learning_paths (
    path_id, name, description, domain, difficulty,
    estimated_hours, concepts_sequence JSONB,
    prerequisites JSONB, created_by, is_public,
    times_completed, avg_completion_days,
    created_at, updated_at
  )
  
  Example:
  {
    "name": "React from Zero",
    "concepts_sequence": [
      { "concept": "HTML basics",       "estimated_min": 30 },
      { "concept": "CSS basics",        "estimated_min": 45 },
      { "concept": "JavaScript basics", "estimated_min": 120 },
      { "concept": "React components",  "estimated_min": 60 },
      { "concept": "Props & State",     "estimated_min": 60 },
      { "concept": "Hooks",             "estimated_min": 90 },
      { "concept": "API fetching",      "estimated_min": 45 }
    ],
    "prerequisites": [],
    "estimated_hours": 7.5
  }
  
  Paths are:
  - Pre-built by Protege (curated paths for common goals)
  - AI-generated (personalized based on gap analysis)
  - Community-created (users can publish paths that worked for them)
  - Shareable (protege.dev/path/react-from-zero)

GAP ANALYSIS:

  Input: user's concept_mastery + their stated goal
  Output: ranked list of missing/weak skills + recommended path
  
  Sources for "what skills are needed":
  - Curated skill maps per role (junior frontend, senior backend, etc.)
  - Job posting analysis (scrape requirements, map to concepts)
  - Peer comparison (what do other users at next level have?)
  - Target stack requirements (user wants to learn Next.js → needs React first)
```

### 2.4 Social Service

```
STREAKS:

  Solo streak:
    - Increments if user demonstrated improvement that day:
      - Used a concept correctly
      - Fixed a bug
      - Completed a challenge
      - Learned something new (new concept node created)
    - NOT just "opened VS Code" — must actually code meaningfully
    - Resets at midnight in user's timezone
    - 1 free freeze per week (earned by 7-day streak, not purchasable)
    
  Mutual streak:
    - Requires BOTH paired users to code that day
    - Either missing → both lose the streak
    - Badges: 7 days (bronze), 30 (silver), 100 (gold), 365 (diamond)
    - Both users earn the badge
    - Partner notification: "Alex coded today. Your turn."

  Storage:
    Redis: current streak state, freeze status (fast reads)
    PostgreSQL: streak history, badge records (permanent)

PAIRS (Learn Together):

  Pairing flow:
    1. User A generates invite link: protege.dev/pair/abc123
    2. User B clicks link → installs Protege (if needed) → accepts pair
    3. Both see shared dashboard in sidebar "Pair" tab
  
  Pair dashboard shows:
    - Mutual streak counter
    - Each person's activity today (coded/not yet)
    - Recent skills each person learned
    - "Your friend learned TypeScript Generics — want to learn it too?"
    - Nudge button (sends notification to partner)
    - Weekly paired report
  
  Pair suggestions:
    "You're strong in CSS (Lv 7), Alex is strong in APIs (Lv 6). 
     You could teach each other!"

CHALLENGES:

  Types:
  ┌─────────────┬──────────────────────────────────────────────────────┐
  │ Type        │ How it works                                        │
  ├─────────────┼──────────────────────────────────────────────────────┤
  │ Skill Race  │ "I completed React Hooks in 18 days. Beat me."      │
  │             │ Async — each person goes at their own pace.         │
  │             │ Winner = fastest to complete the learning path.     │
  ├─────────────┼──────────────────────────────────────────────────────┤
  │ Daily       │ Same problem for everyone, same time, timed.        │
  │ Challenge   │ 10-min limit. Ranked by skill level bracket.        │
  │             │ Shareable: "Today's Protege: solved in 2:14, top 20%│
  ├─────────────┼──────────────────────────────────────────────────────┤
  │ Group       │ A cohort (bootcamp, team, friends) races through    │
  │ Challenge   │ a learning path together. Shared leaderboard.       │
  │             │ One invite link for the whole group.                │
  └─────────────┴──────────────────────────────────────────────────────┘

  Challenge landing page (protege.dev/challenge/xyz):
    Shows: creator's name, challenge type, their time/score
    CTA: [Accept Challenge — Install Protege]
    This page IS the acquisition funnel for challenges.

BADGES:

  badges (
    badge_id, name, description, icon_url, category,
    requirement_type, requirement_value, rarity
  )
  
  user_badges (
    user_id, badge_id, earned_at
  )
  
  Badge categories:
  ┌──────────────┬──────────────────────────────────────────────────┐
  │ Category     │ Examples                                        │
  ├──────────────┼──────────────────────────────────────────────────┤
  │ Streaks      │ 7-day, 30-day, 100-day, 365-day                │
  │ Skills       │ First skill mastered, 10 skills, full branch   │
  │ Bugs         │ 10 bugs caught, 50, 100, 500                   │
  │ Challenges   │ First challenge won, 10 challenges, daily streak│
  │ Social       │ First pair, first challenge sent, 5 friends     │
  │ Milestones   │ Code IQ 100, 250, 500, 750, 1000              │
  │ Special      │ Early adopter, beta tester, path creator        │
  └──────────────┴──────────────────────────────────────────────────┘
  
  Badges appear on:
  - Skill tree (pinned to relevant nodes)
  - Public profile
  - Share cards
  - Unlockable VS Code themes:
    IQ 250  → "Protege Midnight" theme
    IQ 500  → "Protege Neon" theme
    IQ 750  → "Protege Aurora" theme
    IQ 1000 → "Protege Platinum" theme

DEVELOPER PERSONALITY TYPES:

  Detected from behavioral patterns over 2+ weeks:
  
  ┌─────────────────┬──────────────────────────────────────────────────┐
  │ Type            │ Detection Signal                                │
  ├─────────────────┼──────────────────────────────────────────────────┤
  │ The Architect   │ Reads code before editing, plans structure,     │
  │                 │ refactors early, low undo rate                  │
  ├─────────────────┼──────────────────────────────────────────────────┤
  │ The Sprinter    │ Ships fast, high edit velocity, refactors later,│
  │                 │ frequent commits                                │
  ├─────────────────┼──────────────────────────────────────────────────┤
  │ The Perfectionist│ Writes tests first, low bug rate, high code    │
  │                 │ quality, slow but thorough                      │
  ├─────────────────┼──────────────────────────────────────────────────┤
  │ The Explorer    │ Jumps between languages/frameworks, broad tree, │
  │                 │ many exposures, fewer masteries                 │
  ├─────────────────┼──────────────────────────────────────────────────┤
  │ The Specialist  │ Deep in one stack, narrow but tall tree,        │
  │                 │ many expert-level nodes in one branch           │
  └─────────────────┴──────────────────────────────────────────────────┘
  
  Shown on: public profile, Wrapped report, share cards
  Updated: monthly (personality evolves over time)

PUBLIC PROFILES (protege.dev/username):

  Renders:
  - Interactive skill tree (read-only for visitors)
  - Code IQ score + 6-month trend graph
  - Developer personality type with description
  - Top 5 skills + current learning focus
  - Badges earned
  - Streak record (longest solo + longest mutual)
  - Challenge results
  - Learning paths completed
  - "Currently learning: GraphQL" (auto-updated)
  
  OG meta tags for social preview:
  - Title: "Yura's Code IQ: 487 | Protege"
  - Image: auto-generated card showing skill tree snapshot
  - Description: "The Architect — strong in React, TypeScript, Node.js"
```

### 2.5 Content & Share Service

```
DAILY GRID:

  Generated: end of each coding session (or on demand)
  
  Text version (copy-paste):
  ┌──────────────────────────────┐
  │ Today's Protege              │
  │                              │
  │  TS  [======----] Lv 6       │
  │  CSS [========--] Lv 8  ▲    │
  │  API [===-------] Lv 3       │
  │                              │
  │  🐛 Bugs caught: 3           │
  │  🔥 Streak: 14               │
  │  🧠 Code IQ: 487 (+6)       │
  └──────────────────────────────┘
  
  Image version: beautiful dark card, rendered server-side
  Dimensions optimized for: Twitter, LinkedIn, Discord, iMessage

WEEKLY REPORT:

  Generated: every Sunday at user's preferred time
  
  Content:
  - Skills unlocked this week (with level changes)
  - Code IQ delta (+/- from last week)
  - Bug rate change ("23% fewer bugs than last week")
  - Most improved skill
  - Biggest opportunity (skill gap)
  - Streak status
  - Time spent coding
  - "This week's highlight: You used async/await correctly 
     in 3 different files without any help."
  
  Delivered: notification in VS Code + email (opt-in)
  Shareable: one-tap image card

WRAPPED (Quarterly + Yearly):

  Generated: end of quarter / year
  
  Multi-slide experience (like Spotify Wrapped):
  1. "Your [Quarter/Year] with Protege"
  2. Total stats (lines, hours, files, skills)
  3. Skill tree before/after animation
  4. "Your biggest glow-up" — most improved skill with before/after
  5. Bugs caught + hours saved estimate
  6. Developer personality type (with explanation)
  7. Percentile rankings ("top 15% in React")
  8. "Skills you discovered" — concepts you'd never touched before
  9. Year-over-year comparison (Year 2+)
  10. Summary card for sharing
  
  Delivered: special notification + full experience in sidebar
  Shareable: summary card optimized for each platform

BEFORE/AFTER TRANSFORMATION CARDS:

  Generated: at 3-month, 6-month, 12-month milestones
  
  Shows:
  - Skill tree on Day 1 (sparse, dark) vs. today (lit up)
  - Code sample from Month 1 vs. similar code now (with AI comparison)
  - Code IQ trajectory graph
  - "6 months ago you couldn't write a for loop. 
     Today you're building full-stack apps."
  
  This is the most viral artifact. Transformation stories are the #1 
  shared content type on the internet.

TIP CURATION ENGINE:

  Every tip shown to a user gets a reaction tracked:
  
  tip_deliveries (
    delivery_id, tip_id, user_id, shown_at,
    reaction: dismissed | paused | clicked | shared | applied_fix,
    pause_duration_sec, code_changed_after BOOLEAN
  )
  
  Impact score calculation:
    paused > 5s:        +3
    clicked to expand:  +5
    applied the fix:    +8
    shared the tip:     +15
    dismissed < 1s:     -3
    no reaction:        +0
  
  Aggregated impact_score on tip_catalog determines which tips 
  get promoted to more users at similar skill levels.
  
  High-impact tips (score > 50) → auto-added to "Best Tips" gallery
  on protege.dev → these tips drive organic traffic + installs.

CARD RENDERER:

  Server-side image generation for all share artifacts.
  
  Tech: @vercel/og (Satori) for simple cards, Puppeteer for complex ones
  Storage: Cloudflare R2 with CDN caching
  
  Design system:
  - Dark background (#0d1117)
  - Accent colors: green (#00ff88), blue (#58a6ff), orange (#ff7b00)
  - Font: JetBrains Mono (code feel)
  - Protege logo: bottom-right, small, subtle
  - Platform-optimized sizes:
    Twitter: 1200×628
    LinkedIn: 1200×627
    Discord: 1200×630
    iMessage: 1200×630
    Instagram Story: 1080×1920 (for Wrapped)
```

### 2.6 Notification Service

```
Notifications need to reach users OUTSIDE VS Code too.

CHANNELS:
  1. VS Code notification (when editor is open)
  2. System push notification (when editor is closed) — via OS native
  3. Email digest (opt-in, weekly summary)

NOTIFICATION TYPES:
  ┌───────────────────────────────┬──────────────┬────────────┐
  │ Notification                  │ Channel      │ Frequency  │
  ├───────────────────────────────┼──────────────┼────────────┤
  │ Streak at risk                │ Push + VS    │ 1x/day max │
  │ Partner coded (mutual streak) │ Push + VS    │ 1x/day     │
  │ Daily challenge available     │ Push + VS    │ 1x/day     │
  │ Skill unlocked                │ VS Code only │ On event   │
  │ Bug milestone                 │ VS Code only │ On event   │
  │ Weekly report ready           │ Push + Email │ 1x/week    │
  │ Challenge accepted by friend  │ Push + VS    │ On event   │
  │ Pair invite received          │ Push + VS    │ On event   │
  │ Skill decaying                │ VS Code only │ 1x/week    │
  │ Wrapped ready                 │ Push + Email │ Quarterly  │
  │ Follow-up prompt              │ VS Code only │ On session │
  └───────────────────────────────┴──────────────┴────────────┘

  RULES:
  - Max 2 push notifications per day (not counting VS Code inline)
  - User controls frequency: aggressive / balanced / quiet / off
  - "Quiet hours" setting (no notifications between 10pm-8am)
  - Smart timing: send streak reminder at user's usual coding time
  - Never notification-spam. NEVER. One annoying push = uninstall.
```

---

## Part 3: Database Schema

```sql
-- ==================== CORE ====================

users (
  user_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  github_id        VARCHAR(64) UNIQUE NOT NULL,
  username         VARCHAR(64) UNIQUE NOT NULL,
  display_name     VARCHAR(128),
  email            VARCHAR(255),
  avatar_url       TEXT,
  timezone         VARCHAR(64) DEFAULT 'UTC',
  notification_pref VARCHAR(32) DEFAULT 'balanced',
  quiet_hours_start TIME DEFAULT '22:00',
  quiet_hours_end   TIME DEFAULT '08:00',
  created_at       TIMESTAMP DEFAULT NOW(),
  updated_at       TIMESTAMP DEFAULT NOW()
);

-- ==================== LEARNING PROFILE ====================

learning_profile (
  user_id               UUID PRIMARY KEY REFERENCES users,
  experience_level      VARCHAR(32),
  current_role          VARCHAR(64),
  known_languages       JSONB DEFAULT '[]',
  known_frameworks      JSONB DEFAULT '[]',
  target_stack          JSONB DEFAULT '[]',
  learning_goals        JSONB DEFAULT '[]',
  preferred_difficulty  VARCHAR(32) DEFAULT 'adaptive',
  mentor_style          VARCHAR(64) DEFAULT 'coach',
  explanation_preference VARCHAR(32) DEFAULT 'short',
  response_preference   VARCHAR(32) DEFAULT 'hints-first',
  default_session_mode  VARCHAR(32) DEFAULT 'build',
  developer_personality VARCHAR(32),
  personality_updated_at TIMESTAMP,
  code_iq_overall       DECIMAL(6,2) DEFAULT 0,
  code_iq_frontend      DECIMAL(6,2) DEFAULT 0,
  code_iq_backend       DECIMAL(6,2) DEFAULT 0,
  code_iq_devops        DECIMAL(6,2) DEFAULT 0,
  code_iq_testing       DECIMAL(6,2) DEFAULT 0,
  code_iq_last_updated  TIMESTAMP,
  onboarding_completed  BOOLEAN DEFAULT FALSE,
  created_at            TIMESTAMP DEFAULT NOW(),
  updated_at            TIMESTAMP DEFAULT NOW()
);

-- ==================== SKILL TRACKING ====================

concept_mastery (
  concept_mastery_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID NOT NULL REFERENCES users,
  concept_name           VARCHAR(128) NOT NULL,
  concept_area           VARCHAR(128),
  parent_concept         VARCHAR(128),
  tree_path              VARCHAR(512),       -- "Web Dev > JavaScript > Arrays > map"
  mastery_level          VARCHAR(32) DEFAULT 'exposure',
  mastery_score          DECIMAL(5,2) DEFAULT 0.00,
  correctness_score      DECIMAL(5,2) DEFAULT 0.00,
  independence_score     DECIMAL(5,2) DEFAULT 0.00,
  consistency_score      DECIMAL(5,2) DEFAULT 0.00,
  transfer_score         DECIMAL(5,2) DEFAULT 0.00,
  understanding_modes    JSONB DEFAULT '[]',
  misconception_note     TEXT,
  transfer_state         VARCHAR(32) DEFAULT 'fragile',
  times_observed         INTEGER DEFAULT 0,
  times_failed           INTEGER DEFAULT 0,
  times_successful       INTEGER DEFAULT 0,
  times_used_without_ai  INTEGER DEFAULT 0,
  unique_projects_used   INTEGER DEFAULT 0,
  decay_rate             DECIMAL(4,3) DEFAULT 0.100,
  last_used_at           TIMESTAMP,
  last_mastery_change    TIMESTAMP,
  next_review_at         TIMESTAMP,
  created_at             TIMESTAMP DEFAULT NOW(),
  updated_at             TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, concept_name)
);

CREATE INDEX idx_mastery_user ON concept_mastery(user_id);
CREATE INDEX idx_mastery_decay ON concept_mastery(next_review_at) 
  WHERE next_review_at IS NOT NULL;

learning_behavior (
  user_id                      UUID PRIMARY KEY REFERENCES users,
  debugging_style              VARCHAR(64),
  reads_errors_carefully       BOOLEAN DEFAULT TRUE,
  verifies_output_consistently BOOLEAN DEFAULT FALSE,
  asks_for_hints_first         BOOLEAN DEFAULT TRUE,
  skips_explanations_often     BOOLEAN DEFAULT FALSE,
  ai_reliance_level            VARCHAR(32) DEFAULT 'medium',
  ai_reliance_areas            JSONB DEFAULT '[]',
  avg_undo_redo_cycles         DECIMAL(5,2) DEFAULT 0,
  avg_definition_jumps         DECIMAL(5,2) DEFAULT 0,
  avg_build_fail_loops         DECIMAL(5,2) DEFAULT 0,
  systematic_reasoning_score   DECIMAL(5,2) DEFAULT 0.50,
  productive_struggle_tolerance VARCHAR(32) DEFAULT 'medium',
  preferred_help_style         VARCHAR(32) DEFAULT 'short-hints',
  total_sessions               INTEGER DEFAULT 0,
  created_at                   TIMESTAMP DEFAULT NOW(),
  updated_at                   TIMESTAMP DEFAULT NOW()
);

project_context (
  project_context_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                    UUID NOT NULL REFERENCES users,
  project_name               VARCHAR(255),
  project_domain             VARCHAR(128),
  active_stack               JSONB DEFAULT '[]',
  active_concepts            JSONB DEFAULT '[]',
  friction_areas             JSONB DEFAULT '[]',
  repeated_failure_subsystems JSONB DEFAULT '[]',
  architecture_confusion_zones JSONB DEFAULT '[]',
  ai_heavy_areas             JSONB DEFAULT '[]',
  frequently_touched_files   JSONB DEFAULT '[]',
  last_active_file           VARCHAR(512),
  created_at                 TIMESTAMP DEFAULT NOW(),
  updated_at                 TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, project_name)
);

-- ==================== FOLLOW-UP SYSTEM ====================

followup_queue (
  followup_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users,
  item_type        VARCHAR(64) NOT NULL,
  title            VARCHAR(255),
  description      TEXT,
  related_concept  VARCHAR(128),
  related_project  VARCHAR(255),
  priority         VARCHAR(32) DEFAULT 'medium',
  status           VARCHAR(32) DEFAULT 'queued',
  trigger_source   VARCHAR(64),
  scheduled_for    TIMESTAMP,
  delivered_at     TIMESTAMP,
  completed_at     TIMESTAMP,
  created_at       TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_followup_pending ON followup_queue(user_id, status, scheduled_for)
  WHERE status = 'queued';

-- ==================== SOCIAL ====================

streaks (
  user_id          UUID NOT NULL REFERENCES users,
  streak_type      VARCHAR(32) NOT NULL,    -- solo / mutual
  pair_id          UUID REFERENCES pairs,
  current_count    INTEGER DEFAULT 0,
  longest_count    INTEGER DEFAULT 0,
  last_active_date DATE,
  freeze_available BOOLEAN DEFAULT TRUE,
  freeze_used_date DATE,
  created_at       TIMESTAMP DEFAULT NOW(),
  updated_at       TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, streak_type, COALESCE(pair_id, '00000000-0000-0000-0000-000000000000'))
);

pairs (
  pair_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_a               UUID NOT NULL REFERENCES users,
  user_b               UUID NOT NULL REFERENCES users,
  status               VARCHAR(32) DEFAULT 'pending',
  invite_url           VARCHAR(255) UNIQUE,
  created_at           TIMESTAMP DEFAULT NOW(),
  updated_at           TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_a, user_b)
);

challenges (
  challenge_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id       UUID NOT NULL REFERENCES users,
  challenge_type   VARCHAR(32) NOT NULL,
  title            VARCHAR(255),
  skill_path       VARCHAR(255),
  creator_time     INTEGER,          -- seconds or days depending on type
  max_participants INTEGER DEFAULT 100,
  share_url        VARCHAR(255) UNIQUE NOT NULL,
  status           VARCHAR(32) DEFAULT 'active',
  created_at       TIMESTAMP DEFAULT NOW(),
  expires_at       TIMESTAMP
);

challenge_participants (
  challenge_id UUID NOT NULL REFERENCES challenges,
  user_id      UUID NOT NULL REFERENCES users,
  started_at   TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP,
  time_taken   INTEGER,
  rank         INTEGER,
  PRIMARY KEY (challenge_id, user_id)
);

daily_challenges (
  challenge_date      DATE PRIMARY KEY,
  title               VARCHAR(255) NOT NULL,
  description         TEXT NOT NULL,
  difficulty          VARCHAR(32),
  starter_code        TEXT,
  test_cases          JSONB NOT NULL,
  concepts_tested     JSONB,
  created_at          TIMESTAMP DEFAULT NOW()
);

daily_challenge_submissions (
  challenge_date           DATE NOT NULL REFERENCES daily_challenges,
  user_id                  UUID NOT NULL REFERENCES users,
  solution                 TEXT,
  time_seconds             INTEGER,
  passed                   BOOLEAN,
  score                    DECIMAL(5,2),
  skill_bracket            VARCHAR(32),
  percentile_in_bracket    DECIMAL(5,2),
  submitted_at             TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (challenge_date, user_id)
);

badges (
  badge_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              VARCHAR(128) NOT NULL UNIQUE,
  description       TEXT,
  icon_url          TEXT,
  category          VARCHAR(64),
  requirement_type  VARCHAR(64),     -- streak_days / skills_mastered / bugs_caught / iq_reached / etc
  requirement_value INTEGER,         -- e.g., 100 for "100-day streak"
  rarity            VARCHAR(32)      -- common / uncommon / rare / legendary
);

user_badges (
  user_id    UUID NOT NULL REFERENCES users,
  badge_id   UUID NOT NULL REFERENCES badges,
  earned_at  TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, badge_id)
);

-- ==================== LEARNING PATHS ====================

learning_paths (
  path_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name               VARCHAR(255) NOT NULL,
  description        TEXT,
  domain             VARCHAR(128),
  difficulty         VARCHAR(32),
  estimated_hours    DECIMAL(5,1),
  concepts_sequence  JSONB NOT NULL,   -- ordered list of concepts with estimated times
  prerequisites      JSONB DEFAULT '[]',
  created_by         UUID REFERENCES users,  -- null = Protege-curated
  is_public          BOOLEAN DEFAULT FALSE,
  share_url          VARCHAR(255) UNIQUE,
  times_started      INTEGER DEFAULT 0,
  times_completed    INTEGER DEFAULT 0,
  avg_completion_days DECIMAL(6,1),
  rating             DECIMAL(3,2),
  created_at         TIMESTAMP DEFAULT NOW(),
  updated_at         TIMESTAMP DEFAULT NOW()
);

user_path_progress (
  user_id            UUID NOT NULL REFERENCES users,
  path_id            UUID NOT NULL REFERENCES learning_paths,
  status             VARCHAR(32) DEFAULT 'in_progress',
  current_step       INTEGER DEFAULT 0,
  started_at         TIMESTAMP DEFAULT NOW(),
  completed_at       TIMESTAMP,
  PRIMARY KEY (user_id, path_id)
);

-- ==================== CONTENT & SHARING ====================

share_cards (
  card_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users,
  card_type   VARCHAR(32) NOT NULL,
  image_url   TEXT,
  text_content TEXT,
  metadata    JSONB,
  created_at  TIMESTAMP DEFAULT NOW()
);

tip_catalog (
  tip_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  concept             VARCHAR(128),
  skill_level_target  VARCHAR(32),
  title               VARCHAR(255) NOT NULL,
  content             TEXT NOT NULL,
  code_before         TEXT,
  code_after          TEXT,
  language            VARCHAR(64),
  impact_score        DECIMAL(6,2) DEFAULT 0,
  times_shown         INTEGER DEFAULT 0,
  times_shared        INTEGER DEFAULT 0,
  times_surprised     INTEGER DEFAULT 0,
  created_at          TIMESTAMP DEFAULT NOW(),
  updated_at          TIMESTAMP DEFAULT NOW()
);

tip_deliveries (
  delivery_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tip_id            UUID NOT NULL REFERENCES tip_catalog,
  user_id           UUID NOT NULL REFERENCES users,
  reaction          VARCHAR(32),     -- dismissed / paused / clicked / shared / applied
  pause_duration_ms INTEGER,
  code_changed      BOOLEAN DEFAULT FALSE,
  shown_at          TIMESTAMP DEFAULT NOW()
);

-- ==================== ANALYTICS ====================

coding_sessions (
  session_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES users,
  project_name          VARCHAR(255),
  session_mode          VARCHAR(32),
  started_at            TIMESTAMP NOT NULL,
  ended_at              TIMESTAMP,
  duration_minutes      INTEGER,
  files_touched         INTEGER DEFAULT 0,
  lines_written         INTEGER DEFAULT 0,
  concepts_used         JSONB DEFAULT '[]',
  concepts_new          JSONB DEFAULT '[]',    -- first time for this user
  bugs_caught           INTEGER DEFAULT 0,
  interventions_shown   INTEGER DEFAULT 0,
  interventions_engaged INTEGER DEFAULT 0,
  interventions_dismissed INTEGER DEFAULT 0,
  ai_assists_used       INTEGER DEFAULT 0,
  challenges_completed  INTEGER DEFAULT 0
);

CREATE INDEX idx_sessions_user ON coding_sessions(user_id, started_at DESC);

-- ==================== BUGS CAUGHT TRACKING ====================

bugs_caught (
  bug_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users,
  session_id    UUID REFERENCES coding_sessions,
  bug_type      VARCHAR(64),      -- null_reference / missing_await / sql_injection / etc
  severity      VARCHAR(32),
  file_path     VARCHAR(512),
  line_number   INTEGER,
  concept       VARCHAR(128),
  caught_at     TIMESTAMP DEFAULT NOW()
);

-- Running counter cached in Redis, persisted daily to:
bugs_caught_milestones (
  user_id       UUID NOT NULL REFERENCES users,
  total_caught  INTEGER NOT NULL,
  milestone     INTEGER NOT NULL,   -- 10, 50, 100, 250, 500, 1000
  reached_at    TIMESTAMP DEFAULT NOW(),
  card_id       UUID REFERENCES share_cards,
  PRIMARY KEY (user_id, milestone)
);
```

---

## Part 4: Data Flow — Complete Session

```
INSTALL & ONBOARD (first time only)
│
├─→ Extension activates
├─→ Sidebar opens with greeting
├─→ 3-4 question conversational interview (AI Service)
├─→ Backend creates: users + learning_profile + learning_behavior
├─→ "Wow" moment: create first webpage (beginner) or scan project (experienced)
├─→ First concept_mastery row created
├─→ Skill tree shows first lit node
├─→ Onboarding complete. Extension now runs on every VS Code launch.
│
REGULAR SESSION
│
├─→ Extension activates on VS Code startup
│   ├─→ Load cached profile from local storage
│   ├─→ Authenticate (JWT, silent refresh)
│   ├─→ WebSocket connect
│   ├─→ Backend loads: profile, mastery, behavior, project, followups, streaks
│   ├─→ Status bar: streak, IQ, green dot
│   └─→ If pending followup:
│       └─→ Sidebar opens: "Yesterday you struggled with X. Quick review?"
│
├─→ USER CODES
│   │
│   ├─→ [CONTINUOUS] Code Observer collects events locally
│   │   └─→ Local pattern detection (undo cycles, pauses, etc.)
│   │   └─→ Local AST concept detection
│   │
│   ├─→ [ON SAVE, debounced 5s]
│   │   ├─→ Local Analyzer: diff check → skip if trivial
│   │   ├─→ If meaningful change:
│   │   │   ├─→ Local: rule-based bug detection (instant)
│   │   │   ├─→ Local: AST concept detection → update local skill cache
│   │   │   └─→ Remote: send diff + context to AI Service (debounced)
│   │   │       ├─→ AI returns: findings (bugs, tips, patterns)
│   │   │       ├─→ Behavior Service: should we show these? (budget check)
│   │   │       └─→ Extension renders approved hints
│   │   └─→ Skill Engine: update concept_mastery rows
│   │
│   ├─→ [EVERY 30s] Batch behavioral signals to backend
│   │   ├─→ Behavior Service: confirm patterns, check if intervention needed
│   │   └─→ If intervention decided → send to extension via WebSocket
│   │
│   └─→ [ON STUCK] User idle > 2min after error
│       └─→ Proactive: "I notice you've been stuck. Want a hint?"
│
├─→ SESSION ENDS (VS Code closes or 30min idle)
│   ├─→ coding_sessions row created with aggregated stats
│   ├─→ Skill Engine recalculates Code IQ
│   ├─→ Streak check: did user improve today? → update streak
│   ├─→ Badge check: any milestones reached?
│   ├─→ Daily grid generated → share_cards table
│   ├─→ Follow-up Queue: schedule reviews for struggled concepts
│   ├─→ Bugs caught counter updated
│   ├─→ If milestone reached → generate milestone card + notification
│   ├─→ If mutual streak → notify partner: "Yura coded today"
│   └─→ Flush remaining local events to backend
│
├─→ DAILY (background jobs)
│   ├─→ Skill decay calculation for all users (batch job)
│   ├─→ Daily challenge generation (AI, one per day)
│   ├─→ Streak reset check at midnight per timezone
│   └─→ Streak reminder push notifications (if user hasn't coded)
│
├─→ WEEKLY (Sunday)
│   ├─→ Weekly reports generated for all active users
│   ├─→ Email digest sent (opt-in)
│   ├─→ Streak freeze reset (new freeze available)
│   └─→ Learning behavior profile updated (rolling averages)
│
└─→ QUARTERLY / YEARLY
    ├─→ Wrapped generated
    ├─→ Developer personality recalculated
    ├─→ Before/after transformation cards generated
    └─→ Push notification + email: "Your Wrapped is ready!"
```

---

## Part 5: Tech Stack

```
EXTENSION:
  Language:      TypeScript (strict mode)
  Extension API: VS Code Extension API
  UI:            React 19 + Tailwind (in Webview panels)
  Local Parse:   Tree-sitter WASM (multi-language AST parsing)
  State:         Zustand (in webview) + ExtensionContext (persistent)
  Bundler:       esbuild (fast, small output)
  Distribution:  VS Code Marketplace + Open VSX Registry

BACKEND:
  Language:      TypeScript (Node.js 22+, shared types with extension)
  Framework:     Hono (lightweight, fast, edge-ready) or Fastify
  AI:            Anthropic SDK (@anthropic-ai/sdk)
                   Haiku → classification, summaries
                   Sonnet → teaching, analysis, lessons
                   Opus  → architecture reviews (rare, expensive)
  Database:      PostgreSQL 16 (Neon serverless to start)
  Cache:         Redis (Upstash serverless)
  Queue:         BullMQ on Redis (decay jobs, reports, notifications)
  Auth:          GitHub OAuth → JWT (jose library)
  WebSocket:     Hono WebSocket or ws library
  Storage:       Cloudflare R2 (share card images)
  Image Gen:     @vercel/og (Satori) for cards
  Hosting:       Railway (start) → Fly.io (scale)
  
WEB APP (protege.dev):
  Framework:     Next.js 15 (App Router)
  Styling:       Tailwind CSS
  Skill Tree:    D3.js or react-force-graph
  OG Images:     @vercel/og
  Hosting:       Vercel
  Analytics:     PostHog

INFRASTRUCTURE:
  CI/CD:         GitHub Actions
  Monitoring:    Sentry (errors) + PostHog (product analytics)
  CDN:           Cloudflare
  Domain:        protege.dev via Cloudflare
  Email:         Resend (transactional) or Loops (marketing)

COST OPTIMIZATION:
  AI calls:      ~5-10/hour/user via smart routing
  Database:      Neon free tier → Pro at scale
  Redis:         Upstash free tier → Pro at scale
  Hosting:       Railway hobby plan ($5/mo) to start
  Storage:       R2 free tier (10GB) to start
  Total MVP:     ~$50-100/month for first 1000 users
```

---

## Part 6: Three Modes (Implementation)

### LEARN Mode
```
Trigger: beginner user, or any user says "teach me X"
Active UI: sidebar chat (primary) + inline annotations + skill tree

Lesson flow:
1. User or Protege picks a topic (from gap analysis or user choice)
2. AI generates micro-lesson (3-5 steps, each 2-5 minutes)
3. Each step:
   a. Protege creates/modifies a real file in workspace
   b. Highlights key code with CodeLens annotations
   c. Explains concept in sidebar chat (short, specific)
   d. Removes some code: "Your turn — write the useState hook"
   e. User writes code
   f. Local analyzer checks immediately (instant feedback)
   g. If correct: "Nice! Now run it and see what happens"
   h. If wrong: "Almost — look at the parameter order. Try again"
   i. User runs → sees result → Protege connects code to output
4. After lesson: update concept_mastery, schedule follow-up
5. Skill tree node progresses (satisfying animation)

Teaching principles enforced in AI prompt:
- Never give the answer first — ask the user to think
- "What do you THINK will happen?" before revealing
- Connect to what they already know
- One concept at a time, never overwhelm
- Celebrate genuine understanding, not just correct syntax
```

### BUILD Mode
```
Trigger: experienced user coding their own project (default mode)
Active UI: status bar + inline hints (sparse) + chat on demand

Protege is a silent guardian:
1. Code Observer watches everything
2. Local analyzer catches obvious bugs instantly (no delay)
3. AI analysis runs on meaningful saves (debounced, budget-limited)
4. Only shows hints that pass the intervention threshold:
   - Bugs/security: ALWAYS (these prevent production issues)
   - Performance: if > 2x improvement available
   - "Did you know" tips: max 1-2 per session, only high-impact
5. User can always open chat: "Hey Protege, why isn't this working?"
6. End of session: "While you were coding, I noticed 2 things 
   I didn't interrupt you for. Want to see?" (deferred insights)
```

### MASTER Mode
```
Trigger: advanced user (IQ > 700) or explicit request
Active UI: architect-level analysis, challenges, code review

Features exclusive to Master mode:
1. Cross-file architecture analysis (not just single-file bugs)
   - "Your auth logic is scattered across 4 files — here's a cleaner structure"
   - "This module has 12 responsibilities — consider splitting it"
2. Design pattern recognition and suggestions
   - "This is a good candidate for the Strategy pattern"
   - "You're reinventing the Observer pattern — here's the standard approach"
3. Performance profiling hints
   - "These 3 sequential API calls could be parallelized with Promise.all"
   - "This component re-renders 47 times — here's why"
4. Weekly advanced challenges at the EDGE of their skill level
5. Code review mode: submit any file/PR for senior-engineer-level review
6. Tech radar: "Based on your stack, consider migrating to X — here's why"
7. System design discussions: "Your app is scaling. Here are 3 bottlenecks"
```

---

## Part 7: Privacy & Trust

```
PRINCIPLE: Code is sacred. Users must trust Protege completely.

DATA TIERS:
  Tier 1 (Local only, never leaves machine):
    - Full file contents
    - Keystroke-level events
    - Raw undo/redo history
    
  Tier 2 (Sent to backend, processed, not stored permanently):
    - Code diffs (for AI analysis) — deleted after processing
    - File names and line numbers
    
  Tier 3 (Stored on backend):
    - Skill scores and mastery levels (no code)
    - Behavioral patterns (aggregated, not raw)
    - Session statistics
    - User profile and preferences
    
  Tier 4 (Public, user-controlled):
    - Skill tree (if profile is public)
    - Code IQ score
    - Badges and achievements
    - Developer personality type

USER CONTROLS:
  - Code sharing: off / metadata only / diffs for analysis / full files
  - Profile visibility: private / friends / public
  - Notifications: aggressive / balanced / quiet / off
  - AI analysis: on save / on demand / off
  - Data export: full export anytime (GDPR)
  - Account delete: removes everything, irreversible
  - Pair visibility: partner sees activity, never code

SECURITY:
  - All data encrypted in transit (TLS 1.3)
  - Code diffs encrypted at rest, auto-deleted after 24h
  - JWT tokens with short expiry (1h) + refresh tokens
  - GitHub OAuth — no password storage
  - Rate limiting on all endpoints
  - No code used for AI training — ever
  - SOC 2 compliance target for enterprise tier
```
