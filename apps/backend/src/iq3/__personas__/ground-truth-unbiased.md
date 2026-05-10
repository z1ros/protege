1) # Code IQ Ground Truth — Unbiased Calibration

These personas were authored as a blind check on the existing implementation. The scores below were chosen from general industry intuition about developer proficiency — what a senior engineering manager would assign when calibrating fresh hires — without consulting the implementation, the existing personas, the design spec, the pillar weights, or the rank band thresholds. Treat these as an independent ground truth: if the system disagrees materially with these, it's a signal worth investigating before the personas are used as a benchmark.

## Scoring scale assumption

I'm anchoring on these bands when I write headline scores. The team should compare these to whatever the system actually uses; mismatch is itself useful signal.

- **Learner**: 0–350 — first weeks to first months, can read code with help, can't yet ship without a sitter
- **Junior**: 350–550 — 0–2 years, ships features under guidance, blind spots show under pressure
- **Mid**: 550–750 — 3–7 years, autonomous on routine work, knows their gaps, asks well
- **Senior**: 750–900 — 8+ years, owns architecture, mentors, sees second-order effects
- **Staff/Principal**: 900+ — exceptional reach, reserved for outliers; not a rank in this rubric but the ceiling above Senior

I'm assuming a typical senior lands around 800, a typical mid around 650, a typical junior around 450. I'm reserving the 900s for the wildcard polyglot. Nobody hits 1000 — that would mean perfection in every pillar, which doesn't exist.

A note on AI Partnership: I'm scoring it as a real skill. A developer who refuses to use AI scores low (250–400) — same band as someone who pastes everything blindly. Both fail to leverage the tool. The high scorers are people who prompt with structure, validate output, and know when to delegate vs. verify by hand.

---

## Persona 1: The Bootcamp Grad in Month Two

**Identity:** 3 months experience, web (frontend-leaning), first job as a Junior at a small SaaS company

**Background:** Finished a 14-week full-stack bootcamp, hired into a React + Node shop. Earnest, anxious, learning fast. Spends evenings in tutorials. Knows what `useState` does but isn't sure why `useEffect` ran twice in dev. Reaches for ChatGPT for almost everything.

**Behavioral signature:**
- Opens unfamiliar file: scrolls top to bottom once, gets overwhelmed, asks AI to "explain this file." Doesn't yet know which questions are the right ones.
- Prompts AI: copy-pastes the whole error and the whole file. Accepts the first answer if it compiles. Rarely follows up.
- Bugs: tries the AI suggestion, then tries another AI suggestion, then asks a teammate. Doesn't read stack traces top-down.
- Testing: writes a test if a teammate tells them to. Tests assert that the function exists rather than what it does.
- Commits: "fix" "wip" "fix again" "actual fix". Squashes when reminded.

**Expected scores (0–1000):**

| Pillar | Score | Reasoning |
|--------|-------|-----------|
| Comprehension | 215 | Reads top-to-bottom, can't yet skim for structure or trace data flow |
| Execution | 290 | Can scaffold a CRUD form with AI help; gets stuck on anything novel |
| Diagnostics | 180 | Symptoms-only debugger; doesn't form hypotheses, just guesses |
| Verification | 165 | Tests as a chore; assertions are shallow; no edge cases |
| Stewardship | 200 | Commits noisy; doesn't refactor; afraid to delete code |
| AI Partnership | 380 | Heavy AI user but uncritical — pastes blindly, accepts first answer |

**Expected overall headline:** 235/1000 (range: 215–270)

**Expected rank:** Learner

**Calibration anchor:** This is the textbook Learner. Lower than a Junior because they don't yet have the survival skills for messy code or production bugs. Their AI Partnership score is the highest pillar precisely because they LEAN on AI heavily — but it's not "good" AI use, just frequent use, so it sits below the Junior tier. Compare to Persona 2 who has 18 months and has internalized basic patterns.

---

## Persona 2: The Earnest Junior, Year Two

