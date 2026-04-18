# Ambient Coach — Learning at the speed of vibe coding

> **North star.** The best mentor is the one you forget is there — until the exact moment you need them. Protege should teach inside the flow, not beside it. Vibe coding is a trance; learning has always broken the trance. We fix that.

---

## The thesis

Vibe coding works because nothing in your field of view asks you to stop. Traditional learning works because something *does* ask you to stop — you open a doc, read, synthesise, come back, re-orient. The two have always been opposites.

Protege's bet: **you can learn without stopping** if the lesson arrives as a single glance, inside the typing rhythm, attached to the exact symbol you just wrote. Flow + retention, not flow vs. retention.

We earn this by reducing the mentor's surface to two things, and nothing else:

1. **The Strip** — passive awareness. "I see you, I'm watching." Always on, never in the way.
2. **The Ghost Mentor** — opportunistic teaching. "Here's the move." Shows only when the model is highly confident and the moment is right; evaporates if ignored.

Every popup, gutter icon, inlay, squiggle, CodeLens, red underline, modal, toast, hover card, peek view, and sidebar auto-open we've ever shipped is **retired**. The sidebar remains but is user-summoned only.

---

## Design principles

1. **One glance, one action.** Every surface must be readable in under 400ms and actionable in one keystroke.
2. **Silence is the default.** If we're not ≥80% sure the insight is useful *right now*, show nothing.
3. **Never break typing.** If the user is actively typing, no surface may mutate.
4. **Action precedes explanation.** Let them fix it first; the *why* shows up in Code IQ later. Explanation is opt-in.
5. **Compound, don't repeat.** If we taught a concept once and the user applied it, escalate. Never re-teach the same lesson at the same level.
6. **Feel like a colleague, not a linter.** Protege's voice is the quiet senior who nudges, not the CI bot that nags.

---

## Surface 1 — The Strip

A **28px horizontal band above the status bar**, spanning the editor width (not the full window — respects sidebar). Always visible when a source file is open. Disappears when the editor is not focused.

### Layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│  ●  Typo 'buton' on line 10 — Tab to fix    ·    ⌘; details    ·  +12 IQ │
└──────────────────────────────────────────────────────────────────────────┘
```

- **Left dot** (12px) = severity colour. Pulses once when content changes, then still.
- **Middle text** = the single most relevant insight for the current cursor context. One line, truncated with ellipsis.
- **Right pill** = live IQ ticker. Silent reward signal. Click → jumps to Code IQ tab.
- **Middle affordance** = "⌘; details" always shown, always the same keystroke. Muscle memory.

### Content selection (priority order)

1. An insight on the **current line** (cursor-anchored).
2. An insight on the **cursor's enclosing symbol** (function/block).
3. A **recent teach moment** we haven't yet acknowledged.
4. A **concept resurface** from spaced-repetition queue (only during natural pauses — see stare detector).
5. Idle state: `Protege — watching (Qwen on-device · ready)`.

Only one slot visible at a time. Rotation is event-driven (cursor move, new insight, pause detected), never on a timer — timer-driven rotation is the #1 reason glanceable UIs become noise.

### Interaction

| Input | Behaviour |
|---|---|
| `⌘;` | Expand the current Strip item into the sidebar, pre-scrolled and focused. |
| `Tab` (when ghost present on same line) | Apply the fix. |
| Click dot | Jump caret to the insight's line. |
| Click text | Same as `⌘;`. |
| Click IQ pill | Open Code IQ tab. |
| Hover | Nothing. Hover = noise. |

### What it explicitly is NOT

- Not a progress bar.
- Not a chat preview.
- Not a notification tray.
- Not a "2 issues · 1 warning" counter — counts are status-bar territory, not mentor territory.

---

## Surface 2 — The Ghost Mentor

When the model spots a teachable moment, a **dimmed ghost line styled as a comment** appears directly below the user's cursor:

```tsx
<li key={index}>
  // 💡 key={index} breaks React re-render. Tab → key={item.id}
```

### Visual language — how it's different from Copilot

- **Protege-blue color** (brand accent, `rgba(74,158,255,0.65)`), not Copilot's neutral gray.
- **`// 💡` prefix** at the start of every line — you instantly know "this is the teacher, not autocompletion."
- **Italic**, comment-shaped. Reads like a senior leaning over your shoulder writing a margin note, not like code waiting to be accepted.
- Max 90 chars; truncate and expose ⌘. for depth.

