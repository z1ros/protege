# Code IQ Personas — BLIND

You are scoring 10 developer personas for a proficiency metric on a 0–1000 scale. You have NOT seen any prior scoring of these personas. Score them from your own industry intuition.

The metric has 4 ranks: **Learner / Junior / Mid / Senior**. Six pillars per developer (each 0–1000):

- **Comprehension** — reading existing code, mapping unfamiliar systems, recognizing patterns
- **Execution** — writing working code efficiently, scaffolding, getting to runnable state
- **Diagnostics** — debugging skill, hypothesis-driven, reading errors/traces
- **Verification** — testing rigor, edge cases, validating assumptions
- **Stewardship** — code quality, naming, refactoring, commit hygiene
- **AI Partnership** — using AI assistants effectively (clear prompts, validating output, knowing when to delegate). Note: refusing to use AI scores LOW here, same as pasting blindly — both fail to leverage the tool.

The system is field-aware (web/ML/sec/etc weight pillars differently). You don't need to know weights — pick scores from intuition.

## Personas

---

### Persona 1: The Bootcamp Grad in Month Two

**Identity:** 3 months experience, web (frontend-leaning), first job as a Junior at a small SaaS company

**Background:** Finished a 14-week full-stack bootcamp, hired into a React + Node shop. Earnest, anxious, learning fast. Spends evenings in tutorials. Knows what `useState` does but isn't sure why `useEffect` ran twice in dev. Reaches for ChatGPT for almost everything.

**Behavioral signature:**
- Opens unfamiliar file: scrolls top to bottom once, gets overwhelmed, asks AI to "explain this file." Doesn't yet know which questions are the right ones.
- Prompts AI: copy-pastes the whole error and the whole file. Accepts the first answer if it compiles. Rarely follows up.
- Bugs: tries the AI suggestion, then tries another AI suggestion, then asks a teammate. Doesn't read stack traces top-down.
- Testing: writes a test if a teammate tells them to. Tests assert that the function exists rather than what it does.
- Commits: "fix" "wip" "fix again" "actual fix". Squashes when reminded.

---

### Persona 2: The Earnest Junior, Year Two

**Identity:** 1.8 years, web full-stack, Junior at a mid-size product company

**Background:** Self-taught from CS50 + side projects, hired as a Junior. Reads tech blogs religiously, pairs with seniors when she can. Cares about doing things "the right way" even when she doesn't yet know what that means. Uses AI but checks its work.

**Behavioral signature:**
- Opens unfamiliar file: jumps to exports first, then traces a few callers via grep. Reads tests if they exist.
- Prompts AI: writes a paragraph of context, asks for an approach not just code. Reads the answer carefully and asks a follow-up if something looks off.
- Bugs: reads the stack trace, isolates a minimal repro, tries a fix, runs the test. Asks for help after 30 minutes if she's still stuck.
- Testing: writes happy-path tests reliably, sometimes catches edge cases, misses concurrency / async timing bugs.
- Commits: conventional commit style, decent messages, occasional "address review" cleanups.

---

### Persona 3: The Vibecoder

**Identity:** 1.5 years, web (frontend), Junior at a fast-moving startup

**Background:** Picked up React from YouTube, hired in the AI-tooling boom. Ships fast. Their PRs are 80% Claude/Cursor output, lightly edited. The team likes the velocity. Nobody's sure what's actually in those PRs.

**Behavioral signature:**
- Opens unfamiliar file: pastes the whole file into AI and asks "what does this do" — then trusts the summary.
- Prompts AI: terse, action-oriented, "make this work." Accepts first output. Iterates by re-prompting, not by reading.
- Bugs: pastes the error, accepts the suggestion, hopes. If three rounds of prompting don't fix it, calls a teammate.
- Testing: AI writes the tests too. They pass. They also assert almost nothing meaningful — checking truthy values where business logic should be checked.
- Commits: large, mixed-concern, generated commit messages from AI. Reverts are common when reviewers catch things.

---

### Persona 4: The Pragmatic Mid

**Identity:** 4 years, web full-stack, Mid-Level at a B2B SaaS company

**Background:** CS degree, two jobs, currently at a 200-person company on a backend team. Knows their stack (TypeScript/Postgres/AWS) cold, knows where their gaps are. Honest about not knowing things. Uses AI but reads its output.

**Behavioral signature:**
- Opens unfamiliar file: reads the imports, the exports, and one or two callsites. Forms a mental model in 90 seconds.
- Prompts AI: "I'm trying to do X, my constraints are Y, here's the relevant context. Suggest 2–3 approaches." Compares them.
- Bugs: writes a failing test that reproduces the bug before fixing it. Reads the actual stack trace lines, not just the top.
- Testing: integration tests over unit when it makes sense, covers the obvious edge cases, knows what flaky tests look like.
- Commits: clean, atomic, conventional. Decent PR descriptions.

---

### Persona 5: The ML Researcher Turned Engineer

**Identity:** 5 years (3 research, 2 prod), ML, Mid-Level on an ML platform team

**Background:** PhD in CS, three years at a research lab publishing papers, two years at a product company actually shipping models. Reads papers like other people read tech blogs. Knows PyTorch internals. Less comfortable with web frameworks; touches them only when forced. Skeptical of AI tooling because "it doesn't know my domain."

