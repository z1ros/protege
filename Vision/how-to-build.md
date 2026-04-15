# Protege — How to Actually Build This

## The Options

### Option 1: VS Code Extension
**What it is:** A plugin that runs inside VS Code. Users install it from the VS Code Marketplace with one click.

**Pros:**
- Lives exactly where developers code — zero friction
- Full access to the editor: read files, highlight code, show inline hints, open panels
- VS Code has ~75 million monthly users — massive distribution
- VS Code Marketplace is a built-in app store with search, ratings, auto-updates
- Extensions can show webviews (basically embedded web pages) for rich UI like skill trees
- Free to publish, no app store fees

**Cons:**
- Limited to what VS Code's extension API allows (it's a lot, but has boundaries)
- UI is constrained to VS Code's layout (sidebar, panels, status bar, notifications, webviews)
- No control over the experience outside the editor
- Performance — heavy AI processing needs to happen server-side, not in the extension

### Option 2: Cursor Extension
**Here's the key fact: Cursor IS VS Code.** Cursor is literally a fork (copy) of VS Code with AI features added on top. Any VS Code extension works in Cursor automatically. You don't build a "Cursor extension" — you build a VS Code extension and it works in both.

Same goes for other VS Code forks: Windsurf, VSCodium, Positron, etc. Build once, works everywhere.

### Option 3: Standalone Desktop App (Electron/Tauri)
**What it is:** A separate application the user downloads and installs.

**Pros:**
- Full control over the UI — can make it beautiful, custom, unique
- Not limited by VS Code's API
- Can work alongside ANY editor, not just VS Code

**Cons:**
- User has to download and install a SEPARATE app — huge friction
- Not inside the editor — breaks the core value prop ("learn where you code")
- Have to build your own update system, distribution, etc.
- Competes for attention with the editor instead of living in it

**Verdict: Bad idea for Protege.** The whole point is being IN the editor.

### Option 4: Web App (protege.dev)
**What it is:** A website where users go to see their skill tree, profile, reports.

**Pros:**
- Easy to build, no installation
- Great for the PUBLIC-FACING parts (profile pages, skill trees, sharing)
- Works on any device
- Can be the viral surface (where shared links land)

**Cons:**
- Not in the editor — can't teach, can't catch bugs, can't do the core job
- Separate tab = friction = forgettable

**Verdict: Not the main product, but ESSENTIAL as a companion.** The extension does the work. The web app is where you show off.

### Option 5: Language Server Protocol (LSP)
**What it is:** A protocol that lets you build a "language server" that works with ANY editor — VS Code, Neovim, Sublime, JetBrains, etc.

**Pros:**
- Build once, works in every editor
- Industry standard — this is how tools like TypeScript, ESLint, Prettier work everywhere

**Cons:**
- LSP is designed for code intelligence (autocomplete, diagnostics, hover info) — not for rich UI
- No webviews, no sidebar panels, no skill tree visualization
- Great for the code analysis part, but not the teaching/gamification part

**Verdict: Use LSP for the code analysis engine underneath, but you still need a VS Code extension for the UI.**

---

## The Best Approach: Hybrid Architecture

```
┌─────────────────────────────────────────────────┐
│                  VS CODE EXTENSION               │
│  (The thing users install — the frontend)        │
│                                                   │
│  ┌──────────┐  ┌──────────┐  ┌────────────────┐ │
│  │ Sidebar  │  │ Inline   │  │   Webview       │ │
│  │ Chat /   │  │ Hints /  │  │   Panels        │ │
│  │ Mentor   │  │ CodeLens │  │   (Skill Tree,  │ │
│  │ Panel    │  │ / Hovers │  │    Reports,     │ │
│  │          │  │          │  │    Challenges)  │ │
│  └──────────┘  └──────────┘  └────────────────┘ │
└───────────────────┬─────────────────────────────┘
                    │ API calls
                    ▼
┌─────────────────────────────────────────────────┐
│              PROTEGE CLOUD (Backend)             │
│                                                   │
│  ┌──────────┐  ┌──────────┐  ┌────────────────┐ │
│  │ AI       │  │ Skill    │  │   User          │ │
│  │ Engine   │  │ Tracking │  │   Profiles /    │ │
│  │ (Claude  │  │ & Code   │  │   Auth /        │ │
│  │  API)    │  │ IQ       │  │   Social        │ │
│  └──────────┘  └──────────┘  └────────────────┘ │
└───────────────────┬─────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────┐
│              PROTEGE.DEV (Web App)               │
│                                                   │
│  Public profiles, shareable skill trees,          │
│  weekly report cards, challenge landing pages,    │
│  Protege Wrapped, leaderboards                    │
└─────────────────────────────────────────────────┘
```

