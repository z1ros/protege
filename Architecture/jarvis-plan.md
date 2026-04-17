# JARVIS Mode — Protege as an IDE Intelligence Layer

## Vision

Protege stops being a chatbot in a sidebar. It becomes an **intelligence layer that lives inside the editor** — 90% of interactions happen through inline overlays, hover cards, decorations, CodeLens actions, and contextual popups. The chat panel still exists but becomes secondary (like Spotlight search — you invoke it when you need it, but it's not where you live).

Think: what if every symbol in your code had a mentor standing behind you who could explain it, show examples, suggest improvements, and teach you patterns — all without you ever leaving the line you're looking at?

## Current State vs Target

| | Current | JARVIS Target |
|---|---|---|
| **Primary interface** | Chat sidebar | Editor inline layers |
| **How you ask** | Type in chat box | Hover, click CodeLens, Cmd+. |
| **How it answers** | Text reply in chat | Inline annotations, peek views, hover cards |
| **Proactivity** | Nudge toasts | Inline hints that appear as you type |
| **Teaching** | Explains in chat | Shows diff, highlights code, opens mini-tutorial |
| **Code fixes** | Copy from chat | One-click apply via CodeAction |

## Architecture: 5 Layers

```
Layer 5: COMMAND LAYER     Cmd+Shift+P actions, keyboard shortcuts
Layer 4: OVERLAY LAYER     Peek views, side panels, floating tutorials
Layer 3: INTERACTION LAYER CodeLens buttons, Quick Fix actions, completions
Layer 2: ANNOTATION LAYER  Inline decorations, inlay hints, gutter icons
Layer 1: AWARENESS LAYER   File watching, error tracking, concept detection
```

Each layer builds on the ones below it. We build bottom-up.

---

## Prompt Sequence (16 prompts, each one session)

### PHASE 1: Awareness (the foundation — Protege understands your code)

---

**Prompt 1: Smart Hover Provider**

> Build a VS Code HoverProvider that activates on any symbol in JS/TS/JSX/TSX files. When the user hovers over a keyword, API, or pattern:
> 1. Detect what they're hovering over (keyword? function call? import? JSX tag?)
> 2. Show a rich Markdown hover card with:
>    - One-line explanation of what this does
>    - A tiny code example showing correct usage
>    - "Mastery: 72%" badge if we've tracked this concept
>    - A "Teach me more" link that sends a message to the chat
> 3. Use a local lookup table for common patterns (no API call — instant), fall back to Claude for unknown symbols
> 4. Register in extension.ts, add to package.json contributes
>
> Files to create/edit: `src/hoverProvider.ts`, `src/hoverKnowledge.ts` (lookup table), `src/extension.ts`, `package.json`

---

**Prompt 2: Inline Error Explanations**

> When VS Code shows a red squiggly (diagnostic error), Protege should add a decoration BELOW that line with a one-line plain-English explanation of what went wrong and how to fix it. Like a mentor leaning over your shoulder saying "ah, you forgot to close the tag."
>
> 1. Listen to `vscode.languages.onDidChangeDiagnostics`
> 2. For each error diagnostic, generate a one-line explanation (use a local pattern matcher for common errors like "missing semicolon", "unexpected token", "type X is not assignable to Y" — fall back to Claude for complex ones)
> 3. Render as a `TextEditorDecorationType` with `after` content (gray italic text below the error line)
> 4. Include a "Fix it" CodeLens above the error that, when clicked, asks Claude for a fix and applies it as a workspace edit
> 5. Auto-clear when the error is resolved
>
> Files: `src/inlineErrors.ts`, `src/errorPatterns.ts`, update `src/extension.ts`

---

**Prompt 3: Concept Gutter Icons**

> Add gutter icons (small colored dots) next to lines that contain tracked concepts. Color = mastery level:
> - Gray dot = familiar (seen once)
> - Blue dot = functional (used a few times)
> - White dot = competent/expert (mastered)
>
> Hovering the gutter dot shows: concept name, mastery %, times used, "Practice this" action.
>
> This makes the concept system VISIBLE in the editor — you can see at a glance which parts of your code you've mastered and which are new territory.
>
> Files: `src/conceptGutters.ts`, update `src/extension.ts`

---

### PHASE 2: Interaction (Protege responds to actions, not just chat)

---

**Prompt 4: Smart CodeLens — "Explain" / "Improve" / "Test" above every function**

> Add CodeLens buttons above every function/component/class:
> - **Explain** → opens a peek view (inline panel below the function) with a Claude-generated explanation of what this function does, its inputs/outputs, and edge cases
> - **Improve** → shows a diff preview of suggested improvements (rename, simplify, add error handling) — user can accept/reject each suggestion
> - **Test** → generates a test for this function and opens it in a split editor
>
> The key insight: these are ONE-CLICK actions on code the user is already looking at. No typing required. No context switching to a chat panel.
>
> Files: `src/smartCodeLens.ts`, `src/peekExplain.ts`, `src/diffPreview.ts`, update `src/extension.ts`, `package.json`

---

**Prompt 5: Quick Fix Actions (the lightbulb menu)**

> Register a CodeActionProvider that adds Protege actions to the VS Code lightbulb menu (Cmd+.):
> - "Protege: Explain this error" → inline explanation
> - "Protege: Fix this" → applies a fix
> - "Protege: Refactor this" → shows refactoring options
> - "Protege: Add types" → generates TypeScript types
> - "Protege: Teach me about [concept]" → sends to chat with context
>
> These appear alongside VS Code's built-in quick fixes, so the user discovers them naturally.
>
> Files: `src/quickFixProvider.ts`, update `src/extension.ts`, `package.json`

---

**Prompt 6: Inline Teaching Annotations**

> When Protege detects a concept the user hasn't mastered (mastery < 40%), add a subtle inline annotation (inlay hint style) that teaches the concept in-place:
>
> Example: if the user writes `useEffect(() => { ... }, [])` and hasn't mastered dependency arrays:
> ```
> useEffect(() => {
>   fetchData();
> }, []);  // ℹ️ empty array = runs once on mount. Add deps to re-run on change.
> ```
>
> The annotation is:
> - Dismissable (click to hide, remembers per-concept)
> - Subtle (faint gray text, doesn't distract)
> - Contextual (only shows for concepts below mastery threshold)
> - Disappears once mastery > 60% (you've learned it)
>
> Files: `src/teachingAnnotations.ts`, update `src/extension.ts`

---

**Prompt 7: Smart Completions with Teaching Context**

> Register a CompletionItemProvider that enhances VS Code's autocomplete:
> - When suggesting a completion, add a `documentation` field with a rich teaching card (what this does, when to use it, common mistakes)
> - For React hooks: show the rules of hooks
> - For array methods: show input→output examples
> - For CSS properties: show visual examples (if possible)
>
> The user never has to leave autocomplete to learn. The teaching happens in the autocomplete detail panel.
>
> Files: `src/smartCompletions.ts`, `src/completionDocs.ts`, update `src/extension.ts`, `package.json`

---

### PHASE 3: Overlays (rich visual teaching that happens inline)

---

**Prompt 8: Peek Teaching View**

> Build a custom peek-view-style inline panel that opens below any line when the user triggers "Protege: Teach":
> 1. Shows a rich mini-tutorial about the concept on that line
> 2. Includes: explanation, 2-3 code examples with syntax highlighting, common mistakes, related concepts
> 3. Has "Previous/Next" navigation between related concepts
> 4. Has a "Practice" button that creates a scratch file with an exercise
> 5. Renders as a webview inside a peek widget (vscode.window.createWebviewPanel positioned as a peek)
>
> This is the core teaching UI — it's where Protege shines as a mentor.
>
> Files: `src/peekTeach.ts`, `webview/PeekTeachView.tsx`, styles, update `src/extension.ts`

---

**Prompt 9: Diff-Based Learning**

> When Protege suggests a code improvement, show it as an inline diff:
> 1. Original code on the left, improved code on the right (or inline with red/green)
> 2. Each change has a tooltip explaining WHY it's better
> 3. User can accept individual changes (not all-or-nothing)
> 4. Accepted changes are applied as workspace edits
> 5. Each accepted improvement earns IQ
>
> This is how real mentorship works: "here's what you wrote, here's how I'd write it, here's why."
>
> Files: `src/diffTeaching.ts`, `src/diffApply.ts`, update tools

---

**Prompt 10: Floating Tutorial Panel**

> A small floating panel (webview) that attaches to the right side of the editor and shows contextual content based on what the user is looking at:
> - Writing JSX? Panel shows React patterns cheat sheet
> - In a CSS file? Panel shows flexbox/grid visual reference
> - Writing async code? Panel shows Promise lifecycle diagram
> - Panel auto-updates as the cursor moves between files/contexts
> - Can be pinned to stay on a specific topic
> - Minimizes to a small tab on the editor edge
>
> This is the "mentor looking over your shoulder" — always relevant, never intrusive.
>
> Files: `src/floatingPanel.ts`, `webview/FloatingTutorial.tsx`, update `src/extension.ts`

---

### PHASE 4: Proactivity (Protege acts before you ask)

---

**Prompt 11: Real-Time Code Review as You Type**

> As the user types, Protege silently analyzes the code (debounced, every 2s after last keystroke):
> 1. Detects anti-patterns, bugs, performance issues, style problems
> 2. Shows a subtle underline (not error-red, but mentor-blue) under problematic code
> 3. Hovering the underline shows the suggestion + "Apply fix" button
> 4. Suggestions are ranked by severity and limited to 2-3 per file (not overwhelming)
> 5. Learns from what the user accepts/rejects — if they always reject a certain type of suggestion, stop showing it
>
> This is like having a senior dev pair-programming with you in real-time.
>
> Files: `src/liveReview.ts`, `src/reviewEngine.ts`, `src/reviewPreferences.ts`

---

**Prompt 12: Context-Aware Status Bar**

> The status bar becomes a live dashboard:
> - Shows current concept being used: "📖 useEffect (72% mastery)"
> - Click to see quick stats: concepts in this file, IQ earned today, current streak
> - When Protege has a suggestion, the status bar pulses subtly with "💡 1 suggestion"
> - Click the suggestion count to cycle through inline suggestions
>
> Files: `src/statusBarLive.ts`, update `src/extension.ts`

---

**Prompt 13: Proactive "Did You Know?" Moments**

> At natural pause points (user stops typing for 10+ seconds, switches files, saves), Protege occasionally shows a non-intrusive teaching moment:
> - A small toast notification: "💡 Did you know? The code you just wrote uses the Observer pattern. Here's a 30-second explainer →"
> - Clicking opens the Peek Teaching View (Prompt 8)
> - Limited to 2-3 per hour (not annoying)
> - Tracks which tips have been shown and doesn't repeat
> - Tips are contextual to what the user just wrote
>
> Files: `src/didYouKnow.ts`, `src/tipDatabase.ts`

---

### PHASE 5: Polish (JARVIS-level UX)

---

**Prompt 14: Command Palette Integration**

> Add rich command palette commands:
> - "Protege: Explain selection" → explains highlighted code
> - "Protege: What does this file do?" → summarizes the current file
> - "Protege: Show my weak spots" → opens a panel showing concepts with low mastery in the current file
> - "Protege: Quiz me" → generates a quick quiz based on concepts in the current file
> - "Protege: Teach mode ON/OFF" → toggles all inline annotations
>
> Each command is a keyboard-shortcut-friendly entry point.
>
> Files: update `package.json` commands, `src/commands/*.ts`

---

**Prompt 15: Keyboard-First Mentor Mode**

> Add a "Mentor Mode" toggle (Cmd+Shift+M):
> - When active, pressing Cmd+K on any line opens the Peek Teaching View
> - Pressing Cmd+J shows a quick explanation tooltip at the cursor
> - Pressing Cmd+; cycles through suggestions in the current file
> - Pressing Cmd+' accepts the current suggestion
> - ESC dismisses any open teaching overlay
>
> This makes Protege keyboard-first — you never need the mouse.
>
> Files: `src/mentorMode.ts`, update `package.json` keybindings

---

**Prompt 16: Wake Word / Inline Chat**

> Add an inline chat trigger (like Cursor's Cmd+K but for teaching):
> - User types `//? how do I handle errors here?` anywhere in code
> - Protege detects the `//?` prefix and responds with an inline annotation below that comment with the answer
> - The answer is contextual (knows the surrounding code)
> - User can follow up with another `//? but what about async errors?`
> - The thread lives in the code, not in the chat panel
>
> This is the ultimate "IDE-native" interaction — you never leave the file.
>
> Files: `src/inlineChat.ts`, `src/commentTrigger.ts`

---

## Implementation Order & Dependencies

```
Week 1-2: Prompts 1-3 (Awareness Layer)
  1 → Smart Hover Provider (standalone)
  2 → Inline Error Explanations (standalone)
  3 → Concept Gutter Icons (depends on existing concept tracker)

Week 3-4: Prompts 4-7 (Interaction Layer)
  4 → Smart CodeLens (depends on 1 for hover knowledge)
  5 → Quick Fix Actions (standalone)
  6 → Teaching Annotations (depends on 3 for mastery data)
  7 → Smart Completions (standalone)

Week 5-6: Prompts 8-10 (Overlay Layer)
  8 → Peek Teaching View (depends on 1, 4)
  9 → Diff-Based Learning (depends on 4)
  10 → Floating Tutorial Panel (standalone)

Week 7-8: Prompts 11-13 (Proactivity Layer)
  11 → Live Code Review (depends on 2, 5)
  12 → Context-Aware Status Bar (depends on 3)
  13 → Did You Know? (depends on 8, 6)

Week 9-10: Prompts 14-16 (Command Layer)
  14 → Command Palette (depends on 8, 9)
  15 → Keyboard Mentor Mode (depends on 8, 14)
  16 → Inline Chat (depends on all above)
```

## Key Principle

Every prompt builds a feature that works WITHOUT the chat panel being open. The chat panel becomes a fallback for deep conversations — like asking JARVIS a complex question. But 90% of the time, Protege teaches you through the code itself.

## Cost Optimization

Most of the Layer 1-2 features (hover, gutter icons, error patterns, teaching annotations) use LOCAL pattern matching, not Claude API calls. Only Layer 3+ features (peek explanations, code review, diff suggestions) call Claude, and they're user-initiated (click/command), not continuous.

This means the JARVIS experience feels instant and free for the common case, with Claude powering the deep teaching moments.
