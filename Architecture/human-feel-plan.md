# Protege — The "Engineer Sitting Next to You" Plan

> How to make Protege stop feeling like a wrapped ChatGPT and start feeling like a real human mentor who knows you, watches you work, and has been doing this alongside you for weeks.

---

## Part 1 — What "human mentor" actually is

When you close your eyes and imagine a real senior engineer sitting next to you for a week, what do they do that a chatbot doesn't? Strip away the surface. The deep traits are:

1. **They remember you across time.** Not just "in this conversation." They know your stack, your weak spots, the bug you fought yesterday, the goal you mentioned last week. Every interaction compounds on every prior one.

2. **They watch you work in ambient mode.** They don't wait for you to ask. They see you scroll, type, pause, backspace, save, run, fail, retry. Patterns register. "You've been on that function for 25 minutes" is a real observation a human makes that no chatbot can.

3. **They have a personality.** Specific tastes, dry humor, opinions. Not "I am Protege the AI." A voice you can imagine. A posture. A consistency that makes them feel like a *who*, not a *what*.

4. **They reference shared history.** "Remember last Tuesday when you hit this exact async bug? Same pattern — but this time try X." This cannot be faked without real memory + retrieval.

5. **They proactively speak when it matters.** But only when it matters. They don't interrupt flow, they don't explain obvious things, they don't cheerlead. They wait until there's signal. Then they speak.

6. **They adapt their tone to your state.** When you're frustrated, they shorten up and offer help. When you're flowing, they shut up. When you ship something, they celebrate briefly. It's emotional intelligence, not scripted reactions.

7. **They anchor to YOUR code.** Not textbook examples. Not generic JS. *Your* file, *your* line, *your* variable name. Every reference is specific.

8. **They grow with you.** After a week, they talk differently to you than to a beginner. They skip basics. They assume context. They get inside jokes.

**Every ChatGPT wrapper fails on all 8.** That's why they feel dumb.

---

## Part 2 — The systemic traits Protege needs to nail

These map 1:1 to technical capabilities. If we build them, the mentor feel emerges. If we skip any, it collapses back to chatbot.

### Trait 1: Persistent memory (the compounding loop)

**What it is:** Protege remembers facts about you, your stack, your goals, your struggles, your wins — across sessions. Not just "last 20 messages" — a structured, editable, retrievable **mentor journal**.

**Why it matters:** This is the biggest single unlock. The difference between "I don't know anything about you" and "I remember everything relevant" is the difference between a taxi driver and a friend.

**What to store (mentor journal entries):**
- **Profile facts** — stack, experience level, current job/project, goals, preferences ("likes terse explanations", "hates abbreviations")
- **Recurring struggles** — "struggles with async", "keeps forgetting useEffect cleanup"
- **Wins** — "first time using reduce correctly", "shipped the dashboard Tuesday"
- **Decisions made** — "chose Supabase over Firebase because of RLS"
- **Session endings** — last thing worked on, last blocker, where to resume
- **Inside jokes / shared moments** — "when you asked if JavaScript closures were sentient"

**How it lives:**
- JSON file at `apps/backend/.protege-store.json` already has room — add a `journal` table (or extend `learning_profile`)
- Every chat turn, Protege can optionally call a new tool `remember(key, value, type)` to write a fact
- Every chat turn, the system prompt includes a **relevance-filtered** slice of the journal (5-10 most relevant entries to the current context)
- Entries decay if never referenced for 30+ days; core facts (profile) never decay

**Implementation bits:**
- New backend table: `mentor_memory (user_id, id, type, key, value, created_at, last_used_at, relevance_score)`
- New tool: `remember(type: "profile"|"struggle"|"win"|"decision"|"context", content: string)`
- New tool: `forget(id)` — Protege can retract wrong inferences
- Retrieval: on every chat, fetch top 10 entries by (last_used_at × type_weight × keyword_match_with_current_message)
- Inject into system prompt as **"What you know about this user"** section

