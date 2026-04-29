/**
 * Hand-tuned lesson plans for the most common concepts. Used as the
 * fallback when the LLM-based `planLesson` call fails or returns
 * garbage JSON. Beats the generic "Define X / Show X / Try X" template
 * we had before — concept-specific atomic steps with concrete code
 * snippets baked in.
 *
 * Lookup is normalized (lowercase + spaces removed). Add new entries
 * by appending to CURATED_PLANS. Each plan should follow the
 * micro-step rules from `teaching-microsteps.md`:
 *  - lead with EXPLAIN-ATOM (mental model first)
 *  - mix EXPLAIN-ATOM → SHOW-CODE → DO-IT-NOW
 *  - end with TASK-SOLO → REVIEW → CLOSE
 *  - ONE atomic action per step
 */

import type { PlannedStep } from "./lessons.js";

const useEffectPlan: PlannedStep[] = [
  {
    type: "EXPLAIN-ATOM",
    summary:
      "useEffect runs code AFTER React renders — for side effects like fetching, timers, listeners, or syncing state.",
  },
  {
    type: "EXPLAIN-ATOM",
    summary:
      "The dependency array controls WHEN it re-runs: empty [] means once after first render, [x] means whenever x changes.",
  },
  {
    type: "DO-IT-NOW",
    summary: "Add useEffect to your React import line",
    code: `import { useState, useEffect } from 'react'`,
  },
  {
    type: "SHOW-CODE",
    summary: "Minimal useEffect that runs once on mount",
    code: `useEffect(() => {\n  console.log('mounted')\n}, [])`,
  },
  {
    type: "DO-IT-NOW",
    summary: "Add this useEffect to your component, above the return",
    code: `useEffect(() => {\n  console.log('todos changed', todos)\n}, [todos])`,
  },
  {
    type: "EXPLAIN-ATOM",
    summary:
      "If your effect returns a function, React runs it before the next effect run and on unmount — that's cleanup.",
  },
  {
    type: "SHOW-CODE",
    summary: "useEffect with cleanup for an event listener",
    code: `useEffect(() => {\n  const onKey = (e) => console.log(e.key)\n  window.addEventListener('keydown', onKey)\n  return () => window.removeEventListener('keydown', onKey)\n}, [])`,
  },
  {
    type: "TASK-SOLO",
    summary:
      "Write a useEffect that saves todos to localStorage whenever todos changes. No code given — write it yourself, then paste.",
  },
  { type: "REVIEW", summary: "Review the user's pasted useEffect code" },
  {
    type: "CLOSE",
    summary:
      "Wrap up. Offer to go deeper on cleanup edge cases or async data fetching.",
  },
];

const useStatePlan: PlannedStep[] = [
  {
    type: "EXPLAIN-ATOM",
    summary:
      "useState gives a component a memory: a value plus a function to update it. Calling the setter triggers a re-render.",
  },
  {
    type: "SHOW-CODE",
    summary: "Simplest useState — count + setCount",
    code: `const [count, setCount] = useState(0)`,
  },
  {
    type: "DO-IT-NOW",
    summary: "Add useState to your React import",
    code: `import { useState } from 'react'`,
  },
  {
    type: "EXPLAIN-ATOM",
    summary:
      "State is preserved across renders. The setter doesn't mutate the old value — it schedules a new render with the new value.",
  },
  {
    type: "SHOW-CODE",
    summary: "Button that updates state",
    code: `<button onClick={() => setCount(count + 1)}>+1</button>`,
  },
  {
    type: "DO-IT-NOW",
    summary: "Add useState in your component to track a piece of text",
    code: `const [text, setText] = useState('')`,
  },
  {
    type: "EXPLAIN-ATOM",
    summary:
      "If new state depends on old state, use the function form: setCount(c => c + 1). Avoids stale-closure bugs.",
  },
  {
    type: "TASK-SOLO",
    summary:
      "Write a counter component: useState for count, button to increment, span to display. Paste your code.",
  },
  { type: "REVIEW", summary: "Review the user's counter code" },
  {
    type: "CLOSE",
    summary:
      "Wrap up. Offer to cover useState with objects/arrays or move to useEffect.",
  },
];