### Layer 1: VS Code Extension (The Frontend)

This is what the user interacts with. Built with:

**Tech stack:**
- TypeScript (VS Code extensions must be TS/JS)
- VS Code Extension API for editor integration
- Webview panels (basically React/HTML inside VS Code) for rich UI like skill trees
- Real-time communication with backend via WebSocket or REST API

**What it does:**
- Onboarding chat (sidebar panel with conversational UI)
- Inline code hints (CodeLens, diagnostics, hover providers)
- Teaching overlays (highlight code, show annotations, guide exercises)
- Skill tree visualization (webview with interactive SVG/Canvas)
- Streak counter and daily grid (status bar + webview)
- Notifications (VS Code notification API)
- Share buttons that generate cards and links

**Key VS Code APIs you'll use:**
- `vscode.languages.registerCodeLensProvider` — show inline hints above code
- `vscode.languages.registerHoverProvider` — show teaching tips on hover
- `vscode.window.createWebviewPanel` — rich UI panels (skill tree, reports)
- `vscode.window.createStatusBarItem` — streak counter, Code IQ display
- `vscode.workspace.onDidChangeTextDocument` — watch code in real-time
- `vscode.workspace.onDidSaveTextDocument` — analyze on save
- `vscode.window.showInformationMessage` — notifications
- `vscode.commands.registerCommand` — custom commands

### Layer 2: Protege Cloud (The Backend)

This is where the intelligence lives. The extension is thin — it sends code to the backend, backend does the thinking, sends results back.

**Tech stack options:**
- **Server:** Node.js/TypeScript (same language as extension = shared types) or Python (better AI/ML ecosystem)
- **Database:** PostgreSQL (user data, skill tracking) + Redis (streaks, real-time state)
- **AI:** Claude API for mentoring, code analysis, tip generation, challenge creation
- **Auth:** OAuth (GitHub login — developers already have GitHub accounts)
- **Hosting:** Vercel/Railway/Fly.io to start, AWS/GCP when you scale

**What it does:**
- Receives code snippets from the extension, analyzes them with AI
- Tracks skill progression over time (what skills used, when, how well)
- Calculates Code IQ scores
- Manages streaks (solo + mutual)
- Generates daily challenges
- Generates weekly reports and Wrapped summaries
- Stores user profiles, social connections, challenge data
- Serves the AI mentor responses (routes to Claude API)

### Layer 3: protege.dev (The Web App)

This is the viral surface — where shared links land and public profiles live.

**Tech stack:**
- Next.js (React framework, great for SEO, fast, easy to deploy)
- Same database as the backend (reads user data)
- Open Graph meta tags (so shared links look great on Twitter/Discord/LinkedIn)

**What it does:**
- `protege.dev/username` — public skill tree profile
- `protege.dev/challenge/abc123` — challenge landing page ("Alex challenged you to learn React in 14 days — accept?")
- `protege.dev/wrapped/2026` — yearly wrapped view
- `protege.dev/report/weekly/username` — shareable weekly report
- Marketing/landing page for new users
- Install link that deep-links to VS Code Marketplace

---

## What to Build First (MVP in 4-6 Weeks)

### Week 1-2: The Extension Shell
- VS Code extension that activates on startup
- Sidebar panel with a simple chat UI (text input + messages)
- Connect to a backend that routes to Claude API
- The chat can: ask your level, ask your goals, have a basic conversation
- Status bar item showing "Protege" (placeholder for streak/IQ later)

