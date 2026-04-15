# Protege — Hybrid Intelligence Plan

> The division of labor between **rules**, **local LLM**, and **Claude**. How the 24/7 watcher notices stuck moments, decides whether to nudge, and escalates only when it matters.

---

## 1. The vision in one paragraph

Protege is always on. Every keystroke, every save, every error, every pause feeds an **ambient watcher** running entirely on-device. The watcher catches real moments worth intervening on — a bug that's been on screen for 12 seconds, a pattern of 6 undos in 20 seconds, a file the user's been staring at for 90 seconds without typing. Most of these are handled locally in milliseconds for zero cost. When the watcher sees something that actually needs explanation or teaching, **it escalates to Claude**. Claude gets called ~10-20x per day instead of ~200x. Quality of the teaching moments is unchanged, but the experience gains **constant presence** — the "mentor sitting next to you" feeling.

---

## 2. The three layers and what each handles

### Layer 1 — Rules (extension-local, no LLM, instant)

Everything that's computable from events and state. Zero latency, zero cost, always available, no model download. **This is the biggest unlock per hour of work.**

| Task | How |
|---|---|
| Concept detection (save → IQ) | Tree-sitter AST patterns |
| Error persistence timer | `onDidChangeDiagnostics` + timestamps |
| Undo cluster detection | `onDidChangeTextDocument` + content versions |
| Stare-pause detection | `onDidChangeTextEditorSelection` + idle timer |
| Build-fail loop detection | Consecutive analyzer responses with errors |
| Win detection | Error count dropped to 0 after having > 0 + concept gained |
| Flow detection | 5+ clean saves in 3 minutes |
| Commit-risk detection | git dirty file count vs test file touches |
| Late-night marathon | Clock + session duration |
| File-touch history | Session-level ring buffer |
| Behavior-based mood | Rule combinations → `flow | frustrated | winning | confused | neutral` |
| Nudge cooldown / trust budget | Per-trigger state map |
| Session ritual (morning greeting timing) | Last-active timestamp |
| Template-based nudge wording | `templates/nudges.ts` with trigger → phrase map |

### Layer 2 — Local LLM (embedded, ~400MB-1GB, free, private)

Handles the tasks where rules aren't smart enough but Claude is overkill.

| Task | Why local is enough |
|---|---|
| Polishing nudge wording (from template → natural phrasing) | Small model is fine; we don't need genius prose |
| Intent classification (debugging vs learning vs building) | Classification problem, easy for any decent LM |
| Short behavior summary ("you've been on App.tsx for 22 min — want a hand?") | Template + 1B param polishing |
| Quick "what does this line do?" Q&A | 1.5B coder model covers ~75% of these well |
| Session end summary generation | Low-stakes paragraph |
| Memory triage: "is this fact worth remembering?" | Binary classification |
| Confidence score for escalation decision | Simple scoring |

Default model: **SmolLM2-360M** (Phase 1, ~250MB) → **Qwen2.5-Coder-1.5B** (Phase 2, ~900MB).

### Layer 3 — Claude Sonnet 4.5 (cloud, paid, maximum quality)

Only the hard stuff that matters for learning.

