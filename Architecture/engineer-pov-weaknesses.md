# Protege: An Engineer's Daily Experience (Honest)

## 9:00 AM — I open VS Code

**What happens:** Protege panel opens. Empty chat with cinematic roses. "What do you want to learn today?"

**What JARVIS would do:** "Morning. Yesterday you were working on the auth flow in `auth.ts` — you left an unresolved error on line 42 (`fetchUser` returns `null` but you're not handling it). Also, your 8-day streak is still alive. Want to pick up where we left off?"

**The gap:** Protege has the session system (`openSession()` in store.ts) and the memory system, but the chat never uses yesterday's context on first open. The `buildEngagePrompt()` function exists for nudges but there's no "morning greeting with context" flow.

---

## 9:15 AM — I start writing a React component

**What happens:** Nothing. Protege is completely blind until I save. I spend 10 minutes writing a component with a useEffect that has a stale closure bug. Protege doesn't know.

**What JARVIS would do:** As I write `useEffect(() => { setCount(count + 1) }, [])` — an inline hint appears: "⚠ `count` is captured in the closure but not in the dependency array. This will always increment from the initial value."

**The gap:** The watcher tracks cursor movement and edit events, but it doesn't PARSE what I'm writing. It knows I'm typing. It doesn't know I'm writing a buggy useEffect. Real-time AST analysis on a debounced keystroke would catch this.

---

## 9:30 AM — I save the file

**What happens:** AST detector finds 18 concepts. Analyzer sends to Claude. 3 seconds later, findings appear as highlights. "+12 IQ" toast. Good.

**What's wrong:** The findings are generic. Claude sees the code fresh every time. It doesn't know:
- I've struggled with dependency arrays before (memory: "struggle" type)
- I fixed this same bug in a different file last week (memory: "win" type)
- My Quality pillar is low because of recurring useEffect issues

The analyzer prompt (`ANALYZE_PROMPT` in analyze.ts) says "find up to 3 issues" — it doesn't include ANY context about the user. It's the same prompt for a beginner and a senior engineer.

**What JARVIS would do:** The analyze prompt would include: "This user has a recurring struggle with useEffect dependencies (flagged 4 times this month). When you find a dependency array issue, explain the closure mechanism specifically — they learn best from concrete examples, not abstract rules."

---

## 10:00 AM — I ask Protege to explain closures

**What happens:** I type "teach me about closures" in the chat. Protege responds with a good explanation. Highlights some code. Shows a followup chip: "Want to see this in your code?"

**What's wrong:** The explanation is READ-ONLY. I read it, I nod, I move on. Did I actually learn? Unknown. There's no:
- Quick exercise: "Here's a function with a closure bug. Fix it."
- Verification: "You fixed it! The issue was X because Y."
- Spaced repetition: "I'll ask you about this again in 3 days."

**What JARVIS would do:**
1. Explain closures using MY code (the buggy useEffect from earlier)
2. Create a 10-line scratch file with a similar bug: "Fix this one"
3. Watch me edit the scratch file
4. When I save, check if I got it right
5. If yes: "Perfect. That's the pattern. +15 IQ for closures."
6. If no: "Close — but look at line 4. The variable is captured at creation time, not at call time."

---

## 10:30 AM — I've been stuck on a TypeScript error for 5 minutes

**What happens:** Watcher fires `error_persists` nudge: "You've had this error for a while. Want me to look?" I click "Help me."

**What's wrong:** The nudge text is generic. It doesn't include the ACTUAL error. When I click "Help me," it sends a synthetic prompt to Claude: "I've got this error stuck in auth.ts on line 42." But it doesn't include:
- The error message itself
- The surrounding code
- What I've already tried (the watcher tracked 3 undo cycles — I tried something and reverted)

**What JARVIS would do:** The nudge card itself would show the error analysis:
```
Line 42: Type 'User | null' is not assignable to type 'User'

You're calling fetchUser() which can return null when the session
expires. You need a null check.

[Fix it for me]  [Explain why]  [Dismiss]
```