const promisesPlan: PlannedStep[] = [
  {
    type: "EXPLAIN-ATOM",
    summary:
      "A Promise is a placeholder for a future value. It starts pending, then either fulfills with a value or rejects with an error.",
  },
  {
    type: "SHOW-CODE",
    summary: "Creating a Promise that resolves after 1 second",
    code: `const wait = new Promise((resolve) => {\n  setTimeout(() => resolve('hi'), 1000)\n})`,
  },
  {
    type: "EXPLAIN-ATOM",
    summary:
      ".then(handler) reads the fulfilled value. .catch(handler) reads any rejection. .finally() runs either way.",
  },
  {
    type: "SHOW-CODE",
    summary: "fetch returns a Promise — chain .then/.catch",
    code: `fetch('/api/data')\n  .then(res => res.json())\n  .then(data => console.log(data))\n  .catch(err => console.error(err))`,
  },
  {
    type: "DO-IT-NOW",
    summary: "Write a Promise that resolves to your name after 500ms",
    code: `const myName = new Promise(resolve => setTimeout(() => resolve('Yura'), 500))`,
  },
  {
    type: "EXPLAIN-ATOM",
    summary:
      "Each .then() returns a NEW promise — that's how chains work. The next .then() reads what the previous one returned.",
  },
  {
    type: "TASK-SOLO",
    summary:
      "Chain two .then() calls on a fetch — first parses JSON, second logs one specific field.",
  },
  { type: "REVIEW", summary: "Review the user's fetch + .then chain" },
  {
    type: "CLOSE",
    summary: "Wrap. Offer async/await as the cleaner syntax for the same thing.",
  },
];

const closuresPlan: PlannedStep[] = [
  {
    type: "EXPLAIN-ATOM",
    summary:
      "A closure is when an inner function remembers variables from the outer function it was defined in — even after the outer function returns.",
  },
  {
    type: "SHOW-CODE",
    summary: "Counter factory — each call returns a counter with private state",
    code: `function makeCounter() {\n  let n = 0\n  return () => ++n\n}\nconst c = makeCounter()\nc(); c(); c() // 3`,
  },
  {
    type: "EXPLAIN-ATOM",
    summary:
      "After makeCounter() returns, n is gone from the call stack but the inner function still HOLDS A REFERENCE to it. n persists.",
  },
  {
    type: "SHOW-CODE",
    summary: "Each closure has its own n — they don't share",
    code: `const a = makeCounter()\nconst b = makeCounter()\na() // 1\nb() // 1  — independent`,
  },
  {
    type: "EXPLAIN-ATOM",
    summary:
      "Critical: closures capture the VARIABLE, not its value at capture time. If the outer changes the variable later, the closure sees the new value.",
  },
  {
    type: "DO-IT-NOW",
    summary: "Run this — predict the output, then check",
    code: `function outer() {\n  let x = 5\n  const inner = () => x\n  x = 99\n  return inner\n}\nconsole.log(outer()()) // ?`,
  },
  {
    type: "TASK-SOLO",
    summary:
      "Write a function makeMultiplier(by) that returns a function multiplying its argument by `by`. Use closure.",
  },
  { type: "REVIEW", summary: "Review the user's multiplier function" },
  {
    type: "CLOSE",
    summary: "Wrap. Offer the classic for-loop var/let gotcha as next concept.",
  },
];