**Behavioral signature:**
- Opens unfamiliar file: traces tensor shapes through the forward pass; ignores anything that doesn't move data.
- Prompts AI: rare — "it hallucinates loss functions." Uses it for boilerplate or shell scripts.
- Bugs: builds a 4-row toy dataset and runs the failing case in a notebook until they understand it.
- Testing: writes property-based tests for numerical code; weak on integration tests for the surrounding service.
- Commits: thoughtful messages; sometimes batches a week of changes into one commit because "it's all one experiment."

---

### Persona 6: The Mobile Mid Who Ships

**Identity:** 6 years, mobile (iOS-primary), Mid-Level lead on a consumer app

**Background:** Self-taught Objective-C → Swift, shipped two consumer apps end-to-end. Understands UIKit, SwiftUI, Combine, async/await. Less strong on backend. Uses AI for boilerplate (CoreData stacks, view scaffolds) and treats it like a junior pair.

**Behavioral signature:**
- Opens unfamiliar file: scans the protocol conformances and view hierarchy first. Knows iOS idioms cold.
- Prompts AI: "give me the boilerplate for X, I'll wire it up." Validates by running.
- Bugs: reaches for Instruments / time profiler quickly; comfortable with the platform's debugging story.
- Testing: snapshot tests for UI, unit tests for view models. Skips network mocks ("integration tests in TestFlight").
- Commits: clean, atomic, well-described. PRs include screenshots/videos.

---

### Persona 7: The Senior Backend Architect

**Identity:** 11 years, web (backend, distributed systems), Senior at a 500-person fintech

**Background:** CS degree, three companies, two of them with real on-call burden. Owns the payments service. Reads RFCs for fun. Understands consistency models. Mentors three engineers. Uses AI for grunt work but writes the architecture docs themselves.

**Behavioral signature:**
- Opens unfamiliar file: reads the module boundary first, then the data model, then the tests. Knows what to ignore.
- Prompts AI: structured ("here's the constraint, here's what I've tried, propose 3 alternatives with tradeoffs"). Treats output as a starting point.
- Bugs: distinguishes latent bugs from regressions; knows which logs to look at; comfortable in production. Writes runbooks.
- Testing: contract tests, property tests where it matters, knows when 70% coverage is enough and when 95% isn't.
- Commits: small, atomic, well-described, conventional. PR descriptions explain the WHY.

---

### Persona 8: The Senior Security Engineer Who Won't Touch AI

**Identity:** 12 years, security/appsec, Senior at a security-conscious B2B company

**Background:** Started as a sysadmin, moved into appsec, now runs threat modeling for the org. Has watched AI assistants confidently suggest vulnerable code; has refused to use them since. Reviews everyone else's AI-generated PRs with a magnifying glass.

**Behavioral signature:**
- Opens unfamiliar file: reads with adversarial eyes — what could go wrong here, where's the trust boundary, what's the input validation story.
- Prompts AI: doesn't. Will occasionally ask a colleague to ask AI on their behalf if they're stuck on syntax.
- Bugs: forms hypotheses, writes proof-of-exploit when relevant, methodical. Logs everything.
- Testing: heavy on negative testing, fuzzing, property tests. Reviews other people's tests for missing adversarial cases.
- Commits: meticulous, well-described, often include threat-model notes.

---

### Persona 9: The Senior DevOps with Thin Tests

**Identity:** 9 years, devops/SRE, Senior at a mid-size infra team

**Background:** Came up from sysadmin → linux engineer → SRE. Lives in Terraform, Kubernetes, observability stacks. Knows production cold. Tests Terraform with `terraform plan` and prayer. Excellent in incidents, less rigorous in development hygiene.

**Behavioral signature:**
- Opens unfamiliar file: looks for the failure modes first. Where does this break in prod.
- Prompts AI: confident user — uses Claude Code routinely for shell scripts, terraform refactors, log analysis. Validates by running.
- Bugs: reads metrics first, code second. Excellent at correlating across services. Comfortable in chaos.
- Testing: thin. "Testing infra is testing in production." Writes integration tests grudgingly.
- Commits: decent, sometimes terse ("rollout v2 of the ingress config" with no detail). Better at runbooks than commit messages.

---

### Persona 10: The Polyglot Staff Engineer

**Identity:** 14 years, generalist (started embedded, moved through web, ML, distributed systems), Staff at a 1000-person company

**Background:** Did embedded firmware out of school, moved into web in their late 20s, picked up ML during the deep-learning boom, now leads cross-team architecture. Reads the codebase in three languages on a typical day. Their "field" is "wherever the hard problems are."

**Behavioral signature:**
- Opens unfamiliar file: reads it like a native speaker regardless of language. 5 minutes to a working mental model.
- Prompts AI: surgical — "here's the tradeoff I'm weighing, what am I missing." Uses it as a peer reviewer.
- Bugs: rare for them to be stuck. When they are, they pull in the right specialist immediately.
- Testing: writes the tests they need; coaches others to write better ones; reviews test design across the org.
- Commits: pristine. PR descriptions sometimes become design docs.