No need to click "Help me" and wait for Claude. The analysis is instant because the on-device model (Qwen2.5-Coder) already ran when the error appeared.

---

## 11:00 AM — I look at the Concepts dashboard

**What happens:** I see a big "423" IQ number. A trajectory chart (FAKE — 3 years of mock data). A skill tree with 1,395 nodes, 97% dark. A percentile card (FAKE — "Top 18%"). A mistakes card (FAKE). A radar chart (FAKE).

**What's wrong:** I KNOW this data is fake because I've been using the tool for one day. The trajectory shows 3 years of growth I never had. The percentile compares me against users that don't exist. It feels like a toy, not a tool.

**What JARVIS would do:** Show ONLY real data:
- "IQ 423 — you've been coding for 1 day"
- Trajectory: one data point (today). "Come back tomorrow to see your trend."
- Percentile: "Sign in to see where you rank" (or real data if Supabase is connected)
- Mistakes: "2 recurring issues: useEffect deps + missing null checks" (from real findings)
- Radar: 5 pillars from the actual pillar computation (this IS real, just not connected to the chart)

---

## 12:00 PM — I close the panel and go to lunch

**What happens:** All chat messages are gone. The nudge I dismissed is gone. The context of our morning conversation is gone.

**What JARVIS would do:** When I reopen at 1 PM, the chat shows my morning messages. The session continues. Protege says: "Welcome back. Before lunch you were working on the auth flow. The TypeScript error on line 42 is still there — want to fix it now?"

---

## 2:00 PM — I write a test file

**What happens:** AST detector fires on save. Detects "describe", "it", "expect". Records concepts. "+5 IQ."

**What's wrong:** Protege doesn't connect the test to what it's testing. It doesn't know that `auth.test.ts` tests `auth.ts`. It doesn't notice that I finally wrote a test for the function that kept failing. It doesn't celebrate: "You wrote a test for `fetchUser`! That's the function that was giving you trouble. Your React+Testing synergy just activated."

**What JARVIS would do:** Understand the import graph. Know that `auth.test.ts` imports from `auth.ts`. Recognize that the tested function was the source of today's struggle. Award a "testing what you build" synergy bonus. Show a warm acknowledgment, not just "+5 IQ."

---

## 4:00 PM — I'm about to commit

**What happens:** Nothing. I `git add . && git commit`. Protege doesn't know.

**What JARVIS would do:** Before the commit, a subtle notification: "You're committing 4 changed files. Quick scan found 1 issue in `utils.ts` — unused import on line 3. Also, you haven't written tests for the new `formatDate()` function. Want me to generate one?"

---

## The 10 real weaknesses (prioritized)

| # | Weakness | Impact | Effort to fix |
|---|---|---|---|
| 1 | **No morning context** — doesn't use session/memory on first open | High — feels like talking to a stranger every day | Low — inject session data into first chat response |
| 2 | **No inline teaching as you type** — blind between saves | Critical — 90% of coding time is unmonitored | High — needs real-time AST analysis |
| 3 | **Analyzer doesn't use user memory** — same prompt for everyone | High — findings are generic, not personalized | Low — inject memories into analyze prompt |
| 4 | **Teaching is read-only** — no exercises, no verification | High — reading ≠ learning | Medium — scratch file exercises with save-check |
| 5 | **Chat lost on reload** — no conversation persistence | Medium — breaks continuity | Medium — save to globalState or Supabase |
| 6 | **Dashboard 60% fake** — mock data everywhere | High — destroys trust | Medium — wire real data, kill mocks |
| 7 | **Nudges are generic** — template text, no actual error analysis | Medium — "want me to look?" is useless without context | Medium — include error message + on-device analysis |
| 8 | **No test↔code connection** — doesn't know what tests test what | Medium — misses synergy + celebration opportunities | Medium — import graph analysis |
| 9 | **No pre-commit review** — can't see git state | Medium — misses a key mentor moment | Medium — git API integration |
| 10 | **No spaced repetition** — teaches once, never revisits | Low now, high long-term — forgetting curve is real | High — needs a scheduling system |