The whole point of the visual distinction: when Copilot is suggesting code AND Protege is teaching, your eye can separate them in one glance. Never confused, never stacking.

### Interaction — zero new gestures

- **Tab** → ghost accepts. The code morphs in place (`key={index}` → `key={item.id}`), `+IQ` flies up.
- **Esc** → ghost dismisses.
- **Keep typing** → ghost evaporates silently on the next keystroke. No log, no guilt.
- **⌘.** → ghost expands into a 3–4 line inline peek below, explaining *why*.

Users already know Tab from Copilot. We hijack that muscle memory for learning. **Learning happens at the same speed as completion** — that's the magic. You never stop to learn; learning is a Tab away, same as accepting an AI completion.

### Trigger conditions — ALL must be true

1. User has not typed for ≥800ms (debounce).
2. Analyzer confidence ≥0.8 for this suggestion.
3. No other ghost is currently visible (one at a time).
4. The concept has not been taught-and-applied by this user in the last 24h.
5. Cursor is on, or one line above/below, the insight's anchor.

### The Copilot-conflict problem (must solve)

Tab is sacred. If both Copilot and Protege want Tab at the same moment, the wrong one winning would ruin trust in both. Rules:

- **Copilot-first for completion intent.** If Copilot has an active `InlineCompletionItem` visible, Protege does not render a ghost — it waits.
- **Protege-first for teaching intent.** If the user has *paused* (≥800ms no keystroke) and a Protege teachable exists on the current line, we fire the ghost. Copilot's completion is typing-driven, so by 800ms of pause, Copilot's ghost is usually gone anyway.
- **Never simultaneous.** We subscribe to `vscode.window.onDidChangeTextEditorSelection` and check Copilot's `hasInlineCompletion` context key (or equivalent). Presence of Copilot's ghost → Protege holds.
- **Different accept targets.** If we can't fully separate Tab, fall back to the distinct keystroke `⌥Tab` (Alt+Tab) for Protege accept — preserves Tab for Copilot, still single-key.

### Engagement path

```
detect teachable moment
  → ghost appears (debounced 800ms after last keystroke)
  → user Tab?  → apply fix in place, log concept as "applied", +IQ pulse
  → user ⌘.?   → inline peek expands below (3–4 lines, "why"), keeps ghost
  → user Esc?  → dismiss, log "dismissed" (lowers future confidence for this rule)
  → user types? → evaporate silently on next keystroke, no log
```

### Why this is iconic

The `// 💡` prefix + Protege-blue color becomes **a visual brand word-mark**. Someone sees a screenshot of an editor with a blue italic comment line starting with `// 💡` — they recognise Protege instantly. Like yellow Grammarly underlines, like blue Copilot ghost text. One visual = the product.

---

## Surface 3 — The Underline Whisper (Grammarly for code)

Instead of red squigglies — noise that users have learned to ignore — Protege draws a **thin, beautiful, barely-there underline in Protege-blue under specific tokens that have teaching value**. Zero interruption, permanent ambient presence.

Example:

```tsx
<button key={index}>
             ‾‾‾‾‾    ← subtle blue underline, no text, no icon
```

You glance at the code. Out of the corner of your eye you catch the blue underline. You don't *read* anything — you just *know* that token is worth a second look. Subconscious signal, zero cognitive cost.

### Visual spec

- **Color:** `rgba(74, 158, 255, 0.45)` — Protege-blue, ~45% opacity. Visible but never loud.
- **Style:** `text-decoration: underline; text-decoration-style: wavy;` OR a flat 1px underline — spike both, pick the one that feels least like an error.
- **Thickness:** 1px only. Never 2px (reads as error).
- **Never colored background, never bold text, never icon.** The underline is the ONLY signal.

### Interaction (progressive disclosure)

