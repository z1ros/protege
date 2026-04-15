# Protege Build Plan

> Gap analysis + mission-based execution plan. Each mission is designed as one focused session — paste the mission prompt into a new Claude chat to keep context clean.

---

## 1. Reality check — where we actually are

After a rigorous audit of the codebase vs `mvp.md`:

| Pillar | Required for MVP | Today | Gap |
|---|---|---|---|
| **1. Catches bugs inline + teaches** | save listener → `/analyze` → DiagnosticCollection + CodeLens | Backend `/analyze` works. **Extension has no save listener, no DiagnosticCollection, no CodeLens.** | **10% done** |
| **2. AI mentor chat** | sidebar chat w/ file context | Working end-to-end w/ gpt-4.1. No history persistence, no user identity. | **90% done** |
| **3. Code IQ (real tracking)** | tree-sitter → concept detection → DB → `/me` → status bar | None of it. Tree-sitter not installed. No DB. `/concept-used` and `/me` are stubs. Status bar shows a label, not a number. | **5% done** |

**Overall: ~35% of MVP spec. We have a pretty chatbot and an empty shell for everything else.**

### The 7 hard blockers

1. **Supabase not wired up** — package in `package.json` but never imported. Zero tables, zero migrations.
2. **No GitHub OAuth** — every API call is anonymous. Can't track anyone.
3. **Extension doesn't listen to saves** — no `onDidSaveTextDocument`. `/analyze` is unreachable from the editor.
4. **No `DiagnosticCollection`** — can't show red squiggles.
5. **No `CodeLensProvider`** — can't show clickable tips above lines.
6. **No tree-sitter + no detection rules** — Code IQ has no input signal.
7. **Voice mode almost certainly broken in Cursor** — VS Code webview CSP blocks `getUserMedia` and the Web Speech API is unavailable inside Electron webviews. Voice will fall through to the "unavailable" branch. Not an MVP feature per spec anyway — it's in v0.2+.

---

## 2. What the docs actually want (from Vision + Architecture research)

### The 5 core unlocks
1. **Continuous passive code analysis inside the editor.** The magic is presence during real work, not a chatbot you visit.
2. **Skill tree earned, not gamified.** Skills light up from real behavioral evidence. No quizzes.
3. **Artifact-first virality** (grid / challenges / wrapped). *Post-MVP.*
4. **Teach through thinking, not syntax.** Ask "what do you think will happen?" before revealing.
5. **Centralized intelligence.** Extension is thin; backend holds all reasoning, learns from aggregate data.

### Critical data model (MVP slice)
```
users              (user_id, github_id, username, created_at)
learning_profile   (user_id, experience_level, goals JSONB)
concept_mastery    (user_id, concept_name, mastery_score, times_used, last_used_at)
chat_messages      (message_id, user_id, role, content, created_at)
```

### Critical algorithms (MVP slice — keep dead simple)
- **Concept detection:** tree-sitter AST match against ~30 hardcoded rules (useState, async/await, try/catch, fetch, etc.)
- **Mastery scoring:** `mastery_score = min(1.0, times_used / 20)` — no decay, no quality weighting for MVP
- **Code IQ:** `code_iq = clamp(sum(mastery_score across concepts) × 10, 0, 1000)`

Everything fancier (multi-signal verification, transfer state, behavioral interpretation, decay, spaced repetition) is **post-MVP** per the architecture docs. Ship the simple version, use it for a week, then layer.

---

## 3. Mission-based execution plan

Each mission is **one session of work, one clean context**. For each mission you'll start a new Claude Code chat, paste the mission prompt, and let it run. When done, close the session and start the next mission. Missions are ordered strictly by blocker dependency.

### Mission sequence

```
M0. Voice reality check           30 min
M1. Supabase + schema              2-3 h    ← unblocks M2, M6, M7, M8
M2. GitHub OAuth                   3-4 h    ← unblocks user identity everywhere
M3. File save listener + /analyze wiring
     + DiagnosticCollection        2 h
M4. CodeLensProvider + tip → chat  2 h
M5. Tree-sitter concept detection  3-4 h
M6. /concept-used + /me wired to DB
     + Code IQ calculation         2 h
M7. Status bar live Code IQ        1 h
M8. Chat history persistence       1.5 h
M9. Self-dogfood week              1 week
```

