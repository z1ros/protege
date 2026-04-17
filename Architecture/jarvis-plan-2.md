# JARVIS Plan 2 — Chat Replies That Explode Into the IDE

## The Problem

Right now when you ask "how do I use `<strong>`?" in chat, Protege replies with a wall of text. You read it, then manually go back to your code and try to apply what you learned. Two separate worlds — chat and editor — with you as the bridge.

## The Fix

When Protege answers a question, 90% of the response should happen **inside the editor**, not inside the chat panel. The chat shows a short summary + confirmation. The real teaching happens through:

1. **Highlighted code regions** with explanations attached to each one
2. **Inline annotations** on your actual code showing what to change
3. **Popups/peek views** with examples that appear right next to the relevant line
4. **One-click apply** buttons that make the fix or improvement for you

The chat becomes a thin coordination layer. The editor becomes the classroom.

---

## How It Should Work — Step by Step

### User asks: "how do I use `<strong>`?"

**Current behavior:**
```
Chat panel shows 500 words of text about <strong> vs <b>,
semantic HTML, accessibility, etc. User reads it. Done.
```

**New JARVIS behavior:**

1. **Chat shows a short 2-3 sentence summary:**
   > `<strong>` marks text as important (semantic meaning). `<b>` is just visual bold. Use `<strong>` when the text actually matters for meaning.

2. **Simultaneously, in the editor:**
   - Protege finds every `<b>` tag in the current file
   - Each `<b>` gets a **yellow highlight** with a hover tooltip: "Consider using `<strong>` here — this text seems semantically important"
   - If the user already has `<strong>` tags, those get a **green highlight**: "Good — you're using this correctly"
   - A **CodeLens** appears above the first `<b>`: "Replace all `<b>` with `<strong>` — Protege"

3. **A peek panel opens below the current cursor line** showing:
   - ✅ Correct: `<strong>Important</strong>`
   - ❌ Avoid: `<b>Important</b>` (unless purely visual)
   - 📖 Related: `<em>` vs `<i>`, `<mark>`, `<cite>`

4. **The user clicks "Replace all"** → done. Learned + applied in one motion.

---

## Implementation: 8 Prompts

### Prompt 1: Smart Response Router

> When Claude's reply comes back from the backend, analyze it BEFORE showing in chat. Determine what KIND of answer it is:
>
> - **Explanation** → trigger highlight + peek flow
> - **Code fix** → trigger diff preview + apply flow
> - **Concept teaching** → trigger annotation + example flow
> - **General conversation** → just show in chat (no IDE actions)
>
> The router reads the reply content and decides which IDE actions to trigger alongside the chat message.
>
> Implementation:
> 1. In `webviewHost.ts` after receiving Claude's reply, pass it through a `classifyResponse()` function
> 2. The classifier checks for: code blocks (→ likely a fix), HTML tags / API names mentioned (→ likely teaching), keywords like "instead of" / "replace" / "use X not Y" (→ likely a suggestion)
> 3. Based on classification, dispatch IDE actions via existing tool infrastructure
>
> Files: `src/responseRouter.ts`, update `src/webviewHost.ts`

---

### Prompt 2: Highlight What You're Teaching

> When Protege's response mentions code that EXISTS in the user's current file, automatically highlight those regions:
>
> 1. After getting Claude's reply, scan the active file for any symbols/patterns mentioned in the reply
> 2. Highlight matching code with contextual colors:
>    - 🟡 Yellow = "pay attention to this" (the thing being explained)
>    - 🟢 Green = "this is correct" (good patterns the user already uses)
>    - 🔴 Red = "this needs to change" (anti-patterns or bugs)
> 3. Each highlight gets a hover tooltip with the relevant sentence from Claude's reply
> 4. Highlights auto-clear after 30 seconds or on next message
>
> This connects the abstract explanation to the concrete code. The user doesn't have to mentally map "Claude said X" to "that's on line 14" — Protege does it for them.
>
> Files: `src/teachHighlighter.ts`, update `src/responseRouter.ts`

---

### Prompt 3: Inline Examples Peek Panel

> When Claude's reply contains code examples (markdown code blocks), don't just show them in chat. Open a **peek-style panel** in the editor showing the examples with full syntax highlighting:
>
> 1. Detect code blocks in Claude's reply (```language ... ```)
> 2. Open a temporary read-only editor split below the current cursor position
> 3. The split shows the example code with full syntax highlighting + a title bar ("Example from Protege")
> 4. If there are multiple examples, add Previous/Next navigation
> 5. Add a "Insert at cursor" button that pastes the example into the user's code
> 6. Add a "Copy" button
> 7. Panel auto-closes when the user starts typing in their main editor
>
> The key: examples appear RIGHT NEXT to the code they reference, not in a sidebar 300px away.
>
> Files: `src/examplePeek.ts`, update `src/responseRouter.ts`

---

### Prompt 4: One-Click Apply for Suggestions