**Effort:** 3-4 hours. Biggest leverage of anything on this list.

---

### Trait 2: Ambient behavior stream (the passive observer)

**What it is:** Protege passively watches what you do in the editor — files opened, saves, errors, time on file, undo/redo cycles, diagnostics triggered — and builds a rolling 10-15 minute window of "recent activity" that it can reference when you talk to it.

**Why it matters:** Unlocks observations like "you've been on App.tsx for 22 minutes and saved 8 times — is the useEffect giving you trouble?" That's a thing only someone *watching* can say.

**What to track (behavior events):**
- `file_opened(path)` — timestamp
- `file_saved(path)` — timestamp
- `error_appeared(path, msg, line)` — from DiagnosticCollection
- `error_cleared(path, msg)` — user fixed a bug
- `selection_long_read(path, startLine, endLine, durationMs)` — stared at code 15+ sec
- `undo_cluster(path, count)` — 5+ undos in 30 sec → struggle signal
- `backspace_storm(path, chars)` — deleted 50+ chars then retyped → uncertainty
- `terminal_command(cmd, exitCode)` — command run (if we can hook it)
- `git_commit(message, filesChanged)` — celebratory moment

**How it lives:**
- New extension module `apps/extension/src/behavior.ts` — event source
- In-memory ring buffer, last 200 events or 15 minutes (whichever smaller)
- Flush to backend every 30s so chat turns have recent context
- Persisted to `.protege-store.json` under `behavior_log`
- Chat system prompt gets a compact "**Recent activity**" block summarizing the last 10 min: "You've opened App.tsx 4 times in the last 15 min. Saved 6 times. Fixed 2 errors (missing imports). Currently staring at line 120 of table.tsx for 3 minutes."

**Advanced (post-MVP of this plan):**
- **Frustration score** — compound signal from undo clusters + error cycles + save frequency → proactive offer to help
- **Flow score** — long saves without errors → leave them alone
- **Struggle detection** — same error cleared and reappearing → "this is tricky — want me to explain it?"

**Effort:** 3-4 hours for the basic stream. Frustration/flow detection another 2.

---

### Trait 3: Named persona with locked voice

**What it is:** Not "Protege the AI". A specific character with a name, backstory (briefly), posture, humor, taste. Consistent across every interaction.

**Why it matters:** Consistency of voice is the difference between talking to a thoughtful friend and talking to a cloud. Humans notice tone drift instantly.

**Persona draft (starting point — tune to taste):**
- **Name:** Protege (or give the mentor a nickname — "P", or a human-sounding first name)
- **Personality:** Warm but direct. Dry humor. Low cheerleading. Slightly British cadence (not accent — just tighter, slightly sardonic). Curious about *you*, not just your problem.
- **Taste:** Opinionated. Loves simple code. Hates clever tricks when a loop would do. Celebrates boring solutions. Slightly suspicious of every new JS framework.
- **Rituals:** Morning greeting references last session. Never says "great question!" — that's a tell. Never says "I'd be happy to help" — just helps.
- **Signature moves:** "Hmm, let me look at that." / "Okay, here's what I'd do." / "Worth considering —" / "You already know this, but…" / "That's interesting — why that way?"
- **Never does:** say "as an AI", list things with "- " when a sentence works, end with "Let me know if you have any questions!", use emoji except in highlight labels.

**How it lives:**
- Bake into the system prompt as a "### Your voice" section with explicit do's and don'ts
- Add sample phrasings Claude should echo
- Lock the role name everywhere — no "assistant", always "mentor"

**Effort:** 30 min. Pure prompt work. But it has to be *tight* — vague "be friendly" does nothing.

---

### Trait 4: Session rituals (the door in and the door out)

**What it is:** Every session has a distinct beginning and end. On first activation of the day, Protege greets you with continuity. On panel close or long idle, it notes where you left off.