**Identity:** 1.8 years, web full-stack, Junior at a mid-size product company

**Background:** Self-taught from CS50 + side projects, hired as a Junior. Reads tech blogs religiously, pairs with seniors when she can. Cares about doing things "the right way" even when she doesn't yet know what that means. Uses AI but checks its work.

**Behavioral signature:**
- Opens unfamiliar file: jumps to exports first, then traces a few callers via grep. Reads tests if they exist.
- Prompts AI: writes a paragraph of context, asks for an approach not just code. Reads the answer carefully and asks a follow-up if something looks off.
- Bugs: reads the stack trace, isolates a minimal repro, tries a fix, runs the test. Asks for help after 30 minutes if she's still stuck.
- Testing: writes happy-path tests reliably, sometimes catches edge cases, misses concurrency / async timing bugs.
- Commits: conventional commit style, decent messages, occasional "address review" cleanups.

**Expected scores (0–1000):**

| Pillar | Score | Reasoning |
|--------|-------|-----------|
| Comprehension | 480 | Can navigate a medium codebase, still gets lost in inheritance hierarchies |
| Execution | 510 | Solid on framework idioms; slows down on novel APIs |
| Diagnostics | 425 | Can isolate simple bugs; struggles with race conditions and integration boundaries |
| Verification | 495 | Writes tests, covers happy path, often misses edge cases |
| Stewardship | 460 | Decent naming, clean commits, hesitant to refactor others' code |
| AI Partnership | 615 | Thoughtful prompting, validates output, doesn't over-rely |

**Expected overall headline:** 485/1000 (range: 460–510)

**Expected rank:** Junior

**Calibration anchor:** Solid working junior approaching mid territory. Notice AI Partnership outscores most pillars — that's the modern junior advantage: they grew up with these tools and use them deliberately. Below the seniors because Comprehension and Diagnostics are still thin under stress.

---

## Persona 3: The Vibecoder

**Identity:** 1.5 years, web (frontend), Junior at a fast-moving startup

**Background:** Picked up React from YouTube, hired in the AI-tooling boom. Ships fast. Their PRs are 80% Claude/Cursor output, lightly edited. The team likes the velocity. Nobody's sure what's actually in those PRs.

**Behavioral signature:**
- Opens unfamiliar file: pastes the whole file into AI and asks "what does this do" — then trusts the summary.
- Prompts AI: terse, action-oriented, "make this work." Accepts first output. Iterates by re-prompting, not by reading.
- Bugs: pastes the error, accepts the suggestion, hopes. If three rounds of prompting don't fix it, calls a teammate.
- Testing: AI writes the tests too. They pass. They also assert almost nothing meaningful — checking truthy values where business logic should be checked.
- Commits: large, mixed-concern, generated commit messages from AI. Reverts are common when reviewers catch things.

**Expected scores (0–1000):**

| Pillar | Score | Reasoning |
|--------|-------|-----------|
| Comprehension | 195 | Genuinely doesn't read code — outsources understanding to AI summaries |
| Execution | 530 | Ships features fast in volume; outputs look fine on the surface |
| Diagnostics | 215 | Can't debug what they didn't write; falls apart when AI loops fail |
| Verification | 240 | Tests exist and pass but don't verify behavior |
| Stewardship | 225 | Codebase quality degrades around them; subtle dead code accumulates |
| AI Partnership | 320 | Heavy use but uncritical — this is the LOW end of AI Partnership, not the high |

**Expected overall headline:** 285/1000 (range: 260–315)

**Expected rank:** Junior (low end — borderline Learner on understanding pillars)

**Calibration anchor:** Critically, Comprehension here is LOWER than the Bootcamp Grad's because the bootcamp grad at least tries to read the code. The vibecoder has actively decoupled themselves from understanding. AI Partnership is also low — same band as someone who refuses AI — because uncritical use isn't partnership. Their Execution is artificially high because raw output volume is high. This persona forces the system to recognize that "ships fast with AI" doesn't equal "good developer."