> When Claude's reply suggests a code change (detected by the router), show it as an inline diff with a one-click apply button:
>
> 1. Parse the "before → after" from Claude's reply
> 2. Find the matching code in the user's file
> 3. Show a CodeLens above that line: "Apply suggestion — Protege"
> 4. Clicking applies the change as a workspace edit
> 5. Show a brief green flash on the changed lines (already exists in tools.ts)
> 6. Award IQ for applying a mentor suggestion (new concept: "applied_suggestion")
>
> Files: `src/suggestionApply.ts`, update `src/responseRouter.ts`

---

### Prompt 5: Contextual Popups (Teaching Tooltips)

> For concept-teaching responses (user asks "what is X?"), show the explanation as a rich popup anchored to the relevant code:
>
> 1. Find the symbol/concept in the user's code
> 2. Register a temporary HoverProvider for that symbol
> 3. The hover shows a rich markdown card with:
>    - Short explanation (from Claude's reply)
>    - Mini code example
>    - "Mastery: X%" badge
>    - "Got it" button that dismisses + awards IQ
> 4. The hover persists (doesn't disappear on mouse-out) until dismissed
> 5. After dismissal, the symbol gets a subtle underline decoration for 10 seconds as a "you just learned this" indicator
>
> Files: `src/teachPopup.ts`, update `src/responseRouter.ts`

---

### Prompt 6: Chat Summary Mode

> Since the real teaching happens in the editor, the chat panel should show a CONDENSED version of Claude's reply:
>
> 1. When the router triggers IDE actions, truncate the chat message to 2-3 sentences + a "See in editor →" link
> 2. The full reply is stored but hidden behind a "Show full response" toggle
> 3. Below the summary, show a checklist of IDE actions taken:
>    - ✅ Highlighted 3 regions in your code
>    - ✅ Opened example panel
>    - ✅ Added "Apply fix" above line 14
> 4. Each checklist item is clickable — jumps to the relevant location
>
> This makes the chat feel like a command log, not a reading assignment.
>
> Files: update `webview/AssistantMarkdown.tsx`, `webview/App.tsx`, update `src/responseRouter.ts`

---

### Prompt 7: Multi-Step Teaching Flows

> For complex questions ("explain React hooks"), Protege should break the teaching into steps:
>
> 1. Claude returns a structured response with numbered steps
> 2. The chat shows: "I'll walk you through this in 4 steps. Step 1:"
> 3. Each step triggers different IDE actions:
>    - Step 1: highlights existing hook usage in your code + explanation popup
>    - Step 2: opens a peek panel showing the dependency array rules
>    - Step 3: shows a diff suggesting an improvement to your useEffect
>    - Step 4: creates a scratch file with a practice exercise
> 4. "Next step →" button in chat advances to the next step
> 5. Each completed step awards IQ
>
> This turns every question into a guided tutorial that USES your real code.
>
> Files: `src/teachingFlow.ts`, update `src/responseRouter.ts`, update webview

---

### Prompt 8: Escape Hatch + Preferences

> Not everyone wants IDE takeover. Add controls:
>
> 1. "Protege: IDE Teaching ON/OFF" toggle in the status bar
> 2. When OFF, replies just show in chat normally (current behavior)
> 3. When ON (default), the router dispatches IDE actions
> 4. Per-action preferences in Profile → Preferences:
>    - Highlight code: ON/OFF
>    - Open example panels: ON/OFF
>    - Show apply buttons: ON/OFF
>    - Auto-peek: ON/OFF
> 5. A "Show in chat only" button in each IDE action dismisses it and falls back to chat
>
> Files: `src/teachPreferences.ts`, update `src/responseRouter.ts`, update ProfilePage preferences

---

## Architecture Diagram

```
User asks question in chat
         │
         ▼
  Claude generates reply
         │
         ▼
  ┌──────────────────────┐
  │   Response Router     │ ← classifies the reply type
  │  (responseRouter.ts)  │
  └──────┬───────────────┘
         │
    ┌────┼────┬──────────┬───────────┐
    ▼    ▼    ▼          ▼           ▼
 Highlight  Peek     Apply      Popup      Chat
 regions    panel    button     tooltip    summary
    │       │         │          │          │
    ▼       ▼         ▼          ▼          ▼
 ┌─────────────────────────────────────────────┐
 │              EDITOR (the classroom)          │
 │  highlighted code + peek examples + apply    │
 │  buttons + teaching tooltips + decorations   │
 └─────────────────────────────────────────────┘
                    +
 ┌─────────────────────────────────────────────┐
 │         CHAT (the command log)               │
 │  2-3 sentence summary + action checklist     │
 └─────────────────────────────────────────────┘
```

## Priority Order

Start with **Prompt 2 (Highlight What You're Teaching)** — it's the highest-impact, lowest-risk change. Claude already has the `highlight_code` tool. We just need to make the router call it automatically when a teaching reply comes back, instead of waiting for Claude to decide to use it.

Then **Prompt 4 (One-Click Apply)** — users love seeing a fix applied instantly. Then **Prompt 3 (Peek Panel)** for the visual wow factor.

Prompts 5-8 are polish that makes the system feel complete.

## Key Principle

**The chat panel is not the UI. The editor is the UI.** The chat panel is where you TYPE your question. The editor is where you SEE the answer. Just like asking JARVIS a question — you don't read the answer on a screen. The answer manifests in the world around you.
