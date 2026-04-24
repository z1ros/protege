/**
 * Local teaching knowledge base — instant, no API call.
 *
 * Covers ~40 of the most commonly asked-about JS/TS/React concepts.
 * Each entry is a structured teaching card with explanation, examples,
 * common mistakes, and related concepts. The peek teaching view tries
 * this first; only falls back to Claude for topics not covered here.
 */

export interface TeachCard {
  title: string;
  concept: string; // canonical name for matching
  explanation: string;
  examples: { label: string; code: string; lang: string }[];
  mistakes: string[];
  related: string[];
  tip?: string;
}

const DB: TeachCard[] = [
  // ---- React Hooks ----
  {
    title: "useState",
    concept: "useState",
    explanation:
      "Creates a state variable in a function component. Returns [value, setter]. Calling the setter re-renders the component with the new value. State is preserved between renders.",
    examples: [
      {
        label: "Basic counter",
        code: `const [count, setCount] = useState(0);\n\nreturn (\n  <button onClick={() => setCount(count + 1)}>\n    Clicked {count} times\n  </button>\n);`,
        lang: "tsx",
      },
      {
        label: "With initial function (lazy init)",
        code: `// Expensive computation only runs on first render\nconst [data, setData] = useState(() => {\n  return parseExpensiveData(props.raw);\n});`,
        lang: "tsx",
      },
    ],
    mistakes: [
      "Don't mutate state directly: setItems([...items, newItem]) not items.push(newItem)",
      "Setter is async — you won't see the new value on the next line",
      "Use functional updates when new state depends on old: setCount(c => c + 1)",
    ],
    related: ["useEffect", "useReducer", "useRef"],
    tip: "If your state logic gets complex (multiple related values, complex updates), consider useReducer instead.",
  },
  {
    title: "useEffect",
    concept: "useEffect",
    explanation:
      "Runs side effects after render. Takes a callback + optional dependency array. The callback runs after the component renders. The dependency array controls WHEN it re-runs. Return a cleanup function to avoid memory leaks.",
    examples: [
      {
        label: "Fetch data on mount",
        code: `useEffect(() => {\n  fetch('/api/data')\n    .then(res => res.json())\n    .then(setData);\n}, []); // empty array = only on mount`,
        lang: "tsx",
      },
      {
        label: "With cleanup",
        code: `useEffect(() => {\n  const id = setInterval(() => tick(), 1000);\n  return () => clearInterval(id); // cleanup\n}, []);`,
        lang: "tsx",
      },
      {
        label: "Re-run when dependency changes",
        code: `useEffect(() => {\n  document.title = \`\${count} clicks\`;\n}, [count]); // re-runs when count changes`,
        lang: "tsx",
      },
    ],
    mistakes: [
      "Missing dependency array = runs on EVERY render (usually a bug)",
      "Stale closure: if your effect reads state, include it in deps",
      "Don't use async directly: useEffect(() => { async function go() { ... } go(); }, [])",
    ],
    related: ["useState", "useCallback", "useMemo", "useRef"],
  },
  {
    title: "useRef",
    concept: "useRef",
    explanation:
      "Creates a mutable ref object that persists across renders WITHOUT triggering re-renders. Two main uses: (1) holding a reference to a DOM element, (2) storing a mutable value that doesn't need to trigger UI updates.",
    examples: [
      {
        label: "DOM reference",
        code: `const inputRef = useRef<HTMLInputElement>(null);\n\nreturn (\n  <>\n    <input ref={inputRef} />\n    <button onClick={() => inputRef.current?.focus()}>\n      Focus input\n    </button>\n  </>\n);`,
        lang: "tsx",
      },
      {
        label: "Mutable value (no re-render)",
        code: `const renderCount = useRef(0);\nrenderCount.current += 1;\n// doesn't trigger re-render unlike useState`,
        lang: "tsx",
      },
    ],
    mistakes: [
      "Don't read/write ref.current during render — it's a side effect",
      "ref.current is null on first render if attached to JSX (use useEffect to access)",
    ],
    related: ["useState", "useEffect", "forwardRef"],
  },
  {
    title: "useMemo",
    concept: "useMemo",
    explanation:
      "Memoizes an expensive computation so it only re-runs when dependencies change. Returns the cached VALUE (not a function). Use it when you have a costly calculation that doesn't need to re-run on every render.",
    examples: [
      {
        label: "Expensive filter",
        code: `const filtered = useMemo(\n  () => items.filter(item => item.name.includes(search)),\n  [items, search]\n);`,
        lang: "tsx",
      },
    ],
    mistakes: [
      "Don't use for trivial computations — the memoization overhead isn't worth it",
      "useMemo is for VALUES, useCallback is for FUNCTIONS",
      "If deps change every render, useMemo does nothing",
    ],
    related: ["useCallback", "React.memo", "useEffect"],
  },
  {
    title: "useCallback",
    concept: "useCallback",
    explanation:
      "Memoizes a function reference so it only changes when dependencies change. Prevents child components from re-rendering unnecessarily when passed a callback prop.",
    examples: [
      {
        label: "Stable callback for child",
        code: `const handleClick = useCallback(() => {\n  setCount(c => c + 1);\n}, []); // stable reference\n\nreturn <ExpensiveChild onClick={handleClick} />;`,
        lang: "tsx",
      },
    ],
    mistakes: [
      "Only useful if the child uses React.memo or PureComponent",
      "useCallback(fn, deps) is the same as useMemo(() => fn, deps)",
    ],
    related: ["useMemo", "React.memo"],
  },

  // ---- Async/Promises ----
  {
    title: "async/await",
    concept: "async/await",
    explanation:
      "Syntactic sugar over Promises. An async function always returns a Promise. 'await' pauses execution until the Promise resolves. Makes asynchronous code read like synchronous code.",
    examples: [
      {
        label: "Fetch with error handling",
        code: `async function fetchUser(id) {\n  try {\n    const res = await fetch(\`/api/users/\${id}\`);\n    if (!res.ok) throw new Error(\`HTTP \${res.status}\`);\n    return await res.json();\n  } catch (err) {\n    console.error('Failed:', err);\n    return null;\n  }\n}`,
        lang: "typescript",
      },
      {
        label: "Parallel execution",
        code: `// Sequential (slow):\nconst a = await fetchA();\nconst b = await fetchB();\n\n// Parallel (fast):\nconst [a, b] = await Promise.all([\n  fetchA(),\n  fetchB(),\n]);`,
        lang: "typescript",
      },
    ],
    mistakes: [
      "Forgetting to await: const data = fetch(...) gives you a Promise, not data",
      "await in a loop is sequential — use Promise.all for parallel",
      "Can't use await at the top level unless the file is a module",
    ],
    related: ["Promise", "Promise.all", "try/catch"],
  },

  // ---- HTML elements ----
  {
    title: "<strong>",
    concept: "strong",
    explanation:
      "The <strong> element marks text as having strong importance — it's semantic HTML, not just visual. Screen readers emphasize it. Use <strong> for text that MATTERS (warnings, key points). Use <b> only for stylistically bold text with no extra meaning.",
    examples: [
      {
        label: "Correct usage",
        code: `<p>Warning: <strong>Do not touch the wire</strong></p>\n<p>The meeting is at <strong>3pm tomorrow</strong></p>`,
        lang: "html",
      },
      {
        label: "Wrong: using <b> for important text",
        code: `<!-- Avoid this -->\n<p>Warning: <b>Do not touch the wire</b></p>\n<!-- Screen readers won't emphasize this -->`,
        lang: "html",
      },
    ],
    mistakes: [
      "<b> is purely visual, <strong> carries semantic meaning",
      "Don't nest <strong> for 'extra strong' — use CSS font-weight instead",
      "Most of the time you want <strong>, not <b>",
    ],
    related: ["em", "b", "mark", "cite"],
    tip: "Quick rule: if the text would lose meaning without the emphasis, use <strong>. If it's just styling, use <b> or CSS.",
  },
  {
    title: "<em>",
    concept: "em",
    explanation:
      "The <em> element marks text with stress emphasis — a change in meaning depending on which word is stressed. Like italicizing a word in speech. <i> is the non-semantic (visual-only) equivalent.",
    examples: [
      {
        label: "Stress emphasis changes meaning",
        code: `<p>I <em>really</em> like this</p>  <!-- stress on really -->\n<p><em>I</em> really like this</p>  <!-- stress on I (not someone else) -->`,
        lang: "html",
      },
    ],
    mistakes: [
      "<i> is for stylistic italics (book titles, foreign words), <em> is for emphasis",
    ],
    related: ["strong", "i", "mark"],
  },

  // ---- TypeScript ----
  {
    title: "interface",
    concept: "interface",
    explanation:
      "Defines a contract for the shape of an object. Interfaces are purely compile-time — they disappear after TypeScript compiles to JavaScript. Use them to describe what properties an object must have.",
    examples: [
      {
        label: "Basic interface",
        code: `interface User {\n  id: number;\n  name: string;\n  email?: string; // optional\n}\n\nfunction greet(user: User) {\n  return \`Hello, \${user.name}\`;\n}`,
        lang: "typescript",
      },
      {
        label: "Extending interfaces",
        code: `interface Animal {\n  name: string;\n}\n\ninterface Dog extends Animal {\n  breed: string;\n}`,
        lang: "typescript",
      },
    ],
    mistakes: [
      "Interfaces can be extended/merged, types use & for intersection",
      "For simple unions or primitives, use 'type' instead",
    ],
    related: ["type", "extends", "implements"],
  },
  {
    title: "type",
    concept: "type",
    explanation:
      "Type aliases create a name for any type — unions, intersections, primitives, tuples, etc. More flexible than interfaces but can't be extended/merged.",
    examples: [
      {
        label: "Union type",
        code: `type Status = 'loading' | 'success' | 'error';\ntype ID = string | number;`,
        lang: "typescript",
      },
      {
        label: "Intersection type",
        code: `type WithTimestamp<T> = T & { createdAt: Date };\ntype TimestampedUser = WithTimestamp<User>;`,
        lang: "typescript",
      },
    ],
    mistakes: [
      "Types can't be re-opened (declaration merging), interfaces can",
      "For object shapes, interface is usually preferred by convention",
    ],
    related: ["interface", "generic", "union"],
  },

  // ---- CSS ----
  {
    title: "flexbox",
    concept: "flex",
    explanation:
      "A one-dimensional layout system for arranging items in a row or column. The parent is the 'flex container' (display: flex), children are 'flex items'. Control alignment with justify-content (main axis) and align-items (cross axis).",
    examples: [
      {
        label: "Center everything",
        code: `.container {\n  display: flex;\n  justify-content: center; /* horizontal */\n  align-items: center;     /* vertical */\n  height: 100vh;\n}`,
        lang: "css",
      },
      {
        label: "Space between items",
        code: `.nav {\n  display: flex;\n  justify-content: space-between;\n  align-items: center;\n  gap: 16px;\n}`,
        lang: "css",
      },
    ],
    mistakes: [
      "justify-content is the MAIN axis (row=horizontal, column=vertical)",
      "align-items is the CROSS axis",
      "Use 'gap' instead of margins between flex items",
    ],
    related: ["grid", "gap", "align-items", "justify-content"],
  },
  {
    title: "CSS Grid",
    concept: "grid",
    explanation:
      "A two-dimensional layout system for rows AND columns simultaneously. More powerful than flexbox for page layouts. Define columns with grid-template-columns, place items with grid-column/grid-row.",
    examples: [
      {
        label: "Basic 3-column grid",
        code: `.grid {\n  display: grid;\n  grid-template-columns: 1fr 1fr 1fr;\n  gap: 16px;\n}`,
        lang: "css",
      },
      {
        label: "Responsive grid",
        code: `.grid {\n  display: grid;\n  grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));\n  gap: 16px;\n}`,
        lang: "css",
      },
    ],
    mistakes: [
      "Use fr units (fractions) instead of percentages for flexible columns",
      "auto-fit vs auto-fill: auto-fit collapses empty tracks, auto-fill doesn't",
    ],
    related: ["flex", "gap", "grid-template-columns"],
  },
];

// Build a lookup map for instant matching
const byName = new Map<string, TeachCard>();
for (const card of DB) {
  byName.set(card.concept.toLowerCase(), card);
  byName.set(card.title.toLowerCase(), card);
}

/**
 * Look up a teach card by concept name. Case-insensitive, tries
 * exact match then substring match.
 */
export function findTeachCard(query: string): TeachCard | null {
  const q = query.toLowerCase().trim();

  // Exact match
  const exact = byName.get(q);
  if (exact) return exact;

  // Strip angle brackets for HTML tags
  const stripped = q.replace(/^<\/?|\/?>$/g, "");
  const tagMatch = byName.get(stripped);
  if (tagMatch) return tagMatch;

  // Partial match (concept name contains the query)
  for (const card of DB) {
    if (
      card.concept.toLowerCase().includes(q) ||
      card.title.toLowerCase().includes(q)
    ) {
      return card;
    }
  }

  return null;
}

export function getAllTeachCards(): TeachCard[] {
  return DB;
}