---

## Persona 4: The Pragmatic Mid

**Identity:** 4 years, web full-stack, Mid-Level at a B2B SaaS company

**Background:** CS degree, two jobs, currently at a 200-person company on a backend team. Knows their stack (TypeScript/Postgres/AWS) cold, knows where their gaps are. Honest about not knowing things. Uses AI but reads its output.

**Behavioral signature:**
- Opens unfamiliar file: reads the imports, the exports, and one or two callsites. Forms a mental model in 90 seconds.
- Prompts AI: "I'm trying to do X, my constraints are Y, here's the relevant context. Suggest 2–3 approaches." Compares them.
- Bugs: writes a failing test that reproduces the bug before fixing it. Reads the actual stack trace lines, not just the top.
- Testing: integration tests over unit when it makes sense, covers the obvious edge cases, knows what flaky tests look like.
- Commits: clean, atomic, conventional. Decent PR descriptions.

**Expected scores (0–1000):**

| Pillar | Score | Reasoning |
|--------|-------|-----------|
| Comprehension | 685 | Strong code-reading habits; gets quickly oriented in unfamiliar code |
| Execution | 660 | Productive, but not as fast as someone with rote framework muscle memory |
| Diagnostics | 695 | Hypothesis-driven; bisects effectively; knows tools |
| Verification | 670 | Reliable tester, includes edge cases, knows what flakiness looks like |
| Stewardship | 640 | Cares about the codebase; refactors opportunistically; clean commits |
| AI Partnership | 720 | Modern AI workflow, validates output, knows when to use it |

**Expected overall headline:** 678/1000 (range: 650–700)

**Expected rank:** Mid

**Calibration anchor:** This is what a healthy 4-year mid-level looks like. Above the juniors by ~180–200 points across the board because they've internalized the skills the juniors are still building. Below the seniors because they don't yet own architecture or mentor at scale. Pillars are tightly clustered — this is intentional; pragmatic mids tend to be balanced rather than spiky.

---

## Persona 5: The ML Researcher Turned Engineer

**Identity:** 5 years (3 research, 2 prod), ML, Mid-Level on an ML platform team

**Background:** PhD in CS, three years at a research lab publishing papers, two years at a product company actually shipping models. Reads papers like other people read tech blogs. Knows PyTorch internals. Less comfortable with web frameworks; touches them only when forced. Skeptical of AI tooling because "it doesn't know my domain."

**Behavioral signature:**
- Opens unfamiliar file: traces tensor shapes through the forward pass; ignores anything that doesn't move data.
- Prompts AI: rare — "it hallucinates loss functions." Uses it for boilerplate or shell scripts.
- Bugs: builds a 4-row toy dataset and runs the failing case in a notebook until they understand it.
- Testing: writes property-based tests for numerical code; weak on integration tests for the surrounding service.
- Commits: thoughtful messages; sometimes batches a week of changes into one commit because "it's all one experiment."

**Expected scores (0–1000):**

| Pillar | Score | Reasoning |
|--------|-------|-----------|
| Comprehension | 745 | Excellent at reading dense numerical code; weaker on web/services |
| Execution | 590 | Slow on framework boilerplate; fast on model code |
| Diagnostics | 780 | Top-tier in their domain — disciplined, hypothesis-driven, instruments well |
| Verification | 705 | Strong on numerical correctness; less rigorous on integration testing |
| Stewardship | 555 | Commit hygiene weak; codebase is "research-quality" until forced otherwise |
| AI Partnership | 410 | Uses it sparingly and skeptically; competent enough but not leveraging it |

**Expected overall headline:** 645/1000 (range: 615–675)

**Expected rank:** Mid (with senior-level Diagnostics in their domain)

**Calibration anchor:** Domain depth without breadth. Headline lands in mid territory because the field-aware system should weight Diagnostics and Comprehension heavily for ML — but the soft pillars (Stewardship, AI Partnership) drag the headline down. The interesting tension: their Diagnostics is genuinely senior-grade (780), but Stewardship of 555 and AI Partnership of 410 keep them from clearing the senior threshold overall.

