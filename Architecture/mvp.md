# Protege MVP

## What the MVP must do (and nothing else)

Three things. If any one of them is missing, it's not Protege. If anything else is in the MVP, it's bloat.

1. **Catches bugs and errors in your code as you write it**
   Real bugs, shown inline, with a teaching explanation — not just "error here."

2. **Can teach you any topic (AI mentor chat)**
   Sidebar chat where you can say "teach me React hooks" or "why isn't this working?" and Protege responds contextually.

3. **Code IQ — tracks what you actually know**
   A visible score that grows from real code you write. Not fake. Not gamed. Based on what you used, how well, how independently.

Everything else (streaks, skill tree visualization, daily grid, challenges, pairs, Wrapped, badges, learning paths, mutual streaks, onboarding interview) — **skip for MVP**. Add after the core works.

---

## The Stack (decided, don't rethink)

```
Monorepo:      pnpm workspaces
Extension:     TypeScript + VS Code API + React (sidebar webview)
Backend:       Node.js + Hono + Anthropic SDK
Database:      Supabase
Hosting:       Railway ($5/mo for backend)
AI:            Open AI
Local parsing: Tree-sitter (for concept detection without AI)
```

No Next.js website for MVP. No protege.dev. No sharing. No Vercel. Only: **extension + backend + database**.

---

## Build Order (the exact sequence)

### Week 1: Foundations

**Day 1-2: Monorepo setup**
- `pnpm init` at root
- Create `apps/extension`, `apps/backend`, `packages/types`
- Add `pnpm-workspace.yaml`
- Shared `tsconfig.base.json`
- Verify: `pnpm install` works across all packages

**Day 3-4: Hello-world extension**
- Scaffold with `yo code` (TypeScript)
- Register a sidebar webview provider
- Show a simple React app inside with "Hello Protege"
- Add a text input and message list (no backend yet)
- Verify: F5 opens VS Code with the sidebar working

**Day 5-7: Hello-world backend**
- Hono server with one endpoint: `POST /chat`
- Install Anthropic SDK, hardcode API key in env
- Endpoint takes a message, calls Claude Sonnet, returns response
- Deploy to Railway
- Verify: `curl` the endpoint, get a Claude response back

**Milestone end of week 1:** You can run the extension locally, open the sidebar, and... nothing's connected yet.

---

### Week 2: The mentor chat works end-to-end

**Day 8-9: Wire extension → backend**
- Extension calls `POST https://your-backend.railway.app/chat` when user sends a message
- Show the Claude response in the sidebar chat
- Handle loading state + errors

**Day 10-11: Give Claude context about the current code**
- When user sends a message, also send:
  - Current file content (or visible window)
  - File language
  - Any current diagnostics (VS Code has these already)
- Update Claude's system prompt to include this context
- System prompt: "You are Protege, a coding mentor. The user is working on this file: {code}. Be concise, teach through their code, don't be generic."

**Day 12-14: Basic user identity + database**
- Set up PostgreSQL on Neon (free)
- Tables for MVP (start small):
  ```sql
  users (user_id, github_id, username, created_at)
  learning_profile (user_id, experience_level, goals JSONB)
  concept_mastery (user_id, concept_name, mastery_score, times_used, last_used_at)
  ```
- Auth via GitHub OAuth (use `hono/jwt`)
- Store user in DB on first login
- Every chat message now has a `user_id` attached

**Milestone end of week 2:** A working AI mentor chat inside VS Code, with memory of who the user is and what file they're working on. **This alone is already valuable.**

---

### Week 3: Bug and error detection

**Day 15-16: Listen to save events**
- Extension listens to `onDidSaveTextDocument`
- Debounce: wait 3 seconds after save before acting
- Send the saved file to backend: `POST /analyze`

**Day 17-19: Backend analysis endpoint**
- `POST /analyze` takes a file + language + user_id
- Calls Claude with a prompt: "Find up to 3 issues in this code. For each: type (bug/security/performance/tip), line number, short title, explanation tailored for this user's level. Return JSON."
- Parse the JSON response
- Return findings to extension

**Day 20-21: Show findings as inline hints**
- Extension receives findings
- Uses `vscode.DiagnosticCollection` to show squiggly underlines for bugs
- Uses `CodeLensProvider` to show teaching tips above the line
- Click the hint → opens sidebar chat with full explanation

**Milestone end of week 3:** Protege now catches bugs in real code and teaches you about them. This is the core value prop working.

---

### Week 4: Code IQ (real tracking, no fake gamification)

**Day 22-23: Local concept detection**
- Add Tree-sitter to extension
- Load grammars for: JavaScript, TypeScript, Python (start with these 3)
- After every save, parse the file locally
- Detect used concepts from AST patterns:
  - `useState` → "React useState"
  - `async function` → "async/await"
  - `try/catch` → "error handling"
  - `fetch(` → "fetch API"
  - etc.
- Start with ~30 hardcoded detection rules (enough for MVP)