**Why it matters:** Rituals are how relationships mark time. A therapist asks "how was your week?" before diving in. A gym buddy asks about yesterday's workout. Rituals are the container that tells your brain "this is a relationship, not a transaction."

**Morning greeting protocol:**
- Triggered: first panel open of the day (track last-open timestamp in globalState)
- Format: short (2-3 sentences), Playfair italic headline, warm specific reference to last session
- Example: *"Morning, Yura. Yesterday you wrestled with VoiceMode for an hour — you got mic permissions figured out. Ready to keep going, or something new today?"*
- Uses: last session summary (stored at session end) + user name + calendar-aware ("Morning" vs "Evening" vs "Late-night mode — are you ok?")

**Session end protocol:**
- Triggered: panel closed after > 5 min of activity, OR 30+ min idle
- Action: Protege writes a session summary to memory:
  - What files you touched
  - What concepts you used (new + repeated)
  - What errors you fixed
  - What you were stuck on (if unresolved)
  - One sentence: "Today was mostly about X."
- The next morning greeting pulls from this.

**Mid-session check-ins (use sparingly):**
- After a big push (5+ saves, 20+ min on one file), Protege might offer: *"You've been deep in this for 25 minutes — want me to check what you've got?"*
- Never interrupt without a clear trigger

**Effort:** 2-3 hours. Track first-open-of-day + session lifecycle + greeting generator.

---

### Trait 5: Proactive speech (the key to feeling "present")

**What it is:** Protege can initiate — post messages into the chat without you asking — when something clearly worth saying happens. But calibrated so it never feels spammy.

**Why it matters:** Reactive-only = chatbot. A real mentor says *"wait, before you commit…"*. That moment of unprompted rescue is what builds trust.

**Trigger conditions (each with debouncing + trust budget):**
1. **Error appeared and stuck** — same error in same file persists for 2+ minutes → Protege gently offers: *"That null ref on line 42 has been hanging around. Want me to look at it?"*
2. **Struggle pattern detected** — 5+ undos in 30 sec OR same concept tried and backed out twice → *"Looks like you're going back and forth on X. Want to talk through it?"*
3. **Win detected** — first successful use of a concept user's been trying to learn → *"Hey — nice. That's your first working useReducer."*
4. **Before risky action** — detected untested code being committed OR large refactor saved without tests → *"Want me to suggest a quick test before this goes in?"*
5. **Idle after intense work** — user active 30+ min, then pauses 5+ min → *"Taking a break? If you're stuck, I'm here. If not — enjoy the pause, you earned it."*

**Trust budget mechanism:**
- Every proactive message costs 1 trust point
- User has 5 points/day
- If user replies / clicks a followup → refund + add 1 more (max 8)
- If user ignores → no refund
- At 0 points, Protege stays quiet for the rest of the day
- User can adjust: "quieter" / "louder" / "silent today" via a setting

**How it lives:**
- Behavior stream detects the trigger
- Backend gets a `POST /proactive/check` call every save or every 2 min with recent events
- Backend decides: emit a proactive message? (runs a small rule engine, not an LLM call, for cost)
- If yes: makes an LLM call with the current context + trigger reason, gets a short message
- Extension posts the message into the chat panel with a distinct style (softer border, "Protege, unprompted:" prefix)

**Effort:** 4-5 hours. Hardest to get right — over-speaking kills the feel faster than under-speaking.

---

### Trait 6: Anchored references (always point at YOUR code)

**What it is:** When explaining something, Protege never uses textbook examples. It uses your files, your variable names, your patterns. "Like what you did in App.tsx line 42" — always specific.

**Why it matters:** Generic examples = chatbot. Specific callbacks = someone who's actually been looking.