---

## Persona 6: The Mobile Mid Who Ships

**Identity:** 6 years, mobile (iOS-primary), Mid-Level lead on a consumer app

**Background:** Self-taught Objective-C → Swift, shipped two consumer apps end-to-end. Understands UIKit, SwiftUI, Combine, async/await. Less strong on backend. Uses AI for boilerplate (CoreData stacks, view scaffolds) and treats it like a junior pair.

**Behavioral signature:**
- Opens unfamiliar file: scans the protocol conformances and view hierarchy first. Knows iOS idioms cold.
- Prompts AI: "give me the boilerplate for X, I'll wire it up." Validates by running.
- Bugs: reaches for Instruments / time profiler quickly; comfortable with the platform's debugging story.
- Testing: snapshot tests for UI, unit tests for view models. Skips network mocks ("integration tests in TestFlight").
- Commits: clean, atomic, well-described. PRs include screenshots/videos.

**Expected scores (0–1000):**

| Pillar | Score | Reasoning |
|--------|-------|-----------|
| Comprehension | 715 | Domain-deep; navigates iOS code fluidly; less so for non-iOS |
| Execution | 745 | Fast and confident in their stack; ships features per sprint reliably |
| Diagnostics | 690 | Strong with platform tools; less practiced on distributed/backend bugs |
| Verification | 605 | Good at UI testing; thinner on integration coverage |
| Stewardship | 700 | Cares about app quality; refactors view code; commit hygiene good |
| AI Partnership | 640 | Uses AI well for scaffolding; knows when not to trust it |

**Expected overall headline:** 695/1000 (range: 675–720)

**Expected rank:** Mid (top of band, approaching Senior)

**Calibration anchor:** Solid senior-track mid. Slightly above the Pragmatic Mid (Persona 4) on Execution because mobile devs who own apps end-to-end develop strong shipping rhythm. Below seniors because they don't yet drive architecture across teams or mentor structurally. Verification at 605 is the gap that keeps them out of senior territory.

---

## Persona 7: The Senior Backend Architect

**Identity:** 11 years, web (backend, distributed systems), Senior at a 500-person fintech

**Background:** CS degree, three companies, two of them with real on-call burden. Owns the payments service. Reads RFCs for fun. Understands consistency models. Mentors three engineers. Uses AI for grunt work but writes the architecture docs themselves.

**Behavioral signature:**
- Opens unfamiliar file: reads the module boundary first, then the data model, then the tests. Knows what to ignore.
- Prompts AI: structured ("here's the constraint, here's what I've tried, propose 3 alternatives with tradeoffs"). Treats output as a starting point.
- Bugs: distinguishes latent bugs from regressions; knows which logs to look at; comfortable in production. Writes runbooks.
- Testing: contract tests, property tests where it matters, knows when 70% coverage is enough and when 95% isn't.
- Commits: small, atomic, well-described, conventional. PR descriptions explain the WHY.

**Expected scores (0–1000):**

| Pillar | Score | Reasoning |
|--------|-------|-----------|
| Comprehension | 845 | Reads a 50k-line service and explains it back in an hour |
| Execution | 760 | Fast but not the fastest — quality > velocity in their work |
| Diagnostics | 870 | Production-incident-trained; bisects across services confidently |
| Verification | 825 | Knows what's worth testing; designs systems to be testable |
| Stewardship | 855 | Codebase quality compounds around them; mentors others on it |
| AI Partnership | 745 | Modern, structured, validates carefully; doesn't over-rely |

**Expected overall headline:** 815/1000 (range: 795–835)

**Expected rank:** Senior

**Calibration anchor:** This is what a typical strong senior looks like — high across the board, with Diagnostics and Stewardship slightly leading because that's where seniors actually distinguish themselves. Below the staff-level wildcard (Persona 10) because they're a specialist, not a polymath. Above the ML researcher (Persona 5) because their breadth is wider and their Stewardship + AI Partnership are stronger.