const asyncAwaitPlan: PlannedStep[] = [
  {
    type: "EXPLAIN-ATOM",
    summary:
      "async/await is syntax sugar for Promises — lets you write asynchronous code that READS like synchronous code.",
  },
  {
    type: "SHOW-CODE",
    summary: "async function that fetches and parses JSON",
    code: `async function getUser() {\n  const res = await fetch('/api/user')\n  const data = await res.json()\n  return data\n}`,
  },
  {
    type: "EXPLAIN-ATOM",
    summary:
      "await pauses the function until the Promise resolves, then continues with the resolved value. The function itself returns a Promise.",
  },
  {
    type: "EXPLAIN-ATOM",
    summary:
      "For errors use try/catch — NOT .catch(). The await throws if the Promise rejects.",
  },
  {
    type: "SHOW-CODE",
    summary: "try/catch around await",
    code: `async function safeGet() {\n  try {\n    const res = await fetch('/api/user')\n    return await res.json()\n  } catch (err) {\n    console.error(err)\n  }\n}`,
  },
  {
    type: "DO-IT-NOW",
    summary: "Convert this .then chain to async/await",
    code: `// .then version:\n// fetch('/api/x').then(r => r.json()).then(d => console.log(d))\n// Now write the async/await equivalent in your project`,
  },
  {
    type: "EXPLAIN-ATOM",
    summary:
      "Every async function returns a Promise — even if you don't write `return`. So callers .await it or .then() it.",
  },
  {
    type: "TASK-SOLO",
    summary:
      "Write an async function that fetches /api/todos, parses JSON, and returns the count of items. With try/catch.",
  },
  { type: "REVIEW", summary: "Review the user's async function" },
  {
    type: "CLOSE",
    summary: "Wrap. Offer Promise.all for running multiple awaits in parallel.",
  },
];

const reactKeysPlan: PlannedStep[] = [
  {
    type: "EXPLAIN-ATOM",
    summary:
      "Keys help React identify which list item is which between renders — so it can move, add, or remove just the changed ones, not re-create everything.",
  },
  {
    type: "SHOW-CODE",
    summary: "Standard list rendering with keys",
    code: `{items.map(item => <li key={item.id}>{item.name}</li>)}`,
  },
  {
    type: "EXPLAIN-ATOM",
    summary:
      "Keys must be STABLE (same item gets same key across renders) and UNIQUE among siblings. Database IDs are perfect.",
  },
  {
    type: "SHOW-CODE",
    summary: "Anti-pattern: index as key",
    code: `{items.map((item, i) => <li key={i}>{item.name}</li>)}\n// Breaks when items reorder, get added at the start, or get filtered`,
  },
  {
    type: "EXPLAIN-ATOM",
    summary:
      "If the list is static (never reorders, never adds/removes), index works fine. The bug appears when items move.",
  },
  {
    type: "DO-IT-NOW",
    summary: "Replace `key={i}` with `key={item.id}` in your todos list",
    code: `// before: <li key={i}>...\n// after:  <li key={todo.id}>...`,
  },
  {
    type: "TASK-SOLO",
    summary:
      "Render a list of objects with stable IDs from scratch (give 3 items inline). Paste your code.",
  },
  { type: "REVIEW", summary: "Review the user's list rendering" },
  {
    type: "CLOSE",
    summary: "Wrap. Offer Fragment+key or React.memo for list optimization.",
  },
];

const debouncePlan: PlannedStep[] = [
  {
    type: "EXPLAIN-ATOM",
    summary:
      "Debounce delays a function call until N milliseconds of no new calls — perfect for search inputs, resize listeners, autosave.",
  },
  {
    type: "SHOW-CODE",
    summary: "Basic debounce factory",
    code: `function debounce(fn, ms) {\n  let id\n  return (...args) => {\n    clearTimeout(id)\n    id = setTimeout(() => fn(...args), ms)\n  }\n}`,
  },
  {
    type: "EXPLAIN-ATOM",
    summary:
      "Each call clears the previous timer and starts a new one. Only the LAST call (after a quiet period) actually fires fn.",
  },
  {
    type: "SHOW-CODE",
    summary: "Debounced search handler",
    code: `const onSearch = debounce((q) => fetch('/search?q=' + q), 300)\n<input onChange={e => onSearch(e.target.value)} />`,
  },
  {
    type: "EXPLAIN-ATOM",
    summary:
      "Debounce vs throttle: debounce waits for quiet, throttle limits to N calls/sec. Different use cases.",
  },
  {
    type: "DO-IT-NOW",
    summary: "Wrap a console.log with debounce(_, 500) and call it 3 times rapidly — observe only the last fires",
    code: `const logged = debounce((msg) => console.log(msg), 500)\nlogged('a'); logged('b'); logged('c')\n// 500ms later: 'c'`,
  },
  {
    type: "TASK-SOLO",
    summary:
      "Write debounce yourself from scratch (no copying). Apply it to a fake search function. Paste your code.",
  },
  { type: "REVIEW", summary: "Review the user's debounce implementation" },
  {
    type: "CLOSE",
    summary: "Wrap. Offer throttle or React's useDeferredValue as next.",
  },
];

