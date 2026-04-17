# Code IQ — The Plan to Make It GOATED

## What Code IQ Is Today

A number 0–1000 that measures how many coding concepts you've used, weighted by difficulty, decayed by time, penalized by bugs. Honest, but shallow.

**Current formula:**
```
IQ = round( Σ ( weight[c] × mastery(timesUsed) × decay(daysSinceUse) × quality(bugFlags) ) × K )
K = 1000 / totalWeight
mastery(t) = 1 - exp(-t / 5)        → 63% @ 5 uses, 95% @ 15 uses
decay(d) = max(0.3, 1 - d / 60)     → drops to 30% after 60 idle days
quality(f) = max(0.4, 1 - f * 0.1)  → 10% penalty per buggy save, floor 40%
```

**What's missing:** depth, breadth, velocity, consistency, code quality signal, peer context, career mapping, and the emotional reward loop that makes users obsess over it.

---

## The Vision: Code IQ as a Living Intelligence Score

Code IQ should feel like a **credit score for your engineering brain** — one number that captures everything about how you code, learn, and grow. It should be:

1. **Multi-dimensional** — not just "how many concepts did you use" but "how deep, how broad, how fast, how clean, how consistent"
2. **Career-aware** — maps to real-world engineering levels (Junior → Mid → Senior → Staff → Principal)
3. **Emotionally rewarding** — every save should either teach you something or reward you for something
4. **Impossible to game** — quality gates, recency requirements, file-diversity checks, anti-patterns
5. **Socially meaningful** — percentile vs peers, team leaderboards, skill badges on profiles

---

## 10 Prompts to Build It

### Prompt 1: The Five Pillars of Code IQ

> Rewrite the Code IQ formula from a single weighted-sum to a **five-pillar composite score**:
>
> ```
> Code IQ = f(Depth, Breadth, Velocity, Consistency, Quality) × Level_Multiplier
> ```
>
> **Depth** (0–250): How deeply do you know the skills you use?
> - For each detected skill: mastery curve × weight × difficulty_tier
> - Expert-level skills (mastery > 0.8, distinctFiles ≥ 3, recent) contribute 3× more than familiar ones
> - Skills used in complex contexts (higher cyclomatic complexity, larger files, more imports) get a "context bonus"
>
> **Breadth** (0–200): How many different domains and clusters have you touched?
> - Count of distinct domains with ≥3 detected skills
> - Bonus for cross-domain connections (e.g., you use React AND write tests for it → synergy bonus)
> - Penalty for being one-dimensional (90% of skills in one domain → breadth score capped at 60%)
>
> **Velocity** (0–200): How fast are you learning new things?
> - First-time concepts per week (trailing 4-week average)
> - Skills advancing from Familiar → Functional → Competent → Expert per month
> - "Learning streak" multiplier: 7+ consecutive days with at least one new concept → 1.2×
>
> **Consistency** (0–200): Do you code regularly and maintain your skills?
> - Coding streak (consecutive days with saves)
> - Decay-adjusted average — skills that would decay but you keep using them count as consistency
> - Session regularity — bonus for daily coding, penalty for binge-then-ghost patterns
>
> **Quality** (0–150): Is the code you write actually good?
> - Inverse of bug density (findings per 100 lines) across recent saves
> - Fix-rate: how quickly do you resolve findings after they're flagged?
> - Clean-save rate: percentage of saves with zero findings
> - Penalty for recurring same-type bugs (you keep making the same mistake)
>
> **Level Multiplier**: Maps the raw composite (0–1000) to an engineering level (see Prompt 2).
>
> Files to change:
> - `packages/types/src/concepts.ts` — add the 5 pillar types + composite formula
> - `apps/backend/src/store.ts` — compute pillars in `getUserSnapshot`
> - `apps/backend/src/routes/me.ts` — include pillars in MeResponse

---

### Prompt 2: Engineering Levels + Titles

> Define **8 engineering levels** that map to Code IQ ranges. Each level has:
> - A title (Novice → Beginner → Apprentice → Intermediate → Advanced → Expert → Master → Legend)
> - A Code IQ threshold
> - Requirements beyond just the number (minimum breadth, minimum quality, etc.)
> - A visual badge / ring color
>
> ```
> Level       IQ Range    Requirements
> ─────────────────────────────────────────────────────────
> Novice      0–99        (none)
> Beginner    100–199     ≥3 detected skills
> Apprentice  200–349     ≥2 domains touched, quality ≥ 50
> Intermediate 350–549    ≥3 domains, breadth ≥ 80, streak ≥ 3
> Advanced    550–749     ≥5 domains, ≥1 Expert skill, quality ≥ 90
> Expert      750–899     ≥7 domains, ≥3 Expert skills, velocity ≥ 120
> Master      900–969     ≥10 domains, ≥5 Experts, all pillars ≥ 150
> Legend      970–1000    Top 1% globally, all pillars near-max
> ```
>
> Each level-up triggers:
> - A milestone event (+ bonus IQ)
> - A cinematic toast notification with the new title
> - The ring gauge on the dashboard updates color + animation
> - The status bar shows the new title
>
> Files: `packages/types/src/concepts.ts`, `apps/backend/src/milestones.ts`, `apps/backend/src/store.ts`