---

## Persona 8: The Senior Security Engineer Who Won't Touch AI

**Identity:** 12 years, security/appsec, Senior at a security-conscious B2B company

**Background:** Started as a sysadmin, moved into appsec, now runs threat modeling for the org. Has watched AI assistants confidently suggest vulnerable code; has refused to use them since. Reviews everyone else's AI-generated PRs with a magnifying glass.

**Behavioral signature:**
- Opens unfamiliar file: reads with adversarial eyes — what could go wrong here, where's the trust boundary, what's the input validation story.
- Prompts AI: doesn't. Will occasionally ask a colleague to ask AI on their behalf if they're stuck on syntax.
- Bugs: forms hypotheses, writes proof-of-exploit when relevant, methodical. Logs everything.
- Testing: heavy on negative testing, fuzzing, property tests. Reviews other people's tests for missing adversarial cases.
- Commits: meticulous, well-described, often include threat-model notes.

**Expected scores (0–1000):**

| Pillar | Score | Reasoning |
|--------|-------|-----------|
| Comprehension | 810 | Strong adversarial reading; not as fluent in non-security code |
| Execution | 660 | Slower than equivalent seniors — deliberately so, because they're checking |
| Diagnostics | 855 | Excellent at root-causing security incidents and subtle bugs |
| Verification | 880 | Their core competency — testing rigor is exceptional |
| Stewardship | 795 | Cares deeply about codebase health; commit hygiene strong |
| AI Partnership | 285 | Refuses to use it — same band as a vibecoder, for opposite reasons |

**Expected overall headline:** 730/1000 (range: 700–760)

**Expected rank:** Senior (top of band, dragged below typical senior by AI Partnership)

**Calibration anchor:** This is the "interesting" persona — a clearly senior engineer with one weak pillar that pulls the headline noticeably. Their core skills are senior-grade (Verification 880 and Diagnostics 855 are top-end), but AI Partnership at 285 keeps them out of the high senior bracket. The system has to decide whether refusing AI is itself a stewardship failure in 2026. I score it as such — a senior who refuses to engage with the dominant tooling shift is leaving leverage on the table, and that's a real cost. They're still senior; they're just not at the top of the band. This is where the field-aware weighting matters: in security, Verification is heavily weighted, which should lift them — but AI Partnership still drags.

---

## Persona 9: The Senior DevOps with Thin Tests

**Identity:** 9 years, devops/SRE, Senior at a mid-size infra team

**Background:** Came up from sysadmin → linux engineer → SRE. Lives in Terraform, Kubernetes, observability stacks. Knows production cold. Tests Terraform with `terraform plan` and prayer. Excellent in incidents, less rigorous in development hygiene.

**Behavioral signature:**
- Opens unfamiliar file: looks for the failure modes first. Where does this break in prod.
- Prompts AI: confident user — uses Claude Code routinely for shell scripts, terraform refactors, log analysis. Validates by running.
- Bugs: reads metrics first, code second. Excellent at correlating across services. Comfortable in chaos.
- Testing: thin. "Testing infra is testing in production." Writes integration tests grudgingly.
- Commits: decent, sometimes terse ("rollout v2 of the ingress config" with no detail). Better at runbooks than commit messages.

**Expected scores (0–1000):**

| Pillar | Score | Reasoning |
|--------|-------|-----------|
| Comprehension | 770 | Reads infrastructure code fluidly; weaker on application code |
| Execution | 765 | Fast at infra work; productive with AI for scripting |
| Diagnostics | 870 | Production-trained; reads metrics + logs + traces in concert |
| Verification | 565 | Genuinely thin — relies on production observability over pre-deploy testing |
| Stewardship | 685 | Cares about systems, less about code-level hygiene |
| AI Partnership | 755 | Strong, modern, structured AI use for infra work |

**Expected overall headline:** 735/1000 (range: 715–760)