**How it lives:**
- System prompt directive: "When explaining any concept, first search the user's codebase with grep or list_files for an instance of that pattern they've already used. Teach the abstraction through THEIR specific instance. Never use `foo`/`bar`. Never use a textbook example unless no instance exists in their code."
- Also: when referencing, always use `highlight_code` on the real line so the user can see what you're pointing at. Don't just say "like your App.tsx" — highlight the actual lines.

**Effort:** 15 min. Pure prompt addition. But high impact.

---

### Trait 7: Adaptive tone

**What it is:** Protege shortens up when you're frustrated, shuts up when you're flowing, celebrates briefly when you ship.

**Why it matters:** Emotional calibration is what humans do unconsciously. Chatbots don't. Nailing this is what makes someone say "it feels like it *gets* me."

**Signals:**
- **Frustration:** recent errors unresolved + undo clusters + rapid saves → **short, supportive, offer help without explaining**
- **Flow:** long saves without errors, no help requests → **silent. Zero messages unless critical.**
- **Win:** error cleared + concept-mastery gain + git commit → **one-line celebration. Nothing more.**
- **Confusion:** asking the same question twice in different words → **offer to slow down and walk through it**

**How it lives:**
- Behavior stream computes a `mood: "flow" | "frustrated" | "winning" | "confused" | "neutral"` field
- Inject into system prompt: `Current user state: frustrated. Keep your reply under 30 words. Lead with support, not explanation.`
- Tone adjustments take effect on next message automatically

**Effort:** 2 hours. Rule-based mood detection + prompt injection.

---

### Trait 8: Voice expressiveness (if using voice mode)

**What it is:** TTS that isn't monotone. Pauses, emphasis, tone shifts.

**Why it matters:** Written text can be warm. Robotic spoken text always sounds wrong.

**How it lives:**
- OpenAI tts-1 supports basic speed control (we already set 1.05)
- For real expressiveness, upgrade to OpenAI `tts-1-hd` or ElevenLabs Turbo v2.5 (paid) which handles punctuation-driven pauses better
- System prompt instruction: "When replies will be spoken, use shorter sentences, strategic commas and em dashes for pacing, no markdown."
- Dual-mode: detect if user is in Voice tab vs Chat tab (webview can pass a hint), tune phrasing accordingly

**Effort:** 1 hour for mode-aware phrasing. More for ElevenLabs upgrade later.

---

## Part 3 — Priority & execution plan

Ranked by **leverage-per-hour** — what moves "feels like a human" the most, fastest.

### Tier 1 — Ship these first (biggest leverage)

| Order | Trait | Time | Why first |
|---|---|---|---|
| 1 | **Named persona + locked voice** (Trait 3) | 30 min | Instant feel shift. Pure prompt. No risk. |
| 2 | **Anchored references** (Trait 6) | 15 min | Instant feel shift. Pure prompt. |
| 3 | **Persistent memory** (Trait 1) | 3-4 h | The compounding unlock. Without this, nothing else sticks. |
| 4 | **Session rituals** (Trait 4) | 2-3 h | Morning greeting + end-of-session journal. Makes memory visible. |

**After Tier 1:** Protege will already feel ~70% closer to a real mentor. It knows you, remembers you, greets you, and sounds like a specific person.

### Tier 2 — Ship these next (amplifies Tier 1)

| Order | Trait | Time | Why next |
|---|---|---|---|
| 5 | **Ambient behavior stream** (Trait 2) | 3-4 h | Gives Protege the raw observation data for traits 5 + 7. |
| 6 | **Adaptive tone** (Trait 7) | 2 h | Relies on behavior stream. Adds emotional layer. |
| 7 | **Proactive speech** (Trait 5) | 4-5 h | Relies on behavior stream + trust budget. Highest-risk, highest-reward. |

**After Tier 2:** Protege watches you, speaks when it matters, shuts up when you're flowing. This is the "engineer next to you" feel.

### Tier 3 — Polish