| Task | Why Claude |
|---|---|
| Teaching a concept through user's own code | Nuance, taste, cross-referencing |
| Multi-step debugging with reasoning | Real deduction |
| Code edits with architectural awareness | Matching user style, avoiding regressions |
| Building new features from a spec | Multi-file coordination |
| Deep code review with tradeoffs | Judgment + taste |
| Unprompted proactive teaching (when watcher escalates) | We want this to be *good*, not just *present* |
| Session-ritual morning greeting (uses yesterday's memory) | Warmth + specificity |

---

## 3. The trigger catalogue (Phase 0 — pure rules)

These fire automatically based on passive observation. Each has: detection logic, threshold, cooldown, action, escalation condition.

### T1 — `error_persists` (the flagship)
**Detection:** a VS Code diagnostic of severity Error has been present at the same line for > 10 seconds without being cleared.
**Threshold:** 10s (configurable)
**Cooldown:** 60s per file
**Local action:** short nudge via template: *"That [error_message] on line [N] has been hanging around. Want me to look at it?"*
**Escalation:** if user clicks → Claude takes the file + error + surrounding code → teaches the fix inline
**Rationale:** this is the exact scenario you described — the one that separates "present" from "absent".

### T2 — `struggle_cluster`
**Detection:** 5+ undos within 20 seconds OR save → error → edit → save → error pattern 3 times
**Cooldown:** 120s
**Local action:** *"Looks like you're going back and forth. Want to talk through it?"*
**Escalation:** on click, Claude gets the last 3 revisions of the file and the errors in each → walks through the decision

### T3 — `stare_pause`
**Detection:** Cursor + scroll unchanged for 90 seconds while editor is focused AND file has any diagnostic OR file size > 50 lines
**Cooldown:** 180s
**Local action:** *"Been on [filename] for a while. Stuck on something?"*
**Escalation:** on click, Claude gets the current file + visible viewport → offers targeted help

### T4 — `build_fail_loop`
**Detection:** 3 consecutive saves in the same file each containing at least one Error diagnostic
**Cooldown:** 180s
**Local action:** *"Third save with errors in a row. Want me to trace through what's happening?"*
**Escalation:** on click, Claude gets the diff between saves 1 and 3 + all errors → shows the mental model gap

### T5 — `win_detected`
**Detection:** errors cleared AND at least one new concept mastery gained in the save
**Cooldown:** 30s
**Local action:** brief celebration, ONE sentence: *"Nice — that's [concept] working cleanly."*
**Escalation:** never (wins don't need Claude)

### T6 — `flow_detected`
**Detection:** 5+ clean saves in 3 minutes, no errors
**Cooldown:** infinite (flow is for silencing, not speaking)
**Local action:** **nothing**. Suppress all other triggers for the next 5 minutes.
**Purpose:** this is the "shut up" signal — most important trigger.

### T7 — `commit_risk`
**Detection:** git status shows 5+ modified files AND none of them are test files AND user just ran `git add` (via terminal watcher if available, or simply on panel open)
**Cooldown:** 1 per commit
**Local action:** *"Adding [N] files with no test touches. Want me to look for a quick test?"*
**Escalation:** on click, Claude reviews the diff and suggests one test per changed module

### T8 — `late_night_marathon`
**Detection:** current time past 23:30, session active for > 90 minutes, 20+ saves
**Cooldown:** 1 per session
**Local action:** *"Going deep tonight. Want me to snapshot where you left off before you crash?"*
**Escalation:** on click, Claude writes a resume-here summary that gets stored as memory

### T9 — `risky_edit`
**Detection:** single save changed 5+ files OR deleted 50+ lines across a file
**Cooldown:** 180s
**Local action:** *"Big change — want a second pair of eyes before it compiles?"*
**Escalation:** on click, Claude diffs the changes and flags anything suspicious

### T10 — `concept_breakthrough`
**Detection:** concept mastery jumped a level (e.g., familiar → functional → competent)
**Cooldown:** 1 per concept per day
**Local action:** *"[Concept] just hit [level]. That's real progress."*
**Escalation:** never

### Suppression hierarchy (avoid spam)

- `flow_detected` active → suppress everything for 5 min
- `win_detected` just fired → suppress other nudges for 60s (don't kill the vibe)
- `late_night_marathon` → only critical nudges (T1 with severity=error)
- User clicked "quieter" setting → double all cooldowns
- User clicked "silent today" → zero triggers until next day

---

## 4. The escalation gateway

This is the heart of the hybrid. Every trigger answers: **should this become a Claude call?**

```
on_trigger_fire(trigger_id, context):
  1. Check trust budget (5 points/day, refundable on engagement)
     → if 0, silence the nudge entirely
  2. Check cooldown
     → if active, drop
  3. Check suppression (flow_detected, late_night, etc.)
     → if active, drop
  4. Local action: compute template nudge
  5. Present nudge in Protege panel (distinct "unprompted" style)
  6. Wait for user action:
     a. Ignore for 20s → nudge fades, -1 trust
     b. Click dismiss → nudge disappears, -1 trust
     c. Click engage ("yes, help") → ESCALATE to Claude
        - Build prefilled /chat request:
          - system: MENTOR_PROMPT + "Proactive mode, trigger=T1, context=..."
          - user: "I noticed [trigger]. Help me with it."
          - workspace: current file + relevant range
        - Stream Claude response into chat
        - +1 trust refund
        - +1 trust bonus (up to 8 cap) if they click a followup chip
```

### What local model does (Phase 1 onwards)

Instead of raw templates, before showing the nudge, pass the trigger context to the local model:

```
local_polish({
  trigger: "error_persists",
  error_message: "Cannot find name 'useStat'",
  file: "App.tsx",
  user_level: "intermediate",
  seconds_stuck: 14
})
```

Returns a polished one-liner in Protege's voice. Fallback: template string if local model unavailable.

### What Claude does (when escalated)

Receives the trigger reason as part of the system prompt:

```
[proactive mode active]
Trigger: error_persists (T1)
Context: The user has had this error on screen for 14 seconds without fixing it:
  File: App.tsx
  Line: 42
  Error: Cannot find name 'useStat'
  
The error appears to be a typo of 'useState'. Teach the user about it — probe briefly, then show the fix, then one check-in question. Stay short.
```

Claude handles the teaching like any other request but knows it's proactive and should be calibrated to "gentle interruption" tone.

---

## 5. Phase-by-phase build plan

Each phase is designed as one focused session. Acceptance criteria listed.

### Phase 0A — Event plumbing (2h)

**Goal:** the watcher can SEE everything. Not yet deciding anything.

**Files:**
- `apps/extension/src/watcher/events.ts` — event bus + ring buffer
- `apps/extension/src/watcher/state.ts` — rolling 15-min window of events
- `apps/extension/src/watcher/hooks.ts` — subscribe to all VS Code events

**Events captured:**
- `file_opened(path, ts)`
- `file_saved(path, ts, errorCount)`
- `text_change(path, ts, changeSize, isUndo, isRedo)`
- `selection_change(path, ts, line, col)`
- `diagnostic_change(path, ts, errors[], warnings[], infos[])`
- `error_appeared(path, line, message, ts)` ← computed from diagnostic deltas
- `error_cleared(path, line, message, ts, durationMs)` ← computed
- `concept_gained(concept, deltaIq, ts)` ← from analyzer

**Acceptance:** output channel shows a real-time stream of every event. No triggers yet. No nudges yet.

---

### Phase 0B — Trigger engine (2h)

**Goal:** rules layer decides when to speak. Still no LLM.

**Files:**
- `apps/extension/src/watcher/triggers.ts` — rule implementations (one function per trigger T1-T10)
- `apps/extension/src/watcher/budget.ts` — trust budget + cooldown registry
- `apps/extension/src/watcher/dispatcher.ts` — runs triggers on every event, fires nudges

**Implementation detail:**
```ts
// triggers.ts
export const TRIGGERS = [
  {
    id: "error_persists",
    cooldownMs: 60_000,
    check(state): TriggerResult | null {
      for (const err of state.activeErrors) {
        const age = Date.now() - err.appearedAt;
        if (age > 10_000 && !err.nudged) {
          return { id: "error_persists", context: { err } };
        }
      }
      return null;
    },
    template(ctx): string {
      return `That "${ctx.err.message}" on line ${ctx.err.line} has been hanging around. Want me to look at it?`;
    },
  },
  // ... T2-T10
];
```

**Acceptance:** real scenarios trigger real nudges in the extension output channel. No UI delivery yet.

---

### Phase 0C — Unprompted message UI (1h)

**Goal:** nudges appear in the chat panel with distinct styling and dismiss/engage buttons.

**Files:**
- `apps/extension/webview/App.tsx` — render `unprompted` message type with left border, "Protege, unprompted:" prefix, dismiss button
- `packages/types/src/index.ts` — add `message.kind: "normal" | "unprompted"` field
- `apps/extension/src/watcher/dispatcher.ts` — broadcast unprompted messages via `pushUnprompted(nudge)`

**UI style:**
- Left border: 3px solid electric blue
- Background: `rgba(74, 158, 255, 0.04)`
- Prefix: `Protege · unprompted` in uppercase 10px letter-spacing
- Two buttons: `✓ Help me` (engage) and `✕ Dismiss`
- Auto-fade to 40% opacity after 20s of inaction
- Click engage → sends a synthetic user message to trigger Claude

**Acceptance:** a proactive nudge appears in the chat panel, looks visually distinct, and clicking "Help me" escalates to Claude with the right context.

---

### Phase 0D — Trust budget + suppression (1h)

**Goal:** the watcher never spams. Flow state silences everything.

**Files:**
- `apps/extension/src/watcher/budget.ts` — implement the rules from §4
- `apps/extension/src/watcher/suppression.ts` — flow detection, night-mode, silent-today

**Settings:**
- `protege.watcher.verbosity: "silent" | "quiet" | "normal" | "verbose"` (default `normal`)
- `protege.watcher.dailyBudget: number` (default 5)
- Command palette: `Protege: Silence for today`

**Acceptance:** during a flow state (5+ clean saves in 3 min), no nudges fire for 5 min even if other triggers would match.

---

### Phase 1 — Tiny local brain (SmolLM2-360M) (3h)

**Goal:** nudges sound polished and human, not template-y.

**Files:**
- `apps/backend/src/localBrain.ts` — loads SmolLM2 via transformers.js, exposes `polish(trigger, context)` and `classify(text)`
- `apps/backend/src/routes/quick.ts` — new endpoint `POST /quick/nudge`
- `apps/extension/src/watcher/dispatcher.ts` — call `/quick/nudge` before displaying, fall back to template if backend unavailable or local brain still warming

**Why backend hosts the local model:**
- Keeps the extension bundle small
- Single model warmup for all webviews
- Easy to swap to Ollama later

**Lazy warmup:** same pattern as Kokoro — kicks off on backend start, isKokoroReady-style readiness flag.

**Acceptance:** nudges visibly improve in phrasing. Template fallback works when local brain is warming.

---

### Phase 2 — Escalation with proactive Claude mode (2h)

**Goal:** when user engages a nudge, Claude receives proactive-mode context and responds accordingly.

**Files:**
- `apps/backend/src/prompts/persona.ts` — add `buildProactiveSystemPrompt(trigger, context)`
- `apps/backend/src/routes/chat.ts` — accept `body.proactive?: { triggerId, context }` and route to the proactive system prompt
- `apps/extension/src/watcher/dispatcher.ts` — on engage, call `/chat` with proactive body

**Proactive prompt additions:**
```
You are in PROACTIVE mode. You noticed the user had [trigger] and offered help. They engaged. Keep this short and surgical:
- One sentence acknowledging what you saw ("That error on line 42 — I see the issue.")
- One or two sentences teaching the mental model
- An actual fix via edit_file if appropriate
- One followup question (not "does that make sense?")
- No preamble, no apologies for interrupting.
```

**Acceptance:** click a nudge → Claude replies in proactive voice, short and focused, not chatbot-flavored.

---

### Phase 3 — Real local coder (Qwen2.5-Coder-1.5B) (4h)

**Goal:** local brain can answer short code questions without Claude.

**Files:**
- `apps/backend/src/localBrain.ts` — swap model, add `quickQA(question, fileContext)`
- `apps/backend/src/routes/quick.ts` — add `POST /quick/qa`
- `apps/extension/webview/App.tsx` — add a "⚡ quick" toggle in the chat input for local-only mode
- Setting: `protege.chat.defaultMode: "local" | "balanced" | "cloud"`

**Routing in balanced mode:**
- Short questions (< 10 words) → local
- Questions about specific lines of code → local
- Questions with "teach me", "explain deeply", "walk through" → Claude
- Edit/build requests → Claude

**Acceptance:** typing "what does useRef do" gets a local answer in < 2s. Typing "teach me useRef with a demo" still hits Claude.

---

### Phase 4 — Ollama opt-in (1h)

**Goal:** power users with Ollama installed get native-speed inference.

**Files:**
- `apps/backend/src/localBrain.ts` — on startup, check `http://localhost:11434/api/tags`. If present, prefer Ollama for quickQA.
- Setting: `protege.localBrain.preferOllama: boolean` (default true)

**Acceptance:** if Ollama is running with `qwen2.5-coder:7b`, local quick Q&A uses it and runs visibly faster than transformers.js.

---

## 6. The decision table (who handles what)

| Situation | Rules | Local LLM | Claude |
|---|:---:|:---:|:---:|
| Concept detection from save | ✓ | | |
| Code IQ math | ✓ | | |
| Error timer (when does it become "stuck"?) | ✓ | | |
| Undo cluster detection | ✓ | | |
| Stare-pause detection | ✓ | | |
| Flow-state detection (shut up signal) | ✓ | | |
| Trust budget / cooldowns | ✓ | | |
| Template nudge wording (Phase 0) | ✓ | | |
| Polished nudge wording (Phase 1+) | fallback | ✓ | |
| Intent classification (debug vs learn vs build) | fallback | ✓ | |
| Session end summary | fallback | ✓ | |
| "Is this fact worth remembering?" | | ✓ | |
| Short Q&A ("what does this line do?") | | ✓ | fallback |
| Morning greeting (uses yesterday's memory) | | | ✓ |
| Proactive teaching on engaged nudge | | | ✓ |
| Teaching a concept through user's code (5-phase protocol) | | | ✓ |
| Multi-file refactor | | | ✓ |
| Complex bug explanation | | | ✓ |
| Code editing with `edit_file` tool | | | ✓ |
| Deep review with tradeoffs | | | ✓ |

---

## 7. Cost model (back-of-envelope)

### Current state (Claude for everything)
- Average user: 40 chat turns/day × ~4000 tokens input × $3/Mtok + ~1000 tokens output × $15/Mtok
- Daily: ~$0.48 + ~$0.60 = **~$1.08 per user per day**
- Monthly: **~$32 per user**

### After hybrid (Phase 0 + 1 rolled out)
- Rules layer handles ~60% of "always-on" work → $0
- Local brain handles ~25% (nudge polishing, quick Q&A, classification) → $0
- Claude handles ~15% (deep teaching, edits, reviews) → ~$0.16/day
- Monthly: **~$5 per user**

**~85% cost reduction**, no quality loss on the things that matter.

### After Phase 3 (local coder brain)
- Short Q&A moves local → another 10% shaved
- Monthly: **~$3 per user**

**~90% cost reduction vs current state.**

At 1,000 users, monthly API cost: $32k → $3k. At 10,000 users: $320k → $30k. The unit economics become actually viable.

---

## 8. What I'd ship first

**The ONE phase that gives you 80% of the feel for 4 hours of work: Phase 0 (A+B+C+D).**

This ships:
- Full ambient watcher with all 10 triggers
- Template-based nudges appearing in the chat panel
- Trust budget + flow detection + silence modes
- Engage button escalates to Claude with proactive prompt

After Phase 0, Protege will already feel like it's watching you. The nudges will be slightly templatey-flavored but Claude takes over the moment you engage, so the quality of real teaching moments stays 10/10.

Phase 1 (local brain for polish) can happen after you've used Phase 0 for a week and felt where nudges need more naturalness.

---

## 9. Setting up the watcher's personality

When nudges speak, they match Protege's voice from the human-feel plan:

- **Never alarmist.** "That error has been hanging around" beats "You have an error!"
- **Never cheerful.** "Nice — that's [concept] working cleanly" beats "Great job!"
- **Always escape-hatched.** Every nudge offers help, never demands attention.
- **Gets quieter when ignored.** If the user ignores 3 nudges in a row, cooldowns double for the day.
- **Gets louder on engagement.** If they engage with the last nudge, the next one can come sooner.

---

## 10. Open questions

1. **Do we track diagnostics from all sources (TypeScript server, ESLint, etc.) or only our own `/analyze`?** → I'd say all — the value of T1 is seeing what VS Code itself is flagging in real time.
2. **Should nudges speak aloud in voice mode?** → Yes for high-severity T1/T4, no for ambient T3/T10. Voice-worthy nudges = critical.
3. **How do we handle multiple windows / workspaces?** → Scope all state to workspace root. Each Protege panel has its own watcher.
4. **What about git commits as a trigger?** → Good candidate for Phase 1+. Needs terminal hook or git watching.
5. **Privacy for enterprise users?** → Local mode needs to cover the full watcher path. Phase 3 gives us that.

---

## 11. Next action

Say the word and I'll start **Phase 0A** — event plumbing. Estimated 2 hours to a working event stream visible in the Protege output channel. Then B (triggers), C (UI), D (budget) each land as discrete commits.
