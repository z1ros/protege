/**
 * Concept detection rules with difficulty weights and cluster grouping.
 *
 * weight:  0.3 trivial · 1.0 core · 2.0 advanced · 3.0 expert
 * cluster: used by the Concepts tab to group related skills
 *
 * The total weight sum across all rules defines the IQ ceiling calibration
 * (see store.ts — K is computed so max reachable IQ = 1000).
 */

export type Cluster =
  | "react"
  | "async"
  | "functional"
  | "types"
  | "language-core"
  | "error-handling"
  | "python";

export interface Rule {
  name: string;
  languages: string[];
  patterns: RegExp[];
  weight: number;
  cluster: Cluster;
}

const JS_TS = ["javascript", "typescript", "javascriptreact", "typescriptreact"];
const JS_TS_JSX = ["javascriptreact", "typescriptreact"];
const TS = ["typescript", "typescriptreact"];
const PY = ["python"];

export const RULES: Rule[] = [
  // ===== React =====
  { name: "React useState",      languages: JS_TS_JSX, weight: 1.2, cluster: "react",
    patterns: [/\buseState\s*\(/] },
  { name: "React useEffect",     languages: JS_TS_JSX, weight: 1.5, cluster: "react",
    patterns: [/\buseEffect\s*\(/] },
  // Multiline: useEffect whose body returns a cleanup function.
  { name: "React useEffect cleanup", languages: JS_TS_JSX, weight: 2.2, cluster: "react",
    patterns: [/useEffect\s*\(\s*\(\s*\)\s*=>\s*\{[\s\S]*?return\s+(\(\s*\)\s*=>|function\s*\()/] },
  { name: "React useMemo",       languages: JS_TS_JSX, weight: 2.0, cluster: "react",
    patterns: [/\buseMemo\s*\(/] },
  { name: "React useCallback",   languages: JS_TS_JSX, weight: 2.0, cluster: "react",
    patterns: [/\buseCallback\s*\(/] },
  { name: "React useRef",        languages: JS_TS_JSX, weight: 1.5, cluster: "react",
    patterns: [/\buseRef\s*\(/] },
  { name: "React useReducer",    languages: JS_TS_JSX, weight: 2.5, cluster: "react",
    patterns: [/\buseReducer\s*\(/] },
  // Custom hook = function named use[A-Z] whose body calls another hook.
  { name: "React custom hook",   languages: JS_TS_JSX, weight: 2.8, cluster: "react",
    patterns: [/function\s+use[A-Z]\w*[^{]*\{[\s\S]*?\buse[A-Z]\w*\s*\(/, /const\s+use[A-Z]\w*\s*=\s*[^=]*=>\s*\{[\s\S]*?\buse[A-Z]\w*\s*\(/] },
  { name: "React component",     languages: JS_TS_JSX, weight: 1.0, cluster: "react",
    patterns: [/export\s+(default\s+)?function\s+[A-Z]\w*/, /const\s+[A-Z]\w*\s*[:=][^=]*=>/] },

  // ===== Async =====
  { name: "async/await",         languages: JS_TS, weight: 1.5, cluster: "async",
    patterns: [/\basync\s+(function|\()/, /\basync\s*\(/, /\bawait\s+/] },
  { name: "Promises",            languages: JS_TS, weight: 1.5, cluster: "async",
    patterns: [/\bnew\s+Promise\s*\(/, /\bPromise\.(all|race|allSettled|any)\s*\(/] },
  { name: "Promise.all concurrency", languages: JS_TS, weight: 2.0, cluster: "async",
    patterns: [/\bPromise\.(all|allSettled|any|race)\s*\(/] },
  { name: "Async iteration",     languages: JS_TS, weight: 2.2, cluster: "async",
    patterns: [/\bfor\s+await\s*\(/] },
  { name: "Fetch API",           languages: JS_TS, weight: 0.8, cluster: "async",
    patterns: [/\bfetch\s*\(/] },

  // ===== Error handling =====
  { name: "Error handling",      languages: JS_TS, weight: 1.2, cluster: "error-handling",
    patterns: [/\btry\s*\{[\s\S]*?\}\s*catch\b/, /\.catch\s*\(/] },

  // ===== Functional =====
  { name: "Array map",           languages: JS_TS, weight: 0.6, cluster: "functional",
    patterns: [/\.map\s*\(\s*[\(\w]/] },
  { name: "Array filter",        languages: JS_TS, weight: 0.6, cluster: "functional",
    patterns: [/\.filter\s*\(\s*[\(\w]/] },
  { name: "Array reduce",        languages: JS_TS, weight: 1.8, cluster: "functional",
    patterns: [/\.reduce\s*\(\s*[\(\w]/] },
  // Reducer pattern = reduce whose accumulator is an object/array literal
  // (state-building reduction, not just .reduce((a,b)=>a+b)).
  { name: "Reducer pattern",     languages: JS_TS, weight: 2.5, cluster: "functional",
    patterns: [/\.reduce\s*\(\s*\([^)]*\)\s*=>\s*\(?\{[\s\S]*?\}\s*\)?\s*,\s*\{/, /\.reduce\s*\(\s*\([^)]*\)\s*=>\s*\[[\s\S]*?\]\s*,\s*\[/] },
  // Higher-order function = parameter list includes a function-typed param,
  // or a function that returns another function expression.
  { name: "Higher-order function", languages: JS_TS, weight: 2.3, cluster: "functional",
    patterns: [/\(\s*\w+\s*:\s*\([^)]*\)\s*=>\s*[^,)]+\s*[,)]/, /=>\s*\(?\s*\([^)]*\)\s*=>/] },
  { name: "Destructuring",       languages: JS_TS, weight: 0.5, cluster: "functional",
    patterns: [/const\s*\{[^}]+\}\s*=/, /const\s*\[[^\]]+\]\s*=/] },
  { name: "Spread / rest",       languages: JS_TS, weight: 0.5, cluster: "functional",
    patterns: [/\.\.\.[a-zA-Z_]/] },
  { name: "Arrow functions",     languages: JS_TS, weight: 0.3, cluster: "functional",
    patterns: [/\([^)]*\)\s*=>/, /[a-zA-Z_]+\s*=>/] },

  // ===== Language core =====
  { name: "Classes",             languages: JS_TS, weight: 1.0, cluster: "language-core",
    patterns: [/\bclass\s+\w+/] },
  { name: "Template literals",   languages: JS_TS, weight: 0.3, cluster: "language-core",
    patterns: [/`[^`]*\$\{[^}]+\}[^`]*`/] },
  { name: "Optional chaining",   languages: JS_TS, weight: 0.4, cluster: "language-core",
    patterns: [/\?\./] },
  { name: "Nullish coalescing",  languages: JS_TS, weight: 0.4, cluster: "language-core",
    patterns: [/\?\?/] },
  { name: "ES modules",          languages: JS_TS, weight: 0.4, cluster: "language-core",
    patterns: [/^import\s.+\sfrom\s/m, /^export\s+(default\s+|const\s+|function\s+|class\s+)/m] },

  // ===== TypeScript types =====
  { name: "TypeScript interface", languages: TS, weight: 1.0, cluster: "types",
    patterns: [/\binterface\s+\w+/] },
  { name: "TypeScript type alias", languages: TS, weight: 1.0, cluster: "types",
    patterns: [/\btype\s+\w+\s*=/] },
  { name: "TypeScript generics", languages: TS, weight: 2.0, cluster: "types",
    patterns: [/<[A-Z]\w*(\s*,\s*[A-Z]\w*)*>/] },
  { name: "Generic constraints", languages: TS, weight: 2.5, cluster: "types",
    patterns: [/<[A-Z]\w*\s+extends\s+\w/] },
  { name: "Conditional types",   languages: TS, weight: 3.0, cluster: "types",
    patterns: [/type\s+\w+\s*<[^>]*>\s*=\s*[^;]*\bextends\b[^;]*\?[^;]*:/] },
  // Discriminated union = union type where members share a literal "kind" / "type" field.
  { name: "Discriminated unions", languages: TS, weight: 2.8, cluster: "types",
    patterns: [/\|\s*\{\s*(kind|type|tag)\s*:\s*["'][^"']+["']/] },

  // ===== Python =====
  { name: "Python list comprehension", languages: PY, weight: 1.2, cluster: "python",
    patterns: [/\[[^\]]*\bfor\b[^\]]*\]/] },
  { name: "Python decorators",   languages: PY, weight: 2.0, cluster: "python",
    patterns: [/^@\w+/m] },
  { name: "Python with-statement", languages: PY, weight: 1.0, cluster: "python",
    patterns: [/\bwith\s+.+\s+as\s+\w+\s*:/] },
  { name: "Python try/except",   languages: PY, weight: 1.2, cluster: "error-handling",
    patterns: [/\btry\s*:[\s\S]*?\bexcept\b/] },
  { name: "Python f-string",     languages: PY, weight: 0.4, cluster: "python",
    patterns: [/f["'][^"']*\{[^}]+\}/] },
  { name: "Python async/await",  languages: PY, weight: 1.8, cluster: "async",
    patterns: [/\basync\s+def\b/, /\bawait\s+/] },
  { name: "Python type hints",   languages: PY, weight: 1.2, cluster: "types",
    patterns: [/def\s+\w+\([^)]*:\s*\w+/] },
];

/** Sum of all rule weights — the theoretical maximum before calibration. */
export const TOTAL_WEIGHT = RULES.reduce((s, r) => s + r.weight, 0);

/** Lookup by concept name. */
const RULE_BY_NAME = new Map(RULES.map((r) => [r.name, r]));

export function getRule(name: string): Rule | undefined {
  return RULE_BY_NAME.get(name);
}

export function getWeight(name: string): number {
  return RULE_BY_NAME.get(name)?.weight ?? 1.0;
}

export function getCluster(name: string): Cluster {
  return RULE_BY_NAME.get(name)?.cluster ?? "language-core";
}

export const CLUSTER_LABELS: Record<Cluster, string> = {
  react: "React",
  async: "Async & Promises",
  functional: "Functional JS",
  types: "Type Systems",
  "language-core": "Language Core",
  "error-handling": "Error Handling",
  python: "Python Idioms",
};