**Expected rank:** Senior (low end — Verification is the drag)

**Calibration anchor:** A real archetype — senior DevOps with senior-level Diagnostics (870) but mid-level Verification (565). This shouldn't disqualify them from senior; it should give them a senior headline with a visibly thin pillar. They're in the same headline neighborhood as the security engineer (Persona 8) but with the opposite shape: strong AI use, weak verification. Below the backend architect (Persona 7) because Verification + Stewardship are weaker.

---

## Persona 10: The Polyglot Staff Engineer

**Identity:** 14 years, generalist (started embedded, moved through web, ML, distributed systems), Staff at a 1000-person company

**Background:** Did embedded firmware out of school, moved into web in their late 20s, picked up ML during the deep-learning boom, now leads cross-team architecture. Reads the codebase in three languages on a typical day. Their "field" is "wherever the hard problems are."

**Behavioral signature:**
- Opens unfamiliar file: reads it like a native speaker regardless of language. 5 minutes to a working mental model.
- Prompts AI: surgical — "here's the tradeoff I'm weighing, what am I missing." Uses it as a peer reviewer.
- Bugs: rare for them to be stuck. When they are, they pull in the right specialist immediately.
- Testing: writes the tests they need; coaches others to write better ones; reviews test design across the org.
- Commits: pristine. PR descriptions sometimes become design docs.

**Expected scores (0–1000):**

| Pillar | Score | Reasoning |
|--------|-------|-----------|
| Comprehension | 920 | Reads anything fluently; uncommon strength |
| Execution | 825 | Fast but deliberately slower than mids — quality bar is higher |
| Diagnostics | 915 | Cross-stack debugging is their specialty |
| Verification | 870 | Designs systems to be testable; tests where it matters |
| Stewardship | 905 | Codebase quality is their personal mission; hygiene exemplary |
| AI Partnership | 850 | Uses AI as a thoughtful peer; high signal-to-noise prompting |

**Expected overall headline:** 885/1000 (range: 870–905)

**Expected rank:** Senior (top of band; arguably staff/principal — above the 900 threshold I reserved for outliers)

**Calibration anchor:** This is the wildcard — a polyglot staff engineer. Their "field" is genuinely ambiguous (the system has to make a call: is this person's primary field web? ML? embedded? generalist?). The headline at 885 is intentionally just-shy of 900 — they're a real-world staff engineer, not a fictional perfect one. Tests the system's ability to handle: (a) very high but not unrealistic scores; (b) ambiguous field; (c) a profile where every pillar is strong but Comprehension and Diagnostics are exceptional.

---

## Calibration table

| Persona | Rank | Headline | Comp | Exec | Diag | Verif | Stew | AI |
|---|---|---|---|---|---|---|---|---|
| 1. Bootcamp Grad Month 2 | Learner | 235 | 215 | 290 | 180 | 165 | 200 | 380 |
| 2. Earnest Junior Year 2 | Junior | 485 | 480 | 510 | 425 | 495 | 460 | 615 |
| 3. The Vibecoder | Junior | 285 | 195 | 530 | 215 | 240 | 225 | 320 |
| 4. Pragmatic Mid | Mid | 678 | 685 | 660 | 695 | 670 | 640 | 720 |
| 5. ML Researcher | Mid | 645 | 745 | 590 | 780 | 705 | 555 | 410 |
| 6. Mobile Mid | Mid | 695 | 715 | 745 | 690 | 605 | 700 | 640 |
| 7. Senior Backend Architect | Senior | 815 | 845 | 760 | 870 | 825 | 855 | 745 |
| 8. Senior Security (no AI) | Senior | 730 | 810 | 660 | 855 | 880 | 795 | 285 |
| 9. Senior DevOps (thin tests) | Senior | 735 | 770 | 765 | 870 | 565 | 685 | 755 |
| 10. Polyglot Staff | Senior | 885 | 920 | 825 | 915 | 870 | 905 | 850 |