**Day 24-25: Concept mastery scoring (simple version)**
- When a concept is detected in saved code, send to backend: `POST /concept-used`
- Backend updates `concept_mastery`:
  - `times_used += 1`
  - `last_used_at = now`
  - `mastery_score = min(1.0, times_used / 20)` (dead simple formula for MVP)
- No decay, no transfer states, no fancy scoring yet
- Just: "did they use it, and how many times"

**Day 26-27: Code IQ calculation**
- Backend computes overall Code IQ:
  - `code_iq = sum(mastery_score for all concepts) * 10`
  - Capped at 1000
- Expose `GET /me` that returns `{ code_iq, top_concepts, total_concepts }`
- Extension fetches this on activation + after each save

**Day 28: Show Code IQ in status bar**
- Add a VS Code status bar item: `Protege IQ: 247`
- Click it → opens a sidebar tab showing a simple list of concepts they know:
  ```
  Your concepts:
  ✓ async/await (used 14 times)
  ✓ React useState (used 8 times)
  ✓ error handling (used 6 times)
  ...
  ```
- No fancy tree visualization for MVP. Just a list. Boring but honest.

**Milestone end of week 4: MVP COMPLETE.** You have a VS Code extension that:
1. Catches bugs and teaches you about them
2. Lets you chat with an AI mentor about any topic
3. Tracks a real Code IQ based on what you actually code

---

## MVP Database Schema (minimum)

```sql
users (
  user_id     UUID PRIMARY KEY,
  github_id   VARCHAR(64) UNIQUE,
  username    VARCHAR(64),
  created_at  TIMESTAMP DEFAULT NOW()
);

learning_profile (
  user_id           UUID PRIMARY KEY REFERENCES users,
  experience_level  VARCHAR(32),        -- beginner/intermediate/advanced
  goals             JSONB DEFAULT '[]',
  created_at        TIMESTAMP DEFAULT NOW(),
  updated_at        TIMESTAMP DEFAULT NOW()
);

concept_mastery (
  user_id       UUID REFERENCES users,
  concept_name  VARCHAR(128),
  mastery_score DECIMAL(4,2) DEFAULT 0,
  times_used    INTEGER DEFAULT 0,
  last_used_at  TIMESTAMP,
  PRIMARY KEY (user_id, concept_name)
);

chat_messages (
  message_id    UUID PRIMARY KEY,
  user_id       UUID REFERENCES users,
  role          VARCHAR(16),             -- user/assistant
  content       TEXT,
  created_at    TIMESTAMP DEFAULT NOW()
);
```

That's 4 tables. That's the entire MVP database. No streaks, no pairs, no challenges, no badges, no learning paths, no followup queue. Add those later.

---

## MVP Backend Endpoints (minimum)

```
POST /auth/github        → GitHub OAuth callback, creates user
POST /chat               → AI mentor chat, with file context
POST /analyze            → Analyze a saved file, return findings
POST /concept-used       → Record a concept usage
GET  /me                 → Return user profile + Code IQ + concepts
```

That's 5 endpoints. That's it.

---

## MVP Extension Features (minimum)

```
✓ Sidebar webview with AI chat (React)
✓ Watches file saves
✓ Shows bug findings as inline diagnostics + CodeLens tips
✓ Status bar showing Code IQ
✓ Click status bar → shows concept list
✓ GitHub OAuth login (opens browser, returns token)
```

That's it. No skill tree visualization. No daily grid. No streak counter. No onboarding interview. Those come in v0.2.

---

## What to use it for (how you'll test it)

Once MVP is done, YOU use it for a week:

1. **Code something real** — a weekend project, anything.
2. **Save your work** — Protege catches bugs, teaches you.
3. **Ask it stuff** — "why is this slow?" "teach me zustand" "what's the difference between useMemo and useCallback?"
4. **Watch your Code IQ grow** — does it reflect reality? Did it go up in the right skills?

If YOU find it valuable using it yourself → ship it to 10 friends → iterate.
If YOU don't find it valuable → figure out why before adding more features.

**Do not add streaks, daily grids, sharing, pairs, or any virality features until the core three things feel great.** Virality on top of a broken product makes nothing. Virality on top of a great product makes Protege.

---

## What comes AFTER the MVP (in order)

Only after the MVP is used for 2+ weeks and feels right:

**v0.2 — Make it sticky:**
- Onboarding interview (replace hardcoded "beginner" with real assessment)
- Simple skill tree visualization (replace the boring list)
- Streak counter (solo only)
- Follow-up queue (Protege remembers what you struggled with)

**v0.3 — Make it shareable:**
- Daily grid (text only first, then image cards)
- Public profile page (this is where you add Next.js + protege.dev)
- "Share your Code IQ" link

**v0.4 — Make it social:**
- Mutual streaks + pairs
- Challenge a friend

**v0.5 — Make it viral:**
- Daily challenge
- Protege Wrapped
- Tip gallery

Each version ships independently. Ship, use, measure, iterate. Don't build v0.5 before v0.2 is proven.

---

## The one rule

**If a feature isn't: (1) catching bugs, (2) teaching on demand, or (3) tracking real Code IQ — it doesn't belong in the MVP.** Add it in a later version after you know the core works.