const useEffectCleanupPlan: PlannedStep[] = [
  {
    type: "EXPLAIN-ATOM",
    summary:
      "Cleanup is a function returned from useEffect. React runs it BEFORE the next effect run and ON unmount — preventing leaks from timers, listeners, subscriptions.",
  },
  {
    type: "SHOW-CODE",
    summary: "Effect with cleanup — interval timer",
    code: `useEffect(() => {\n  const id = setInterval(() => console.log('tick'), 1000)\n  return () => clearInterval(id)\n}, [])`,
  },
  {
    type: "EXPLAIN-ATOM",
    summary:
      "Without that return statement, the interval keeps running forever — even after the component unmounts. That's a memory leak.",
  },
  {
    type: "SHOW-CODE",
    summary: "Cleanup for an event listener",
    code: `useEffect(() => {\n  const onResize = () => console.log(window.innerWidth)\n  window.addEventListener('resize', onResize)\n  return () => window.removeEventListener('resize', onResize)\n}, [])`,
  },
  {
    type: "DO-IT-NOW",
    summary:
      "Add a useEffect with setInterval and cleanup in your component — log a tick every 2s",
    code: `useEffect(() => {\n  const id = setInterval(() => console.log('tick'), 2000)\n  return () => clearInterval(id)\n}, [])`,
  },
  {
    type: "EXPLAIN-ATOM",
    summary:
      "Cleanup captures the values from when the effect RAN, not the latest render. So clearInterval(id) clears the right timer.",
  },
  {
    type: "TASK-SOLO",
    summary:
      "Write a useEffect that adds a click listener to window and removes it on cleanup. Paste your code.",
  },
  { type: "REVIEW", summary: "Review the user's listener+cleanup code" },
  {
    type: "CLOSE",
    summary: "Wrap. Offer subscriptions (RxJS / WebSocket) as a deeper case.",
  },
];

/**
 * Lookup table — keyed by normalized concept name.
 * Normalization: lowercase, all whitespace removed.
 */
const CURATED_PLANS: Record<string, PlannedStep[]> = {
  useeffect: useEffectPlan,
  reactuseeffect: useEffectPlan,
  effects: useEffectPlan,
  usestate: useStatePlan,
  reactusestate: useStatePlan,
  reactstate: useStatePlan,
  promise: promisesPlan,
  promises: promisesPlan,
  closure: closuresPlan,
  closures: closuresPlan,
  async: asyncAwaitPlan,
  asyncawait: asyncAwaitPlan,
  await: asyncAwaitPlan,
  reactkeys: reactKeysPlan,
  keys: reactKeysPlan,
  keysinlist: reactKeysPlan,
  keysinlists: reactKeysPlan,
  listkeys: reactKeysPlan,
  debounce: debouncePlan,
  debouncing: debouncePlan,
  useeffectcleanup: useEffectCleanupPlan,
  cleanup: useEffectCleanupPlan,
  effectcleanup: useEffectCleanupPlan,
};

/**
 * Look up a curated plan by concept name. Returns null if no plan
 * matches — caller should fall back to a generic template.
 *
 * Matching: normalize (lowercase + strip whitespace) and check exact
 * keys, then partial matches (concept contains key or key contains
 * concept) for fuzzy matches like "useEffect lol" → useeffect.
 */
export function findCuratedPlan(concept: string): PlannedStep[] | null {
  const norm = concept.toLowerCase().replace(/\s+/g, "").replace(/[^a-z]/g, "");
  if (norm.length === 0) return null;

  // Exact match
  if (CURATED_PLANS[norm]) return CURATED_PLANS[norm];

  // Partial — concept contains a curated key OR key contains the
  // concept's main token. Pick the longest matching key (most specific).
  let best: { key: string; plan: PlannedStep[] } | null = null;
  for (const key of Object.keys(CURATED_PLANS)) {
    if (norm.includes(key) || key.includes(norm)) {
      if (!best || key.length > best.key.length) {
        best = { key, plan: CURATED_PLANS[key] };
      }
    }
  }
  return best?.plan ?? null;
}
