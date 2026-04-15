# Architecture Weak Spots — Round 2 (Deeper Issues)

Round 1 caught infrastructure and scaling problems. This round catches the problems that would kill the PRODUCT — bad user experience, wrong business model, teaching failures, and competitive risk.

---

## 16. AI Hallucination in Teaching Context is Catastrophic

**The problem:** If Protege teaches something WRONG, it's worse than not teaching at all. A wrong mental model is harder to unlearn than no model. Examples:
- "== and === are the same in JavaScript" (wrong, and now baked into user's brain)
- "You don't need error handling for async functions" (dangerous)
- "This code is safe for production" (when it has a SQL injection)

This is the #1 existential risk for an AI teaching product. One viral screenshot of Protege teaching something wrong = reputation destroyed.

**The fix: Teaching safety net with 3 layers**

```
LAYER 1: VERIFIED KNOWLEDGE BASE (highest priority)

  For core concepts (the ones beginners learn), don't generate
  explanations on the fly. Use a curated, human-reviewed knowledge base.
  
  verified_explanations (
    concept        VARCHAR(128) PRIMARY KEY,
    explanation    TEXT NOT NULL,          -- human-reviewed, correct
    common_mistakes JSONB,                -- known misconceptions to avoid
    reviewed_by    VARCHAR(128),
    reviewed_at    TIMESTAMP
  )
  
  AI prompt rule: "For core concepts, use the verified explanation. 
  Only generate novel explanations for advanced/niche topics."
  
  Coverage target: top 200 concepts = covers 80% of beginner interactions.
  These 200 explanations are hand-written and technically reviewed.

LAYER 2: SELF-CHECK ON GENERATED CONTENT

  For any AI-generated teaching content (not from the verified base):
  
  Before showing to user:
    1. Quick validation pass: does this contradict the verified base?
       (fast, pattern-matching, no extra API call)
    2. For code suggestions: run a lightweight check
       - Does the suggested code parse? (AST check, instant)
       - Does it match the language version? (no ES2025 features for beginners)
    3. Flag uncertainty: if the AI says "I think" or "probably", 
       add a disclaimer: "I'm not 100% sure — verify this"

LAYER 3: COMMUNITY CORRECTION LOOP

  If a user spots an error in Protege's teaching:
    - "Report wrong info" button on every explanation
    - Report goes to a review queue
    - If 3+ users report the same concept → auto-flag, reduce confidence
    - Reviewed by team → fix the verified base if needed
    - Notify users who received wrong info: "Correction: I told you X, 
      but actually Y. Sorry about that — here's the right explanation."
    
  This builds trust. Products that correct themselves are MORE trusted
  than products that pretend to be perfect.
```

---

## 17. The Freemium Model Is Backwards

**The problem:** The current plan gives Learn Mode free and charges for Build + Master. But Learn Mode uses the MOST AI calls (interactive lessons, constant back-and-forth). Free users would be the most expensive. Meanwhile, Build Mode (where experienced devs live) uses fewer AI calls but is behind a paywall — these are the users most likely to pay AND cheapest to serve.

**The fix: Restructure the tiers**

```
FREE TIER:
  - Full code analysis (bugs, security, performance) — always free
    This is the hook. Catches real bugs. Users depend on it.
  - Basic skill tracking + Code IQ score — always free
    This is the identity anchor. Users won't give this up.
  - Daily grid + sharing — always free
    This is the viral engine. Never gate viral features behind pay.
  - 3 AI mentor chats per day — enough to taste it, not enough to rely on
  - 1 learning path active at a time
  - Solo streaks
  - Daily challenge (view + attempt, no detailed analytics)

PRO ($15/month):
  - Unlimited AI mentor chat
  - Unlimited active learning paths
  - Full skill tree with decay tracking + gap analysis
  - Weekly reports + Wrapped
  - "Did you know" tips (the dopamine hits)
  - Mutual streaks + Learn Together pairs
  - Challenges (create + participate)
  - Priority AI analysis (faster responses)
  - Unlockable VS Code themes

TEAM ($25/dev/month):
  - Everything in Pro
  - Team skill map + manager dashboard
  - Team challenges + onboarding paths
  - Usage analytics + training recommendations
  - SSO / admin controls

WHY THIS WORKS:
  - Free tier is genuinely useful (bug detection + basic IQ)
  - Free tier drives virality (daily grid, sharing, profiles)
  - Free tier is CHEAP to run (bugs caught locally, 3 AI chats/day)
  - Pro tier has the addictive features (streaks, pairs, full tree)
  - Conversion trigger: user hits 3-chat limit when they NEED help
    → "Upgrade to keep talking" → this converts at the moment of 
    highest motivation
```

---

## 18. Cold Start Problem for Social Features

**The problem:** Mutual streaks, challenges, daily leaderboards, "Learn Together" — all need OTHER users. First 1000 users have nobody to pair with. The social features feel dead. Empty leaderboards are depressing.

**The fix: Design for single-player first, multiplayer as upgrade**

```
SINGLE-PLAYER (works with 1 user, no community needed):
  - Solo streaks ← fully functional alone
  - AI mentor ← just you and the AI
  - Skill tree ← personal progress
  - Daily grid ← shareable even without other users
  - Code analysis ← core value, no network needed
  - Learning paths ← AI-generated, personalized
  
  These features are 100% of the MVP. They work on day 1 with 0 other users.

MULTIPLAYER (unlocks as user base grows):
  Phase 1 (100 users): 
    Mutual streaks + pair invites
    These only need 2 people. Users invite their own friends.
    Don't require any existing user base.
  
  Phase 2 (1,000 users):
    Challenges with leaderboards
    Now there are enough people to make leaderboards interesting.
    But show brackets by skill level so it's not 5 people total.
  
  Phase 3 (10,000 users):
    Daily challenge with global ranking
    Community learning paths
    Public tip gallery
    Now there's critical mass for these to feel alive.

FILL THE VOID EARLY:
  - Daily challenge leaderboard with < 50 users? 
    Show it as "Your result: solved in 2:14" without the leaderboard.
    "Leaderboard unlocks when 100+ people participate."
  - Skill comparison with no friends? 
    Compare against anonymized aggregate: "average beginner at month 3"
  - Pair feature with no partner?
    "Invite a friend to learn together" — the feature IS the invitation.
    Don't show an empty pair dashboard.

NEVER show an empty social feed. Either fill it with useful content
or hide the feature until there's enough activity to make it feel alive.
```

---

## 19. The Skill Tree Could Be Demotivating for Beginners

**The problem:** A beginner opens the skill tree and sees 200+ dark nodes. One tiny lit node. Their reaction: "I know NOTHING. This is overwhelming. I'll never fill this." The tree that should motivate them DEMOTIVATES them.

**The fix: Progressive tree reveal**

```
INSTEAD OF: showing the entire tree from day 1

USE: fog-of-war approach (like a video game map)

Beginner sees:
  ┌──────────────────────────────────────┐
  │  Your Skill Tree        IQ: 12      │
  │                                      │
  │       ┌─────────┐                    │
  │       │  HTML    │                    │
  │       │ ██░░░░░ │                    │
  │       │  Lv 2   │                    │
  │       └────┬────┘                    │
  │       ┌────┴────┐                    │
  │       │  CSS    │                    │
  │       │ ░░░░░░░ │                    │
  │       │  Lv 0   │                    │
  │       └─────────┘                    │
  │                                      │
  │       ╌╌╌╌╌╌╌╌╌╌╌                   │
  │       ? more skills                  │
  │         unlock as                    │
  │         you learn                    │
  │       ╌╌╌╌╌╌╌╌╌╌╌                   │
  │                                      │
  │  "Focus on HTML for now.             │
  │   More skills appear as you grow."   │
  └──────────────────────────────────────┘

Reveal rules:
  - Show only: skills you've used + their direct children + prerequisites
  - A node becomes visible when its parent reaches Level 2+
  - "Coming soon" teaser for the next tier (1 level deep fog)
  - Full tree view available via toggle: "Show full tree (advanced)"
    but default is the focused view

Why this works:
  - Beginner sees 2-5 nodes, not 200 → manageable, not overwhelming
  - Each new node appearing feels like a DISCOVERY, not a reminder of ignorance
  - Mimics game design: fog-of-war makes exploration exciting
  - The tree literally GROWS as you learn → visual progress
  - Advanced users can toggle to full view when they want it

ALSO: rename "unexplored" nodes.
  BAD:  "JavaScript: Level 0 — Unexplored" (feels like failure)
  GOOD: "JavaScript: Ready to discover" (feels like opportunity)
```

---

## 20. Extension Performance Could Kill the Product

**The problem:** The extension includes Tree-sitter WASM + React webviews + SQLite + real-time code observation + WebSocket client. VS Code extensions that slow down the editor get uninstalled within hours. If typing gets laggy, game over.

**The fix: Strict performance budget**

```
PERFORMANCE TARGETS:
  Extension activation: < 500ms (VS Code shows slow extensions)
  Typing latency added: < 5ms (imperceptible)
  Memory overhead: < 100MB
  Extension bundle size: < 5MB
  Save-to-hint latency: < 200ms (local), < 2s (AI-backed)

HOW TO HIT THESE:

1. LAZY LOADING
   Don't load everything on activation.
   
   Immediate (activation):
     - Status bar items
     - Code Observer (lightweight event listeners)
     - WebSocket connection
     
   Deferred (first use):
     - Skill tree webview (only when opened)
     - SQLite database (only when first event needs persistence)
     - React sidebar (only when chat opened)
     - Tree-sitter (only when first save triggers analysis)

2. CODE OBSERVER IS READ-ONLY
   The observer MUST NEVER modify the editor or interfere with typing.
   
   - Use onDidChangeTextDocument with { passive: true } equivalent
   - Process events asynchronously (setTimeout, requestIdleCallback)
   - NEVER block the editor thread
   - If processing is slow, DROP events rather than queue endlessly

3. AI CALLS ARE NON-BLOCKING
   - All API calls happen in a web worker or separate thread
   - UI shows results when ready, doesn't freeze waiting
   - If AI is slow, local results show first, AI results update later
   - Cancel in-flight requests if user keeps editing (debounce)

4. WEBVIEW PERFORMANCE
   - Skill tree: use Canvas/WebGL, not DOM nodes (SVG chokes at 200+ nodes)
   - Virtualize chat messages (don't render 1000 messages, only visible ones)
   - Preload webview HTML, inject data via postMessage (don't reload iframe)

5. BUNDLE SIZE CONTROL
   - Tree-sitter WASM: ~2MB (load only needed language grammars)
   - React + UI: ~500KB (preact or minimal build)
   - SQLite WASM: ~800KB
   - Extension logic: ~200KB
   - Total: ~3.5MB (well under 5MB target)
   - Use dynamic imports: load Python grammar only when Python file opened

6. MONITORING
   - Track extension activation time (VS Code reports slow extensions publicly)
   - Track memory usage over time (detect leaks)
   - Alert if typing latency exceeds 10ms
   - User-facing: "Protege is using X MB" in settings (transparency)
```

---

## 21. Teaching Feedback Loop is Missing

**The problem:** Protege explains something. Did the user actually understand? The architecture tracks WHETHER they engaged (clicked, dismissed, paused) but not WHETHER THE TEACHING WORKED. If Protege explains `useEffect` and the user says "ok" but then misuses it 5 minutes later — the teaching failed, but Protege doesn't know.

**The fix: Teaching effectiveness tracking**

```
AFTER every teaching intervention, track:

teaching_outcomes (
  outcome_id       UUID PRIMARY KEY,
  user_id          UUID REFERENCES users,
  concept          VARCHAR(128),
  intervention_id  UUID,
  teaching_type    VARCHAR(64),     -- hint / explanation / lesson / challenge
  delivered_at     TIMESTAMP,
  
  -- Short-term outcome (within 30 minutes)
  concept_used_correctly_after    BOOLEAN,
  same_mistake_repeated           BOOLEAN,
  asked_followup_question         BOOLEAN,
  
  -- Medium-term outcome (within 7 days)
  concept_used_independently      BOOLEAN,   -- without AI help
  concept_used_in_new_context     BOOLEAN,
  mastery_score_change            DECIMAL(5,2),
  
  evaluated_at     TIMESTAMP
)

HOW IT WORKS:
  1. Protege teaches "always use await with res.json()"
  2. Start watching: does the user do it correctly next time?
  
  Within same session:
    - User writes res.json() without await again → teaching FAILED
      → Try a DIFFERENT approach: "Let me explain this differently..."
      → Log: same_mistake_repeated = true
    
    - User writes await res.json() correctly → teaching PROBABLY worked
      → Log: concept_used_correctly_after = true
  
  Within next 7 days:
    - User uses await correctly in a different file → CONFIRMED learning
      → Log: concept_used_in_new_context = true
      → Bump mastery score
    
    - User makes the same mistake again → teaching was SHALLOW
      → Schedule a follow-up with a different explanation approach

ADAPTIVE TEACHING STYLE:
  Track which teaching approaches work for THIS user:
  
  teaching_style_effectiveness (
    user_id          UUID,
    teaching_style   VARCHAR(64),   -- hint / analogy / code_example / step_by_step / visual
    times_used       INTEGER,
    times_effective  INTEGER,       -- led to correct usage after
    effectiveness_rate DECIMAL(5,2),
    PRIMARY KEY (user_id, teaching_style)
  )
  
  If short hints work 80% of the time for this user → use hints.
  If hints fail but step-by-step works 90% → switch to step-by-step.
  
  AI prompt gets: "This user learns best from code examples (78% effective)
  and poorly from analogies (23% effective). Use code examples."
  
  This makes Protege genuinely adaptive per user — not just in WHAT 
  it teaches but HOW it teaches.
```

---

## 22. Competitive Moat is Thinner Than We Think

**The problem:** GitHub Copilot has 1.8M+ paying users and full editor integration. If Microsoft adds a "Learning" tab to Copilot tomorrow — skill tracking, tips, streaks — they have instant distribution to millions. Cursor could do the same. What's Protege's defensible advantage?

**The fix: Identify and double down on what's HARD to copy**

```
WHAT'S EASY TO COPY (don't rely on these as your moat):
  ✗ AI code analysis — everyone has this already
  ✗ Inline hints — Copilot, Cursor, every linter does this
  ✗ Chat with AI about code — every AI tool does this
  ✗ Basic skill tracking — a weekend project for any team

WHAT'S HARD TO COPY (build your moat here):

  1. THE BEHAVIORAL ENGINE
     Protege doesn't just read code — it reads BEHAVIOR.
     Undo/redo cycles, definition jumps, build-fail loops, 
     long pauses, file bouncing, paste patterns.
     
     This is a YEAR of R&D to get right. The pattern detection,
     the interpretation, the decision of when to intervene and when
     to stay silent — this is Protege's secret sauce.
     
     Copilot doesn't track behavior. It responds to requests.
     Protege anticipates needs. That's fundamentally different.

  2. LONGITUDINAL SKILL DATA
     After 6 months, Protege knows:
     - Every concept you've ever used
     - How your mastery changed over time
     - Your learning style
     - Your blind spots and misconceptions
     - Your decay patterns
     - Which teaching approaches work for you
     
     This data is irreplaceable. Switching to Copilot Learning
     means starting from zero. The switching cost grows every month.

  3. THE SOCIAL GRAPH OF LEARNERS
     Mutual streaks, pairs, challenges, group paths.
     Social features have network effects — your friends are on Protege.
     Moving to a competitor means losing your pairs, your streaks, 
     your challenge history.
     
     Microsoft could build social features, but they can't move YOUR
     friends to their platform.

  4. CODE IQ AS IDENTITY
     If Code IQ becomes how developers identify their skill level —
     on resumes, GitHub profiles, LinkedIn — that's a standard.
     Standards are nearly impossible to displace once adopted.
     
     FICO score wasn't the best credit score. It was the FIRST one
     that everyone adopted. Protege's Code IQ needs to be that.

  5. COMMUNITY CONTENT
     Community-created learning paths, curated tip libraries, 
     shared transformation stories — this is user-generated content
     that only exists on Protege. Can't be copied.

STRATEGIC PRIORITY:
  Focus engineering time on #1 (behavioral engine) and #2 (longitudinal data).
  These are the technical moats.
  
  Focus marketing on #4 (Code IQ as standard).
  This is the network effect moat.
  
  Don't waste time on things that Copilot already does better
  (autocomplete, code generation). Protege is a MENTOR, not an autocompleter.
```

---

## 23. No Graceful Onboarding Recovery

**The problem:** User installs Protege. Sidebar pops up. They're in the middle of something. They close it. They never come back. Onboarding abandoned. User churns.

Or: user answers 2 of 4 questions, gets distracted, closes VS Code. Next day they open it and... what? Start over? Continue mid-question?

**The fix: Persistent, non-blocking onboarding**

```
PRINCIPLES:
  - Onboarding is NOT a gate. The product works without completing it.
  - Onboarding can be paused and resumed at any point.
  - If the user ignores onboarding, Protege learns from their code instead.

FLOW:

  First install:
    Sidebar opens → greeting → first question
    
  If user closes sidebar:
    Status bar shows: "Protege ● (Setup: 1/4)"
    Product still works in basic mode (local analysis, no personalization)
    Next time user opens sidebar: "Welcome back! Two more quick questions?"
    
  If user never completes onboarding:
    After 3 coding sessions, Protege has enough behavioral data to infer:
    - Experience level (from code complexity, speed, error rate)
    - Languages/frameworks (from file types and imports)
    - Learning style (from how they interact with hints)
    
    Protege creates a profile silently and says:
    "I've been watching you code. Looks like you're intermediate-level,
     working with React and TypeScript. Am I close?"
    [Yes] [Adjust] 
    
    This replaces the onboarding. No questions needed.
    
  If user starts onboarding but closes VS Code mid-way:
    Save progress to local storage.
    Next VS Code launch: resume exactly where they left off.
    "Hey, we were in the middle of getting to know each other. 
     One more question!"

ANTI-FRICTION RULE:
  Onboarding should NEVER block access to the product.
  Even a first-time user with zero profile should be able to:
  - See inline bug hints (local analysis, no profile needed)
  - Use the skill tree (starts empty, fills as they code)
  - See their status bar (streak = 0, IQ = 0)
  
  The onboarding makes it BETTER, not POSSIBLE.
```

---

## 24. Daily Challenge Could Become a Chore

**The problem:** Wordle worked because it was one puzzle, took 3 minutes, and you could fail gracefully (6 tries). If Protege's daily challenge feels like homework — mandatory, stressful, time-consuming — people will DREAD it instead of looking forward to it.

**The fix: Design for delight, not obligation**

```
RULES FOR DAILY CHALLENGES:

1. IT'S OPTIONAL
   Never make the user feel bad for skipping.
   No "You missed today's challenge!" guilt notifications.
   Just: "Today's challenge is ready if you want it."

2. IT'S SHORT
   Maximum 5 minutes, not 10. Shorter = more people attempt.
   If they can't solve it in 5 min, show the solution with explanation.
   "Here's how to solve it — you learned something either way."

3. IT HAS MULTIPLE DIFFICULTY LEVELS
   Same problem, 3 levels:
   - Warm-up: solve with hints visible
   - Standard: solve independently
   - Expert: solve with an added constraint (performance, no built-ins, etc.)
   
   User picks their level. No shame in picking Warm-up.

4. FAILING IS FINE
   Don't show "FAILED" in red. Show:
   "You got 70% of the way there. Here's the part you missed."
   
   Track: did the user learn something? (teaching_outcome)
   A "failed" challenge where the user learned something = success.

5. STREAK IS SEPARATE
   Daily challenge streak is separate from coding streak.
   Missing the challenge doesn't break your coding streak.
   It's a bonus game, not a requirement.

6. THE RESULT IS ALWAYS SHAREABLE
   Even a "failed" attempt:
   "Today's Protege Challenge: 70% in 3:42"
   This is still shareable because it shows you TRIED.
   
   Wordle grids often show failures. People share those too.
   Vulnerability is shareable.

7. MAKE IT FUN
   Challenges should have a tiny twist or surprise:
   - "Solve this WITHOUT using any loops"
   - "Make this pass all tests in the fewest characters"
   - "Find the 3 bugs hidden in this function"
   - "Refactor this from 20 lines to under 8"
   
   Novelty prevents routine boredom.
```

---

## 25. Cost Could Kill You Before Scale Saves You

**The problem:** Even with smart routing (5-10 AI calls/hour/user), at the Sonnet price point this is expensive. Let's do the math:

```
1,000 free users, each coding 3 hours/day:
  Conservative: 5 calls/hour × 3 hours × 1,000 users = 15,000 calls/day
  ~2,000 input tokens + ~500 output tokens per call (with caching)
  
  Input:  15,000 × 2,000 = 30M tokens/day = 900M tokens/month
  Output: 15,000 × 500   = 7.5M tokens/day = 225M tokens/month
  
  Sonnet pricing: $3/M input (with caching), $15/M output
  
  Monthly cost: (900 × $3) + (225 × $15) = $2,700 + $3,375 = ~$6,000/month
  
  FOR 1,000 FREE USERS. Revenue: $0.

  At 10,000 free users: ~$60,000/month. Still $0 revenue from free tier.
```

**The fix: Aggressive cost control for free tier**

```
FREE TIER AI BUDGET:

  3 AI mentor chats per day (not per hour)
  BUT code analysis stays unlimited because:
    → Most bug detection is LOCAL (no API call)
    → AI code analysis only for complex issues
    → Cache identical bug explanations across users
    
  Actual free-tier AI calls per user per day:
    3 chat messages = 3 calls
    ~2 code analysis calls (only meaningful, complex changes)
    ~1 session summary call
    = ~6 calls/day max
    
  Cost per free user: ~6 × 2,500 tokens × 30 days = 450K tokens/month
  At cached Sonnet rates: ~$2.50/user/month
  
  1,000 free users = $2,500/month ← manageable

ADDITIONAL COST LEVERS:

1. USE HAIKU AGGRESSIVELY
   Most free-tier interactions don't need Sonnet quality:
   - Bug explanation for common bugs → Haiku ($0.80/M input, $4/M output)
   - Concept classification → Haiku
   - Session summary → Haiku
   - Only complex explanations → Sonnet
   
   Haiku for 70% of calls: cuts cost by ~60%
   Free tier effective cost: ~$1/user/month

2. RESPONSE CACHING
   "Missing await on res.json()" ← this explanation is the SAME for everyone.
   Cache it. Don't regenerate it 10,000 times.
   
   Cache key: {bug_type}:{language}:{user_level}
   Hit rate estimate: 30-40% (common bugs are common)
   
   Cost savings: ~30%

3. BATCH PROCESSING
   Don't analyze every save individually.
   Collect 3-5 saves, analyze the diff from first to last.
   Same teaching output, 3-5x fewer API calls.
   
   User doesn't notice: the 5-second debounce already covers this.

4. PROGRESSIVE AI UPGRADE
   Free: mostly Haiku + cached + local analysis
   Pro: Sonnet for teaching, Haiku for classification
   Team: Sonnet everywhere, Opus for architecture reviews
   
   Pro user paying $15/month with ~$3-4/month AI cost = healthy margin.

REVISED COST MODEL:
  Free user:  ~$1.00/month AI cost   (mostly Haiku + cache)
  Pro user:   ~$4.00/month AI cost   (Sonnet, $15/month revenue = 73% margin)
  Team user:  ~$6.00/month AI cost   ($25/month revenue = 76% margin)
  
  Break-even: ~15% conversion rate from free to Pro
  Industry average for dev tools: 5-10%
  Need the free product to be SO good that conversion exceeds average.
```

---

## 26. No Way to Measure if the Product Actually Works

**The problem:** The whole promise of Protege is "you become a better developer." But how do you PROVE that? To users (retention), to investors (fundraising), and to yourself (product decisions). "Code IQ went up" is circular — you defined the metric.

**The fix: External validation signals**

```
INTERNAL METRICS (things we control):
  - Code IQ trajectory (our own score)
  - Bug rate over time (are they making fewer mistakes?)
  - AI reliance trend (are they relying on AI less over time?)
  - Concept breadth and depth (skill tree growth)
  
EXTERNAL METRICS (things that prove it in the real world):
  
  1. BUG RATE IN REAL CODE
     Track: bugs caught by Protege per 1000 lines written.
     If this goes DOWN over time, the user is actually writing better code.
     "Your bug rate dropped from 4.2/1000 lines to 1.8/1000 lines in 6 months."
     THIS is provable improvement.
  
  2. SPEED OF CORRECT CODE
     Track: time between opening a file and producing working code.
     If this goes down for similar complexity tasks, productivity improved.
  
  3. INDEPENDENCE RATIO
     Track: % of concepts used without AI help vs. with AI help.
     If this goes UP, the user is becoming genuinely self-sufficient.
     "6 months ago you used AI help for 60% of React code. 
      Now it's 15%. You're doing this on your own."
  
  4. RECOVERY TIME
     Track: how long it takes to fix an error after it appears.
     Faster recovery = better debugging skills.
  
  5. CONCEPT TRANSFER
     Track: when a user applies a concept learned in Project A to Project B
     without prompting. This is TRUE learning, not memorization.

SHOW THESE TO THE USER:
  In weekly reports and Wrapped:
  "Objective proof you're getting better:
   - 56% fewer bugs per 1000 lines (vs. 6 months ago)
   - 40% faster at writing working async code
   - 85% of React code written independently (was 40%)
   - Recovery time from errors: 3 min average (was 12 min)"

SHOW THESE TO INVESTORS:
  "Our users' bug rate drops 40% in 6 months. Their AI dependency
   drops 60%. These are objective, measurable improvements in code quality."

SHOW THESE TO ENTERPRISE BUYERS:
  "Teams using Protege ship 30% fewer bugs and onboard new developers 
   2x faster. Here's the data."
```

---

## 27. Accessibility is Completely Missing

**The problem:** Skill tree visualization, color-coded hints (red/yellow/blue), glowing animations, progress bars — none of this works for users with visual impairments, color blindness, or who use screen readers. ~8% of men have color-vision deficiency.

**The fix: Accessibility from the start**

```
COLOR BLINDNESS:
  - Never use color as the ONLY signal
  - Red/green hints → also use icons: ⚠ (warning), ✗ (error), ℹ (tip)
  - Skill tree levels → also show text labels, not just color fills
  - Progress bars → also show percentage text
  - Offer high-contrast theme option
  - Test all share cards with color blindness simulators

SCREEN READERS:
  - All webview content must have proper ARIA labels
  - Skill tree: provide list view alternative (not just visual tree)
  - Chat messages: proper semantic HTML
  - Status bar items: descriptive text (not just "🔥14" but "14-day streak")
  - Inline hints: registered as proper VS Code diagnostics (screen reader compatible)

KEYBOARD NAVIGATION:
  - All webview features navigable via keyboard
  - Skill tree: arrow keys to navigate nodes, Enter to expand
  - Chat: standard text input behavior
  - Tab order makes logical sense

MOTION SENSITIVITY:
  - Respect VS Code's "reduce motion" setting
  - Skill tree animations → static state transitions
  - Unlock celebrations → text-only notification
  - Daily grid → no animated counters

IMPLEMENTATION:
  - Use VS Code's built-in theme tokens (automatically adapts to high contrast themes)
  - Test with VS Code's screen reader mode (built-in)
  - WCAG 2.1 AA compliance target for all webviews
```

---

## Summary: Round 2 Fixes

| # | Weak Spot | Risk Level | Fix |
|---|-----------|-----------|-----|
| 16 | AI hallucination in teaching | Critical | Verified knowledge base + self-check + community corrections |
| 17 | Freemium model is backwards | Critical | Free = bug detection + basic IQ (cheap). Pro = unlimited AI + social (revenue) |
| 18 | Cold start for social | High | Single-player first. Social features unlock progressively with user count |
| 19 | Skill tree overwhelms beginners | High | Fog-of-war: only show relevant nodes, reveal as they grow |
| 20 | Extension could be slow | High | Strict perf budget: <5ms typing impact, lazy loading, Canvas not DOM |
| 21 | No teaching feedback loop | High | Track teaching outcomes. Adapt teaching style per user |
| 22 | Moat is thinner than we think | Strategic | Double down on behavioral engine + longitudinal data + Code IQ as standard |
| 23 | Onboarding drop-off | Medium | Non-blocking onboarding. Works without it. Infer profile from code if skipped |
| 24 | Daily challenge = homework | Medium | Optional, short (5 min), multiple difficulty, failing is fine |
| 25 | Cost kills before scale saves | Critical | Haiku for free tier, response caching, batch processing. $1/user/month free tier |
| 26 | Can't prove the product works | Strategic | Track external metrics: bug rate, independence ratio, recovery time |
| 27 | Accessibility missing | Medium | Color-blind safe, screen reader support, keyboard nav, reduce motion |