Total: ~16 hours of focused work + 1 week of real use. That's the MVP.

---

## 4. Missions

### M0 — Voice reality check (30 min)

**Goal:** Decide: fix voice, drop voice, or leave fallback UI. Voice is not in the MVP spec — it's a v0.2+ feature we added prematurely.

**Prompt:**
> Audit `apps/extension/webview/VoiceMode.tsx` and the CSP in `apps/extension/src/webviewHost.ts`. Determine if the Web Speech API (`SpeechRecognition`, `speechSynthesis`) and `navigator.mediaDevices.getUserMedia` can work inside a VS Code webview panel running inside Cursor. Report: does it work, does it partially work, or does it fail silently? If it fails, delete `VoiceMode.tsx`, remove the Voice tab from `App.tsx`, and update styles accordingly. Voice is not an MVP feature and we don't want half-broken UI.

**Acceptance:** Either voice works (rare, report how to test) OR voice tab is cleanly removed and chat mode takes the full UI.

---

### M1 — Supabase setup + schema (2-3 h)  🔴 BLOCKER

**Goal:** Stand up Supabase, create 4 MVP tables, wire a `db.ts` helper in the backend.

**Prompt:**
> Read `Architecture/mvp.md` section "MVP Database Schema" and `Architecture/build-plan.md` section 2. We need to set up Supabase for the Protege backend.
>
> Tasks:
> 1. Create `apps/backend/src/db.ts` that instantiates a Supabase client from `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` env vars.
> 2. Create `apps/backend/supabase/migrations/001_init.sql` with the 4 MVP tables: `users`, `learning_profile`, `concept_mastery`, `chat_messages`. Exact DDL is in `mvp.md`.
> 3. Wire the `db` client into `routes/concept.ts` and `routes/me.ts` — replace the TODO stubs with real queries. For `/concept-used`: upsert into `concept_mastery`, increment `times_used`, update `last_used_at`, recompute `mastery_score = min(1.0, times_used / 20)`. For `/me`: query `concept_mastery` for a user, sum mastery scores × 10, return top concepts.
> 4. Add a `GET /health/db` route that does a trivial query and returns `{ok: true}` so we can verify the connection.
>
> Don't implement auth yet — for now accept a `userId` query param or body field, we'll replace with real auth in M2. Do NOT ask me to create the Supabase project — just tell me the exact click-by-click steps at the end so I can set it up and paste keys into `.env`.

**Acceptance:** `curl localhost:8787/health/db` returns `{ok:true}`. `curl -X POST /concept-used` with `{userId, conceptName}` actually persists a row. `curl /me?userId=...` returns a real Code IQ.

---

### M2 — GitHub OAuth (3-4 h)  🔴 BLOCKER

**Goal:** Real user identity. Every API call carries a user.

**Prompt:**
> Implement GitHub OAuth for Protege. Read `Architecture/mvp.md` and `Architecture/build-plan.md` first.
>
> Backend tasks:
> 1. Create `apps/backend/src/routes/auth.ts` with `GET /auth/github/start` (returns GitHub authorize URL) and `GET /auth/github/callback` (exchanges code → access token → fetches GitHub user → upserts into `users` table → returns a JWT using `hono/jwt`).
> 2. Add a JWT middleware that reads `Authorization: Bearer <token>` and sets `userId` on the context.
> 3. Protect `/chat`, `/analyze`, `/concept-used`, `/me` with the middleware.
>
> Extension tasks:
> 4. Add `apps/extension/src/auth.ts` using `vscode.authentication.getSession('github', [...])` — VS Code has a built-in GitHub auth provider, use it.
> 5. Store the token via `vscode.SecretStorage`.
> 6. Update `webviewHost.ts` fetch calls to include `Authorization: Bearer <token>`.
>
> Don't ask me to create a GitHub OAuth app yet — give me the exact steps at the end with the callback URL to register.