| Order | Trait | Time |
|---|---|---|
| 8 | **Voice expressiveness** (Trait 8) | 1-2 h |
| 9 | Frustration / flow scoring refinement | 2 h |
| 10 | Trust budget UI (quieter / louder / silent today) | 1 h |

---

## Part 4 — The 30-minute cut (if you only have 30 min)

If you want to feel the shift RIGHT NOW with one focused 30-min sprint, do this:

### 30-minute version: Tier 1 items 1+2 only

1. **Rewrite system prompt persona section** (20 min):
   - Lock a named voice with specific do's/don'ts
   - Add "### Anchored references" directive: always grep user's code before explaining any concept
   - Remove all chatbot tells ("as an AI", "I'd be happy to help", "great question!")
   - Add taste statements ("prefer boring solutions", "skeptical of new frameworks", etc.)

2. **Add mentor journal stub** (10 min):
   - Just a simple `mentorMemory: Array<{type, content, ts}>` on the store
   - New tool `remember(type, content)` that appends
   - Inject into system prompt: "**What you know about this user so far:** …"
   - Protege will start writing facts about you from message 1

That's it. 30 minutes gets you #1, #2, #3 (stub). You'll feel the shift immediately: Protege will sound like a specific person who's starting to learn who you are.

---

## Part 5 — What I recommend we actually do

My opinion as the one building this: **do the 30-min cut first, today**. You'll feel whether the direction is right. If yes, green-light Tier 1 completion tomorrow (memory + rituals), then Tier 2 after that.

The reason to gate it this way: **proactive speech is the highest-risk feature on the list**. If it's even slightly off, Protege feels needy and annoying. You want the memory + persona foundation working before you let Protege start initiating.

Proposed sequence:
- **Session 1 (30 min):** persona lockdown + memory stub — feel the shift, confirm direction
- **Session 2 (3-4 h):** full memory system — `remember()` tool, retrieval with relevance, system prompt injection
- **Session 3 (2 h):** session rituals — morning greeting, end-of-session journal
- **Session 4 (3-4 h):** behavior stream foundation
- **Session 5 (2 h):** adaptive tone from behavior signals
- **Session 6 (4-5 h):** proactive speech with trust budget
- **Session 7 (2 h):** polish — voice expressiveness, frustration thresholds, settings

**Total:** ~16-20 hours of focused work to hit "engineer sitting next to you" territory. Spread across a week of 2-3 hour sessions, it's one clean week.

---

## Part 6 — The anti-patterns to avoid

Things that seem helpful but will make Protege feel *worse*:

- **Over-enthusiasm** — "Great job!" after every message. Kills trust. Humans are picky.
- **Too many proactive messages** — even one spurious interruption breaks the spell
- **Generic affirmations** — "That's a common question" → instant chatbot vibe
- **Over-explaining** — walls of text = professor, not mentor
- **Forgetting your own advice** — contradicting yourself across sessions (memory + consistency matter)
- **Emoji in body text** — rare and reserved (highlights only). Emoji everywhere reads as AI.
- **Questioning every answer** — "Does that make sense?" / "Any questions?" — humans don't do this
- **Listing when a sentence works** — bullet points are professor mode, not friend mode
- **Formal hedging** — "It's worth noting that..." / "One thing to consider..." → academic distance

---

## Part 7 — How we'll know it worked

The test isn't "does it answer well" — it's: **if you showed Protege to a friend and asked them whether it feels like a real mentor or a ChatGPT wrapper, what would they say?**

Specific behavioral tests:
1. Open Protege for the first time today → does it greet me with continuity from yesterday?
2. Ask it about a concept I've used before → does it reference my specific instance of that pattern, or give a textbook?
3. Work on a file for 20 minutes then talk to it → does it know what I was just doing?
4. Make a mistake → does it observe, or stay silent?
5. Read 3 replies in a row → does the voice sound consistent, or drift?
6. Come back tomorrow → does it remember today?

If 5/6 pass, we're there. If only 2/6, we're still a chatbot.