---

### Prompt 3: Skill Depth Score — Context-Aware Detection

> Upgrade concept detection from "did you use this keyword?" to "HOW did you use it?":
>
> 1. **Simple usage** (1× credit): `useState()` called with a primitive
> 2. **Standard usage** (1.5× credit): `useState()` with an object + proper typing
> 3. **Advanced usage** (2.5× credit): `useState()` inside a custom hook with memoization
> 4. **Expert usage** (3× credit): A custom hook that composes useState + useEffect + useRef with cleanup
>
> Implementation: after regex detection fires, run a **context analyzer** that reads ±20 lines around the match and scores it by:
> - Number of related concepts nearby (composing hooks = high)
> - Nesting depth (inside a function inside a class inside a module = higher)
> - Type annotations present (typed = higher)
> - Error handling present (try/catch wrapping the usage = higher)
> - Test file importing the same function (detected skill is tested = bonus)
>
> This makes the Depth pillar real: a user who writes `useState(0)` once gets some credit, but a user who builds a complex custom hook with proper types, cleanup, and tests gets 3× more.
>
> Files: `apps/extension/src/concepts/detector.ts` (add context scorer), `packages/types/src/concepts.ts` (add `contextScore` to ConceptMeta)

---

### Prompt 4: Cross-Domain Synergy Bonus

> Detect when a user demonstrates skills from MULTIPLE domains in the same file/project and award a **synergy bonus** to their Breadth pillar:
>
> ```
> Synergy pairs (bonus IQ multiplier):
> React + TypeScript generics       → 1.15×
> async/await + Error handling       → 1.1×
> CSS Grid + Responsive design      → 1.1×
> Node.js API + Authentication      → 1.2×
> React + Testing Library           → 1.25×  (testing what you build!)
> TypeScript + Zod/Pydantic         → 1.15×  (runtime + static validation)
> Docker + CI/CD                    → 1.2×
> SQL + ORM                         → 1.1×
> ```
>
> For each pair where both sides are detected in the user's recent code, apply the multiplier to their Breadth score. This rewards full-stack thinking, not just language collection.
>
> Also detect **anti-synergies** (penalty):
> - Lots of React but zero testing → Breadth penalty
> - Backend skills but zero security concepts → flag as a gap
> - High velocity but low quality → flag as rushing
>
> Files: `apps/backend/src/store.ts` (synergy computation), `packages/types/src/concepts.ts` (synergy types)

---

### Prompt 5: Velocity Tracking + Learning Streaks