**Acceptance:** First extension launch prompts for GitHub login. After login, `/me` returns a real user. A token is persisted so subsequent launches skip login.

---

### M3 — File save listener + DiagnosticCollection (2 h)

**Goal:** The first MVP pillar starts working end-to-end.

**Prompt:**
> Read `Architecture/mvp.md` Week 3 section and the current `apps/extension/src/extension.ts`.
>
> Tasks:
> 1. In `activate()`, register `vscode.workspace.onDidSaveTextDocument` with a 3-second debounce per file.
> 2. On debounced save, POST the file content to `http://localhost:8787/analyze` with `{file: {path, language, content}}` and the auth token.
> 3. Create a `vscode.DiagnosticCollection` named `protege`.
> 4. Map the returned `findings[]` to `vscode.Diagnostic` objects. Severity mapping: `bug|security` → Error, `performance` → Warning, `tip` → Information.
> 5. Set diagnostics on the file URI.
> 6. On document close, clear diagnostics for that URI.
>
> Keep it small — no CodeLens yet (that's M4). No concept detection yet (M5). Just make red squiggles appear after save.

**Acceptance:** Save a buggy file → 3 seconds later → red squiggles appear on buggy lines with hover text showing the finding title + explanation.

---

### M4 — CodeLensProvider + tip → chat link (2 h)

**Goal:** Clickable teaching tips above buggy lines. Click → opens Protege panel with the full explanation ready.

**Prompt:**
> Building on M3's DiagnosticCollection. Add a `vscode.CodeLensProvider` that surfaces each finding as a clickable CodeLens above its line with the title. Clicking the CodeLens should:
> 1. Open the Protege panel (use `openProtegePanel(context)` from `panel.ts`)
> 2. Post a message to the webview to prefill a chat prompt with the finding's explanation
> 3. Auto-send that prompt so the user sees Protege teaching about the issue immediately
>
> Add a new message type `webview/teach` in `packages/types/src/index.ts` that the extension posts to the webview. The webview should handle it by appending both a user message ("Why is this a bug?") and triggering a chat send. Read current `webview/App.tsx` to understand the message bus.

**Acceptance:** Click a CodeLens tip → panel opens → chat auto-asks about that specific finding → Protege responds with a teaching explanation.

---

### M5 — Tree-sitter concept detection (3-4 h)

**Goal:** Code IQ has input. Save a file → concepts detected locally → sent to backend.

**Prompt:**
> Read `Architecture/mvp.md` Week 4 Day 22-23 section. We need local concept detection via tree-sitter inside the VS Code extension.
>
> Tasks:
> 1. Add `web-tree-sitter` + WASM grammars for JS, TS, Python to `apps/extension/package.json`. Use the WASM variant so we don't need native builds.
> 2. Create `apps/extension/src/concepts/detector.ts` that takes `(filePath, language, content)` and returns `string[]` of detected concept names.
> 3. Create `apps/extension/src/concepts/rules.ts` with ~30 detection rules for JS/TS/Python:
>    - JS/TS: useState, useEffect, async/await, try-catch, fetch, Promise.all, array methods (map/filter/reduce), destructuring, spread, arrow functions, classes, imports, error handling, regex
>    - Python: list comprehension, decorators, with-statement, try-except, f-string, async/await, type hints
>    Each rule has `{name, language, match: (node) => boolean}` where node is a tree-sitter AST node.
> 4. Run the detector on every saved file (piggyback on the M3 save listener).
> 5. POST detected concepts to `/concept-used` as `{userId, concepts: string[]}`.
>
> Keep rules simple: one-line pattern matches. This is the MVP. No quality scoring, no context checks. Just "is this pattern present."

**Acceptance:** Save `const [x, setX] = useState(0)` → extension logs "detected: React useState" → backend `/concept-used` called → `concept_mastery` row upserted.

---

### M6 — Code IQ calculation + /me response (already partially in M1)

If M1 was done fully, this is mostly done. Verify `/me` returns:
```json
{
  "userId": "...",
  "username": "...",
  "codeIq": 42,
  "totalConcepts": 8,
  "topConcepts": [
    {"name": "React useState", "mastery": 0.4, "timesUsed": 8}
  ]
}
```

If M1 only stubbed this, write a focused follow-up prompt to finish it.

---

### M7 — Status bar live Code IQ (1 h)

**Prompt:**
> Replace the static `$(shield) Protege` label in the status bar with a live Code IQ number. On extension activation and after every file save, fetch `GET /me`, extract `codeIq`, update the status bar to `$(shield) Protege IQ: 247`. Clicking the status bar should open the Protege panel and switch to a "Concepts" view showing a list of mastered concepts (you'll need to add this as a second tab in `App.tsx`). Read current `apps/extension/src/extension.ts` and `webview/App.tsx` first.

**Acceptance:** Status bar shows a live number. Click it → panel opens on a Concepts tab listing all mastered concepts.

---

### M8 — Chat history persistence (1.5 h)

**Prompt:**
> Currently chat history is in-memory in the webview. When the panel closes it's gone. Persist it per user.
>
> 1. In `/chat` POST, after getting the reply, insert both the user message and assistant reply into `chat_messages` (we already have the table from M1).
> 2. Add `GET /chat/history?limit=50` that returns the user's recent messages.
> 3. On webview mount, fetch history and prefill the messages array.
> 4. Send the last 10 messages as `history` in future `/chat` requests so Claude has context.

**Acceptance:** Close panel, reopen → chat history is there. Ask follow-up questions → Protege remembers context.

---

### M9 — Self-dogfood week (1 week)

You use Protege on a real side project for 7 days. Write down:
- Every time it caught a real bug
- Every time it annoyed you (false positive, too noisy, wrong timing)
- Every time it taught you something you didn't know
- How your Code IQ grew and whether it felt honest

If the 3 pillars work: ship to 10 friends. If they don't: fix the specific pain before adding any v0.2 features.

---

## 5. Post-MVP roadmap (after M9)

Per the vision docs, ship versions independently. Each version ~1-2 weeks.

- **v0.2 — stickiness:** onboarding interview (replace hardcoded `beginner`), skill tree visualization (replace the concept list), solo streaks, followup queue
- **v0.3 — sharing:** daily grid (text + image), `protege.dev` public profiles, "share your Code IQ"
- **v0.4 — social:** mutual streaks, pairs, challenge-a-friend
- **v0.5 — viral:** daily global challenge, Protege Wrapped, tip gallery

**Do not touch v0.2+ until M9 dogfood proves M1-M8 feel right.**

---

## 6. How to execute this

1. Start a new Claude chat for each mission.
2. Open this file → copy the mission prompt → paste into the new chat.
3. Add `Read Architecture/build-plan.md first.` at the top of the prompt so Claude has full context.
4. Let the mission run to acceptance criteria.
5. Commit the work with `git commit -m "M<N>: <mission title>"`.
6. Close the session. Start the next mission.

**Why session-per-mission:** each mission is focused enough that Claude can stay sharp. Long conversations across all 9 missions would bloat context and degrade decisions.

---

## 7. What we are NOT building (yet)

The vision docs list lots of features. Nothing below is MVP:
- Three Modes (Learn/Build/Master) — behavior is implicitly Build mode for MVP
- Onboarding interview (v0.2)
- Skill tree visualization (v0.2 — MVP shows a boring list)
- Streaks (v0.2)
- Followup queue (v0.2)
- Daily grid / sharing / public profiles (v0.3)
- Mutual streaks / pairs (v0.4)
- Daily challenge / Wrapped / tip gallery (v0.5)
- Voice mode (not in MVP spec at all — we added it speculatively)
- Code decay / spaced repetition (post-MVP)
- Multi-signal mastery scoring (post-MVP; MVP uses `times_used/20`)
- Behavioral interpretation (undo/redo, definition jumps) (post-MVP)
- WebSocket streaming (post-MVP)

If a feature isn't one of: (1) catching bugs, (2) teaching on demand, (3) tracking real Code IQ — **it doesn't belong in the MVP.** — `mvp.md`