### Week 3-4: The Teaching Engine
- Extension watches the active file (`onDidChangeTextDocument`)
- On save, sends the code to backend for analysis
- Backend uses Claude to identify: bugs, improvements, learning opportunities
- Results appear as inline CodeLens hints ("Protege tip: did you know...")
- User can click a hint to get the full explanation in the sidebar chat

### Week 5-6: Skill Tracking + Daily Grid
- Backend tracks which concepts the user demonstrates in code
- Simple skill list (not full tree yet) with levels
- Daily coding activity → generates the daily grid
- "Share" button that copies the grid as text + generates an image card
- Basic streak counter in status bar

**That's your MVP.** It's a VS Code extension that:
1. Talks to you about coding (AI mentor)
2. Watches your code and teaches you things (inline tips)
3. Tracks your skills and shows daily progress (shareable grid)

Everything else (mutual streaks, challenges, Wrapped, skill tree visualization, web profiles) builds on top of this foundation.

---

## The Tech You'll Need to Learn

If you don't know these yet, here's the priority order:

1. **VS Code Extension API** — start here. The official docs + "Your First Extension" tutorial gets you a working extension in 30 minutes. Everything else builds on this.
   - Resource: VS Code Extension docs (code.visualstudio.com/api)
   - Resource: "yo code" generator scaffolds the boilerplate

2. **TypeScript** — required for VS Code extensions. If you know JavaScript, TypeScript is a small jump.

3. **Claude API / Anthropic SDK** — for the AI brain. Simple REST API, send a prompt, get a response.

4. **Basic backend** (Node.js + Express or Next.js API routes) — to sit between the extension and Claude API, and store user data.

5. **PostgreSQL** — for storing skills, streaks, user profiles.

6. **Webview API** — for rich UI inside VS Code (skill tree, reports). This is basically building a small React app that runs inside a VS Code panel.

---

## Quick Start: Your First Command

Here's conceptually what the very first prototype looks like:

```
1. Run: npx --package yo --package generator-code -- yo code
2. Pick "TypeScript" extension
3. This gives you a working extension with one command
4. Modify it to:
   - Register a sidebar webview (your chat panel)
   - Listen for file changes
   - On save: send the file content to your backend
   - Backend calls Claude API: "analyze this code for a [beginner]. Find one thing to teach."
   - Show the response as a VS Code notification or in the sidebar
5. That's Protege v0.0.1
```

From there, every feature is incremental. Add skill tracking. Add the daily grid. Add streaks. Add the share button. Each one is a small addition to a working product.

---

## VS Code vs. JetBrains vs. Other Editors

**Start with VS Code only.** Here's why:
- VS Code has ~75M monthly users (largest editor by far)
- Cursor, Windsurf, and other forks get your extension for free
- VS Code extension development is the easiest (TypeScript, great docs, huge community)
- JetBrains (IntelliJ, WebStorm, PyCharm) uses a completely different plugin system (Kotlin/Java) — that's a separate engineering effort
- Neovim/Vim plugins are another world entirely

**When to expand:** After you have 10,000+ VS Code users and proven product-market fit. Not before. Don't split your focus early.

---

## Summary

| Component | What | Tech | Build When |
|-----------|------|------|------------|
| VS Code Extension | The product users interact with | TypeScript + VS Code API | Week 1 (MVP) |
| Backend API | AI brain + data storage | Node.js + Claude API + PostgreSQL | Week 1 (MVP) |
| Web App (protege.dev) | Public profiles + viral landing pages | Next.js | Month 2-3 |
| Skill Tree Webview | Rich visualization inside VS Code | React in VS Code Webview | Month 2 |
| Daily Challenge System | Synchronized global challenges | Backend cron + real-time sync | Month 3-4 |
| Mutual Streaks | Social accountability system | Backend + push notifications | Month 2-3 |
| Protege Wrapped | Yearly/quarterly identity reports | Backend data aggregation + web app | Month 6+ |

**The bottom line:** Build a VS Code extension (works in Cursor too). Keep it thin — the AI and data live on your backend. Add a web app later for the viral/sharing surface. Start with chat + inline tips + daily grid. Ship in 4-6 weeks. Everything else is iteration.
