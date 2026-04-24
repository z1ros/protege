/**
 * Local error explanation patterns — instant, no API call.
 *
 * Each pattern matches against the diagnostic message text and returns
 * a plain-English explanation. Covers the ~50 most common TS/JS/Python
 * errors that account for ~80% of what beginners encounter.
 *
 * Falls through to Claude (via inlineErrors.ts) for anything not matched.
 */

interface ErrorPattern {
  /** Regex tested against the diagnostic message (case-insensitive) */
  match: RegExp;
  /** Plain-English explanation. $1, $2... are replaced from regex captures. */
  explain: string | ((...captures: string[]) => string);
}

const PATTERNS: ErrorPattern[] = [
  // ---- TypeScript type errors ----
  {
    match: /type '(.+?)' is not assignable to type '(.+?)'/i,
    explain: (_, from, to) =>
      `You're passing a ${from} where a ${to} is expected. Check the types match.`,
  },
  {
    match: /property '(.+?)' does not exist on type '(.+?)'/i,
    explain: (_, prop, type) =>
      `"${prop}" doesn't exist on ${type}. Check for typos or add it to the type definition.`,
  },
  {
    match: /cannot find name '(.+?)'/i,
    explain: (_, name) =>
      `"${name}" isn't defined. Did you forget to import it or declare it?`,
  },
  {
    match: /argument of type '(.+?)' is not assignable to parameter of type '(.+?)'/i,
    explain: (_, from, to) =>
      `This function expects a ${to} but you're passing a ${from}.`,
  },
  {
    match: /object is possibly '(null|undefined)'/i,
    explain: (_, what) =>
      `This value might be ${what}. Add a null check (if/optional chaining ?.) before using it.`,
  },
  {
    match: /cannot find module '(.+?)'/i,
    explain: (_, mod) =>
      `Module "${mod}" not found. Run npm install or check the import path.`,
  },
  {
    match: /has no exported member '(.+?)'/i,
    explain: (_, name) =>
      `"${name}" isn't exported from this module. Check the export name or spelling.`,
  },
  {
    match: /expected (\d+) arguments?, but got (\d+)/i,
    explain: (_, expected, got) =>
      `This function takes ${expected} argument${expected === "1" ? "" : "s"} but you passed ${got}.`,
  },
  {
    match: /unused.*variable|is declared but.*never (used|read)/i,
    explain: "This variable is declared but never used. Remove it or use it.",
  },
  {
    match: /a function whose declared type is neither 'void' nor 'any' must return a value/i,
    explain: "This function should return a value but doesn't. Add a return statement.",
  },
  {
    match: /this expression is not callable/i,
    explain: "You're trying to call something that isn't a function.",
  },
  {
    match: /duplicate identifier '(.+?)'/i,
    explain: (_, name) =>
      `"${name}" is already declared in this scope. Rename one of them.`,
  },
  {
    match: /the left-hand side of an assignment expression must be a variable/i,
    explain: "You can't assign to this — it's not a variable. Did you mean == or === instead of =?",
  },
  {
    match: /operator '(.+?)' cannot be applied to types '(.+?)' and '(.+?)'/i,
    explain: (_, op, left, right) =>
      `Can't use "${op}" between ${left} and ${right}. Convert one of them first.`,
  },
  {
    match: /jsx element type '(.+?)' does not have any construct or call signatures/i,
    explain: (_, comp) =>
      `<${comp}> isn't a valid React component. Make sure it's a function or class that returns JSX.`,
  },
  {
    match: /cannot use import statement outside a module/i,
    explain:
      'This file isn\'t being treated as a module. Add "type": "module" to package.json or rename to .mjs.',
  },
  {
    match: /property '(.+?)' is missing in type/i,
    explain: (_, prop) =>
      `Required property "${prop}" is missing. Add it to the object.`,
  },
  {
    match: /type '(.+?)' is not assignable to type 'never'/i,
    explain:
      "TypeScript narrowed this to 'never' — meaning it thinks this code is unreachable. Check your type guards.",
  },
  {
    match: /cannot redeclare block-scoped variable '(.+?)'/i,
    explain: (_, name) =>
      `"${name}" is already declared in this block. Use a different name.`,
  },

  // ---- JavaScript runtime-style errors ----
  {
    match: /unexpected token/i,
    explain: "There's a syntax error. Check for missing brackets, commas, or semicolons.",
  },
  {
    match: /unexpected end of (input|file)/i,
    explain: "The file ends unexpectedly. You're probably missing a closing bracket } or ).",
  },
  {
    match: /';' expected/i,
    explain: "Missing semicolon or closing bracket. Check the line above too.",
  },
  {
    match: /',' expected/i,
    explain: "Missing comma. Check for missing commas in objects, arrays, or function arguments.",
  },
  {
    match: /'\)' expected|'\}' expected|'\]' expected/i,
    explain: "Missing closing bracket. Count your opening and closing brackets.",
  },
  {
    match: /unterminated string literal/i,
    explain: "A string isn't closed. Check for missing quotes.",
  },

  // ---- React-specific ----
  {
    match: /react hook .+ is called conditionally/i,
    explain: "Hooks must be called in the same order every render. Move this hook before any if/return.",
  },
  {
    match: /react hook .+ has a missing dependency: '(.+?)'/i,
    explain: (_, dep) =>
      `"${dep}" is used inside the effect but not in the dependency array. Add it or wrap in useCallback.`,
  },
  {
    match: /do not pass children as props/i,
    explain: "In JSX, children go between the tags, not as a prop.",
  },
  {
    match: /each child in a list should have a unique "key" prop/i,
    explain: 'Add a unique "key" prop to each item in the list. Use the item\'s ID, not the array index.',
  },

  // ---- CSS ----
  {
    match: /unknown property '(.+?)'/i,
    explain: (_, prop) =>
      `"${prop}" isn't a valid CSS property. Check spelling (CSS uses kebab-case).`,
  },

  // ---- Python ----
  {
    match: /indentation/i,
    explain: "Python indentation error. Make sure you're using consistent spaces (not mixing tabs and spaces).",
  },
  {
    match: /name '(.+?)' is not defined/i,
    explain: (_, name) =>
      `"${name}" isn't defined. Check spelling or import it.`,
  },
  {
    match: /invalid syntax/i,
    explain: "Python syntax error. Check for missing colons, brackets, or invalid characters.",
  },

  // ---- ESLint-style ----
  {
    match: /prefer const/i,
    explain: "This variable is never reassigned. Use const instead of let.",
  },
  {
    match: /no-unused-vars/i,
    explain: "This variable is declared but never used.",
  },
  {
    match: /unexpected console statement/i,
    explain: "console.log left in the code. Remove before committing (or disable the lint rule).",
  },
  {
    match: /prefer.*arrow/i,
    explain: "This could be written as an arrow function for consistency.",
  },
];

/**
 * Try to explain a diagnostic message using local patterns.
 * Returns null if no pattern matches (caller should fall back to Claude).
 */
export function explainLocally(message: string): string | null {
  for (const p of PATTERNS) {
    const m = p.match.exec(message);
    if (m) {
      if (typeof p.explain === "string") return p.explain;
      return p.explain(...m);
    }
    // Reset regex lastIndex for global regexes
    p.match.lastIndex = 0;
  }
  return null;
}