| Input | Effect |
|---|---|
| Nothing (passive) | The underline stays. It's the whisper — information without demand. |
| Hover the underlined token | A **tiny inline tip** appears (one line, ~60 chars, no buttons): `💡 array index as key breaks reconciliation — ⌘. to learn` |
| `⌘.` while cursor is on the token | Inline peek expands below the line with the full teaching (3–4 lines, same format as Ghost Mentor's ⌘. peek) |
| Click the token | Same as `⌘.` |

Three layers of depth, all opt-in. Default = ambient visual signal only.

### When to underline (vs when to Ghost)

Whisper and Ghost are two volume knobs on the same teaching signal:

| Confidence / Severity | Surface |
|---|---|
| Any teachable moment, low-to-mid confidence | **Whisper only** (underline — passive) |
| High confidence (≥0.8) + you're pausing on it (800ms) | **Whisper + Ghost** (underline stays, ghost line appears) |
| The user already mastered this concept | **Neither** — we're silent |

This means: the underline is always there for *anything* Protege has an opinion about. The ghost only fires when the teaching is ripe AND the user is clearly looking.

### Conflict handling — the one real technical risk

TypeScript, ESLint, and cSpell also use underlines (red/yellow squigglies on errors). If Protege's blue whisper stacks with a red TS squiggle on the same token, the visual turns into mud.

Rules:

1. **Never underline a token that already has a non-Protege diagnostic** on it. Check `vscode.languages.getDiagnostics(uri)` for overlapping ranges; skip if any exist from TS / ESLint / cSpell / any non-Protege source.
2. **Protege does not push diagnostics into the diagnostic stream** — the underline is pure decoration (`TextEditorDecorationType`), so it never shows up in the Problems panel and never stacks with Quick Fix lists.
3. **Hover provider is scoped to Protege-underlined ranges only.** Our hover never fires on code that TS/ESLint already flagged — their hover wins, cleanly.

### Why this is iconic

**Protege-blue becomes the brand's visual fingerprint.** Yellow underlines = Grammarly. Red underlines = errors. Blue underlines = *"Protege noticed something here."* Two years in, devs will look at a screenshot of a blue-underlined token and know, without thinking, that it's Protege. That's the whole game.

Combined with the Ghost Mentor's `// 💡` blue comment line, Protege owns **one color (brand blue) + two shapes (underline + italic comment)** across the editor. That's the entire visual system. Elegant. Copyable only at the cost of looking like us.

### Pros / cons (honest)

- ✅ Completely ambient — no interruption, no hotkey needed to get value.
- ✅ Visual brand word-mark.
- ✅ "Learning without noticing" — users subconsciously train themselves to scan for blue underlines.
- ✅ Stacks with Ghost Mentor cleanly (different intensities of the same signal).
- ⚠️ Technical: careful conflict handling with TS/cSpell required (rules above address this).
- ⚠️ Accessibility: color-blind users (protanopia/deuteranopia) may have trouble distinguishing blue wavy from teal/grey squiggles. Add a shape variant (dotted vs wavy) as a settings escape hatch.

---

## The teaching loop (the actual IP)

This is the part Copilot cannot copy. Completions forget. **Protege remembers.**

Every Strip/Ghost interaction emits a typed event:

```ts
type TeachEvent =
  | { kind: "shown";     concept: string; surface: "strip" | "ghost" }
  | { kind: "applied";   concept: string; tookMs: number }
  | { kind: "expanded";  concept: string }  // ⌘. — wanted to learn
  | { kind: "dismissed"; concept: string }
  | { kind: "ignored";   concept: string }; // evaporated on typing
```

These feed three loops:

1. **Mastery curve.** `applied` + `expanded` raises mastery; repeated `ignored` lowers confidence threshold. Mastered concepts stop surfacing at the beginner layer — we escalate to the next depth the same concept affords (e.g. `useState` → `useState` with lazy init → `useState` vs `useReducer`).
2. **Spaced resurface.** Applied-but-shallow concepts re-appear in the Strip's slot #4 during natural pauses, phrased as a question ("Remember why `key={index}` breaks re-renders?"). Built-in SM-2 scheduler, nothing fancy.
3. **Code IQ anchor.** Every `applied` concept is the atomic unit of Code IQ growth. The Strip's IQ pill pulses on gain. This closes the loop between *something I did* and *a number that went up* without a single popup.

This is how **"learning as easy as vibe coding"** actually becomes true: the user is never asked to learn. They act, we notice, we compound, we surface the next layer when they're ready.

---

## Content voice

Short. Direct. No emojis beyond `💡` for Ghost. No exclamation marks. No "Great job!". No "Oh no!". The mentor is a calm senior, not a camp counsellor.

| ❌ bad | ✅ good |
|---|---|
| ⚠️ Oh no! You have a typo! | Typo 'buton' — Tab to fix |
| 🎉 Nice job applying the fix! | +12 IQ · typo-element |
| 💡 Did you know that using array indices as keys can cause issues with React's reconciliation algorithm? | Array index as key — re-renders silently break |

---

## Staged rollout

### Stage 0 — editor cleanup ✅
All prior editor UI (gutter, inlay, codelens, comments, hovers, squiggles) paused. Sidebar and status-bar preserved. Backend scan pipeline intact.

### Stage 1 — Strip MVP (target: 1 day)
- 28px band, status-bar-adjacent, via a webview panel or a TextEditorDecorationType on a virtual line. (Spike both; pick the non-flickery one.)
- Slot #1 only: current-line insight.
- Idle state: `Protege — watching`.
- `⌘;` opens sidebar.
- No IQ pill yet.

### Stage 2 — Strip full (target: +1 day)
- Slots #2–#5.
- IQ pill with pulse on gain.
- Event-driven rotation.

### Stage 3 — Ghost Mentor (target: +2 days)
- Reuse the `reviewEngine` suggestions that already flow through the scan pipeline.
- Single ghost, Tab/⌘./Esc wired to existing `applyReviewFix` + `teachConcept` commands.
- Confidence gate + 24h dedup.

### Stage 4 — Teaching loop (target: +3 days)
- `TeachEvent` emitter.
- Mastery scoring in `store.ts`.
- SM-2 resurface queue.
- Strip slot #4 reads from the queue.

### Stage 5 — IQ-aware escalation (target: +1 week)
- Concept depth ladder per rule.
- Suppress mastered, escalate partial, introduce new at natural pauses.

---

## Anti-features (hard rules)

- ❌ No popups. Not a single `showInformationMessage`.
- ❌ No notifications. No toasts except the existing one-off `+N IQ` status-bar message.
- ❌ No gutter icons, inlay hints, CodeLens, or decoration underlines attributable to Protege.
- ❌ No automatic sidebar opens. Sidebar is summoned, never imposed.
- ❌ No voice (v1). Revisit after Stage 5.
- ❌ No modal dialogs, ever. If we think we need one, we're wrong.
- ❌ No "tutorial" flow. The product is the tutorial.

---

## Success metrics

**Leading (first 2 weeks):**
- % of sessions with ≥1 Ghost `applied` event.
- Median Strip glances per active hour (proxy: Strip item changes + focus state).
- Ghost `ignored` rate below 60% (above means we're too noisy).

**Lagging (first 2 months):**
- 7-day concept retention (mastered concepts resurface → correctly applied).
- Code IQ growth slope per active hour of coding.
- Uninstall rate at 7/14/30 days.

**Qualitative:**
- Three users say unprompted, *"it feels like it just knows."*
- Zero users complain the UI is in the way.

---

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Strip feels like another status bar — invisible. | One pulsing dot + event-driven updates, never timer. Pulse is the only motion in the editor, so eyes find it. |
| Ghost collides with Cursor/Copilot ghost text. | Distinct styling (dot + italic + brand blue). Never render when Cursor suggestion is active (check `vscode.InlineCompletionItemProvider` state). |
| Confidence gate too strict → silence. | Start at 0.8, log shown/ignored, tune weekly from telemetry. |
| Confidence gate too loose → noise. | 24h per-concept dedup. Escalation ladder prevents same-level retrigger. |
| Strip real estate steals from code. | A/B a 24px vs 28px variant; user-toggleable in settings. |
| Teaching loop feels invasive (spaced resurface). | Only during stare pauses (≥4s no edit, ≥2s no scroll). Never mid-flow. |

---

## Open questions

1. **Strip rendering primitive.** VS Code has no native "below-editor band." Options: (a) webview in a `TextEditor` decoration — flicker-prone; (b) a `StatusBarItem` pair at very high priority — bounded length; (c) a dedicated webview `panel` docked to the editor region — cleanest but heavier. **Spike all three, Stage 1.**
2. **Ghost vs Copilot precedence.** Who wins when both have something to say? Proposal: Copilot is code-completion, Protege is teaching — different intents. Render Protege *below* the active line, Copilot inline. They shouldn't fight.
3. **Telemetry privacy.** `TeachEvent` is local-only by default. Do we need server sync for cross-device mastery? Deferred until we see multi-device usage.
4. **On-device model latency budget.** Strip updates need <200ms. Ghost tolerates 800ms. If Qwen 1.5B can't hit Strip budget, Strip shows rule-based lints first, AI upgrades the text async.

---

## What this becomes at maturity

A user opens their editor. Protege's dot pulses once. A tiny line tells them the one thing about the cursor's neighbourhood that matters. They keep typing. Twenty minutes later, a ghost appears — they Tab, the fix lands, `+12 IQ · array-key`. They never stopped. Never read a popup. Never alt-tabbed to docs. They learned three concepts today without noticing, and the number went up.

That's the product.