> Add a **velocity engine** that tracks how fast the user is acquiring new skills:
>
> 1. **New concept rate**: first-time detections per week (trailing 4-week rolling average)
> 2. **Level-up rate**: how many skills advanced a mastery level (Familiar→Functional, etc.) per month
> 3. **Exploration rate**: how many new DOMAINS did they touch this month (first concept in a new domain is special)
>
> Store: add `velocityLog: { week: string, newConcepts: number, levelUps: number, newDomains: number }[]` per user.
> Updated on every `recordConcepts` call.
>
> Velocity score = weighted average of rates × streak multiplier:
> ```
> velocity = (newConceptRate × 40 + levelUpRate × 35 + explorationRate × 25) × streakMultiplier
> streakMultiplier = min(1.5, 1 + streak / 30)
> ```
>
> UI: show a "velocity sparkline" on the dashboard (like GitHub's contribution graph intensity).
>
> Files: `apps/backend/src/store.ts`, `packages/types/src/index.ts` (VelocityInfo type), ConceptsDashboard

---

### Prompt 6: Quality Score — Bug Density + Fix Rate

> Build a real quality signal from the analyzer's findings:
>
> 1. **Bug density**: `findings / linesScanned` over the last 30 days of saves
> 2. **Fix rate**: when a finding is flagged and the same file is saved later with that finding gone → track as a fix. `fixes / totalFindings` = fix rate
> 3. **Clean save rate**: percentage of saves that had ZERO findings
> 4. **Recurring bug penalty**: if the same `finding.type + finding.title` appears 3+ times across different files → penalty (you're not learning from your mistakes)
>
> Store: add `qualityLog: { date: string, filesSaved: number, totalLines: number, findings: number, fixes: number, cleanSaves: number }[]`
>
> Quality score = `cleanSaveRate * 60 + fixRate * 50 + (1 - bugDensity) * 40 - recurringPenalty`
>
> Show on the dashboard as a "Code Health" gauge — green (>120), yellow (80-120), red (<80).
>
> Files: `apps/backend/src/store.ts`, `apps/extension/src/analyzer.ts` (track fix events)

---

### Prompt 7: Skill Constellation V2 — Connected Intelligence Map

> Rebuild the skill constellation from a random scatter into a **structured intelligence map**:
>
> 1. **Career spine**: a central vertical axis with 8 level milestones (Novice at bottom, Legend at top). The user's current position is marked with a glowing dot.
> 2. **Domain branches**: each domain radiates outward from the spine as a branch. The length/brightness of the branch = how many skills are detected in that domain.
> 3. **Skill nodes on branches**: each detected skill is a node on its domain branch. Size = mastery. Color = domain color. Glow = recency.
> 4. **Synergy arcs**: curved lines connecting skills from different domains that have synergy bonuses. The arc glows brighter = stronger synergy.
> 5. **Gap markers**: dim, pulsing nodes for skills the system recommends learning next. Click → "Teach me about X".
> 6. **Zoom levels**: zoomed out = see the whole tree. Zoomed in = see individual skills with labels and mastery bars.
>
> This makes the constellation meaningful: you can literally SEE your growth as a tree that branches outward and upward, with connections between domains showing your full-stack capability.
>
> Files: `apps/extension/webview/SkillConstellation.tsx` (rewrite layout engine)

---

### Prompt 8: Daily IQ Breakdown — "Where Did My Points Come From?"

> Add a **daily IQ audit** that explains exactly what contributed to the user's score today:
>
> ```
> Today's Code IQ: 487 (+12 from yesterday)
>
> Depth:       182/250  (+3)  — used useEffect with cleanup in 2 new files
> Breadth:     124/200  (+2)  — first Python skill detected this week
> Velocity:    89/200   (+5)  — 3 new concepts today (above average)
> Consistency: 61/200   (+1)  — 8-day streak, keep going!
> Quality:     31/150   (+1)  — fix rate improved 68% → 72%
>
> Top gain:     "React useEffect cleanup" → first Expert-level skill! +25 bonus
> Biggest gap:  Quality — 7 recurring bugs across 3 files this week
> Suggestion:   "Fix the useEffect dependency warnings in auth.ts — that alone would push Quality to 45"
> ```
>
> Store: compute this breakdown on every `/me` call. Return as `iqBreakdown: { pillar, score, maxScore, delta, explanation }[]` in MeResponse.
>
> UI: new "IQ Breakdown" card on the Concepts dashboard. Each pillar gets a horizontal bar + explanation.
>
> Files: `apps/backend/src/store.ts`, `packages/types/src/index.ts`, `ConceptsDashboard.tsx`

---

### Prompt 9: Anti-Gaming Measures

> Prevent users from inflating their Code IQ with cheap tricks:
>
> 1. **Content hash dedup** ✅ (already done) — re-saving identical content earns nothing
> 2. **File-size minimum**: files under 5 lines don't earn concepts (prevents creating dummy files)
> 3. **Copy-paste detection**: if 90%+ of a file matches a known snippet/template, reduce mastery credit by 80%
> 4. **Velocity cap**: no more than 20 new concepts per day (prevents mass-importing every pattern in one file)
> 5. **Cross-project isolation**: skills detected in `node_modules/` or `dist/` don't count
> 6. **Review mode**: if the same user saves the same file 10+ times in an hour with no substantive changes, stop recording
> 7. **Decay is mandatory**: even with constant use, mastery decays by 5% per month minimum. No permanent Expert status — you have to keep coding.
>
> Files: `apps/backend/src/store.ts` (add gates to `recordConcepts`)

---

### Prompt 10: Peer Percentile + Anonymous Leaderboard

> Add a **percentile rank** so users know where they stand:
>
> 1. Backend: on `/me`, compute `percentile: number` by comparing the user's Code IQ against all users in the store
> 2. Add `peerAvgIq: number` — the median IQ across all users with ≥10 concepts
> 3. Add `topConceptsByPeer: string[]` — what are the most common Expert-level concepts across all users?
> 4. Add `userRankInDomain: Record<string, { rank: number, total: number }>` — "You're #3 in React among 47 users"
>
> UI: "Your rank" card on the Concepts dashboard:
> ```
> You're in the top 18% of Protege users
> IQ 487 · Peer avg 312
> #3 in React · #12 in TypeScript · #47 in Testing (room to grow!)
> ```
>
> Anonymous — no names, just numbers. But seeing "top 18%" is deeply motivating.
>
> For MVP: compute against the JSON store. For production: aggregate via Supabase across all users.
>
> Files: `apps/backend/src/store.ts`, `packages/types/src/index.ts`, `ConceptsDashboard.tsx`

---

### Prompt 11: IQ Prediction — "What If I Learn X?"

> Add a **prediction engine** that shows the user what their IQ WOULD be if they learned a specific skill:
>
> ```
> "If you master TypeScript generics (+25 IQ), your Code IQ would be 512 (Advanced)"
> "Learning 3 more React hooks would push you past Intermediate"
> "Your biggest IQ gain opportunity: fix the 7 recurring bugs in your quality log (+18 quality points)"
> ```
>
> Compute by running the IQ formula with a hypothetical additional skill at full mastery, then diffing against current.
>
> UI: each recommended skill in the "Next to learn" section shows the predicted IQ delta.
> The "IQ Breakdown" card shows "biggest opportunity" for each pillar.
>
> Files: `apps/backend/src/store.ts` (add `predictIqDelta(conceptName)` function)

---

### Prompt 12: Skill Graph — Prerequisites + Learning Paths

> Add **prerequisite edges** to the skill taxonomy so the constellation shows actual learning paths:
>
> ```json
> { "id": "react-useReducer", "prerequisites": ["react-useState", "js-reduce"] }
> { "id": "ts-conditional", "prerequisites": ["ts-generics", "ts-type-alias"] }
> { "id": "react-custom-hook", "prerequisites": ["react-useState", "react-useEffect"] }
> ```
>
> ~200 prerequisite edges across the 1,395 skills. Not every skill needs one — just the ones with clear learning dependencies.
>
> Impact:
> 1. Constellation draws prerequisite arcs (dimmer than synergy arcs, dashed)
> 2. "Next to learn" recommendations prioritize skills whose prerequisites are already mastered
> 3. Skills with unmet prerequisites show a lock icon + "Learn X first" tooltip
> 4. Completing all prerequisites for a skill → unlock animation
>
> Files: `skills-taxonomy.json` (add `prereqs` field), `SkillTreeView.tsx` (show locks), `store.ts` (filter recommendations by prereqs)

---

### Prompt 13: Achievement System V2 — Badges + Showcase

> Expand milestones into a full **badge/achievement system**:
>
> Categories:
> - **Progression**: First concept, 10/50/100/200 concepts, each level-up
> - **Streaks**: 3/7/14/30/60/100-day streaks
> - **Mastery**: First Expert, 3/5/10 Expert skills, first Expert in each domain
> - **Quality**: 50/100/200 clean saves, 90%+ fix rate for a month
> - **Exploration**: First skill in 3/5/10/15/20 domains, first cross-domain synergy
> - **Teaching**: Asked Protege 10/50/100 questions, used "Teach me more" 20 times
> - **Speed**: 5 new concepts in one day, 20 in one week, fastest to Intermediate
> - **Special**: "Night Owl" (coded past midnight 7 times), "Polyglot" (skills in 5+ languages), "Bug Hunter" (fixed 50 findings)
>
> Each badge has:
> - An icon (inline SVG, themed to the category)
> - A rarity tier: Common (40%+ of users), Rare (10-40%), Epic (<10%), Legendary (<1%)
> - IQ bonus: Common +5, Rare +15, Epic +30, Legendary +50
>
> UI: "Badges" tab in the Concepts view. Unlocked badges glow. Locked ones are greyed with progress bars.
> Profile overlay shows top 6 badges as a "showcase".
>
> Files: `milestones.ts` (expand), `ConceptsDashboard.tsx` (badges tab), `ProfilePage.tsx` (showcase)

---

### Prompt 14: Real-Time IQ Ticker

> Make Code IQ feel **alive** — update in real-time as the user codes:
>
> 1. **On every save**: the IQ number in the status bar and header chip animates to the new value (count-up animation, like a score in a game)
> 2. **On concept detection**: a small "+N" floats up from the IQ chip (like damage numbers in a game)
> 3. **On level-up**: the ring gauge on the dashboard fills with a radial sweep animation + the level title changes with a scale-up animation
> 4. **On milestone unlock**: a cinematic toast slides in with the badge icon, title, and bonus IQ
> 5. **Daily summary**: first open of the day shows "Yesterday's IQ: 475 → Today: 487 (+12)" with a sparkline
>
> The IQ should feel like a heartbeat — always moving, always reflecting what you just did.
>
> Files: `App.tsx` (animation states), `styles/` (keyframes), `extension.ts` (status bar animation)

---

### Prompt 15: Code IQ API + Public Profile

> Build a `/api/profile/:userId` endpoint that returns a **public-safe** subset of Code IQ data:
>
> ```json
> {
>   "username": "yura",
>   "codeIq": 487,
>   "level": "Intermediate",
>   "topDomains": ["React", "TypeScript", "Node.js"],
>   "expertSkills": ["useState", "async/await", "TypeScript generics"],
>   "streakDays": 8,
>   "badges": ["polyglot", "night-owl", "first-expert"],
>   "percentile": 18,
>   "joinedAt": "2026-04-01"
> }
> ```
>
> This enables:
> - **Shareable profile cards**: generate an SVG/PNG badge that users can embed in READMEs
> - **GitHub integration**: a GitHub Action that posts your Code IQ in PR descriptions
> - **Portfolio page**: `protege.studio/u/yura` shows your skill constellation publicly
>
> Files: new `apps/backend/src/routes/profile.ts`, badge SVG generator

---

### Prompt 16: The IQ Dashboard — Visual Masterpiece

> Redesign the Concepts tab's dashboard to be a **single-screen view** that tells the full Code IQ story:
>
> ```
> ┌─────────────────────────────────────────────┐
> │  ╭─────╮                                    │
> │  │ 487 │  INTERMEDIATE    ▸ 63 to Advanced  │
> │  │ ○○○ │  ━━━━━━━━━━━━━━▸                   │
> │  ╰─────╯  8-day streak 🔥  Top 18%          │
> ├─────────────────────────────────────────────┤
> │ DEPTH    ████████████░░░░░░░░  182/250 (+3) │
> │ BREADTH  ██████████░░░░░░░░░░  124/200 (+2) │
> │ VELOCITY ████████░░░░░░░░░░░░   89/200 (+5) │
> │ CONSIST  ██████░░░░░░░░░░░░░░   61/200 (+1) │
> │ QUALITY  ████░░░░░░░░░░░░░░░░   31/150 (+1) │
> ├─────────────────────────────────────────────┤
> │ TRAJECTORY  [7D] [30D] [90D] [1Y] [ALL]    │
> │ ╱‾‾‾‾‾‾‾‾╲___╱‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾╱           │
> │╱                               ╱            │
> ├─────────────────────────────────────────────┤
> │ SKILL TREE  [Search...] [All levels ▼] [⛶] │
> │ ▸ JavaScript        12/136  ████░░         │
> │ ▸ React              8/70   ███░░░         │
> │ ▸ TypeScript          4/80   ██░░░░         │
> ├─────────────────────────────────────────────┤
> │ NEXT TO LEARN                               │
> │ • TypeScript generics  (+25 IQ predicted)   │
> │ • React useReducer     (+18 IQ predicted)   │
> │ • Array.reduce         (+12 IQ predicted)   │
> ├─────────────────────────────────────────────┤
> │ BADGES  ★★★☆☆  (3/24 unlocked)             │
> │ [Polyglot] [First Expert] [Week Streak]     │
> └─────────────────────────────────────────────┘
> ```
>
> Every widget is live, interactive, and tells a story. The user should be able to look at this screen for 10 seconds and understand: where they are, how they got here, and where to go next.
>
> Files: `ConceptsDashboard.tsx` (full rewrite), `styles/concepts.css`

---

## Implementation Order

```
Phase 1 — The Foundation (Prompts 1-2)
  Five pillars + engineering levels. This changes the number
  from "concept count" to "intelligence score". Everything else
  builds on this.

Phase 2 — Earn It (Prompts 3-6)
  Context-aware detection + synergy + velocity + quality.
  The score becomes real — it reflects how you ACTUALLY code,
  not just what keywords you typed.

Phase 3 — See It (Prompts 7-8, 14, 16)
  Constellation V2 + daily breakdown + real-time ticker +
  dashboard redesign. The score becomes visible and alive.

Phase 4 — Grow It (Prompts 9, 11-12)
  Anti-gaming + predictions + prerequisite paths. The score
  becomes a growth engine — it tells you WHERE to go next.

Phase 5 — Share It (Prompts 10, 13, 15)
  Percentile + badges + public profiles. The score becomes
  social — it means something to other people.
```

Each prompt is one session. 16 sessions × ~2 hours = ~32 hours of implementation. The system goes from "concept counter" to "the most sophisticated coding intelligence score in the world."
