/**
 * Regex template table for the most common diagnostic error messages.
 *
 * `aiExplainError` consults this BEFORE hitting the LLM. ~85% of TS,
 * ESLint, pyright, and JS-runtime errors follow rigid templates from
 * the language server — there's no need to spend a token on
 * "Cannot find name 'X'" when we know the answer is always "X isn't
 * imported or defined in scope."
 *
 * Each rule is `[regex, replyBuilder]`. The first match wins. Capture
 * groups feed the replyBuilder so the explanation can reference the
 * specific symbol/type names from the message.
 *
 * Output contract: a single short sentence, max ~15 words, lowercase
 * first letter, no trailing period — same shape `aiExplainError`
 * produces from the LLM.
 */

interface TemplateRule {
  match: RegExp;
  build: (m: RegExpMatchArray) => string;
}

// ---- TypeScript ----
//
// Codes pulled from the most-frequent set in TS error telemetry. Keep
// the match strict enough to extract the parameters, lenient enough to
// survive small TS version drift in the wording.
const TS_RULES: TemplateRule[] = [
  // TS2304: Cannot find name 'X'.
  {
    match: /^(?:TS2304:\s*)?Cannot find name '([^']+)'/,
    build: (m) => `'${m[1]}' isn't imported or defined in this scope`,
  },
  // TS2305: Module 'X' has no exported member 'Y'.
  {
    match: /^(?:TS2305:\s*)?Module '([^']+)' has no exported member '([^']+)'/,
    build: (m) => `'${m[2]}' isn't exported from '${m[1]}' — check the import name`,
  },
  // TS2307: Cannot find module 'X' or its corresponding type declarations.
  {
    match: /^(?:TS2307:\s*)?Cannot find module '([^']+)'/,
    build: (m) => `'${m[1]}' isn't installed or its types are missing — try installing it`,
  },
  // TS2322: Type 'A' is not assignable to type 'B'.
  {
    match: /^(?:TS2322:\s*)?Type '([^']+)' is not assignable to type '([^']+)'/,
    build: (m) => `you're assigning a ${m[1]} where a ${m[2]} is expected`,
  },
  // TS2339: Property 'X' does not exist on type 'Y'.
  {
    match: /^(?:TS2339:\s*)?Property '([^']+)' does not exist on type '([^']+)'/,
    build: (m) => `'${m[1]}' isn't a property of ${m[2]} — check the spelling or the type`,
  },
  // TS2345: Argument of type 'A' is not assignable to parameter of type 'B'.
  {
    match: /^(?:TS2345:\s*)?Argument of type '([^']+)' is not assignable to parameter of type '([^']+)'/,
    build: (m) => `passing a ${m[1]} where a ${m[2]} is expected — convert it or fix the call`,
  },
  // TS2554: Expected N arguments, but got M.
  {
    match: /^(?:TS2554:\s*)?Expected (\d+) arguments?, but got (\d+)/,
    build: (m) => `this call expects ${m[1]} arg${m[1] === "1" ? "" : "s"}, you passed ${m[2]}`,
  },
  // TS2531: Object is possibly 'null'.
  {
    match: /^(?:TS2531:\s*)?Object is possibly 'null'/,
    build: () => `the value can be null here — guard with a null check or use ?.`,
  },
  // TS2532: Object is possibly 'undefined'.
  {
    match: /^(?:TS2532:\s*)?Object is possibly 'undefined'/,
    build: () => `the value can be undefined here — guard with a check or use ?.`,
  },
  // TS18046: 'X' is of type 'unknown'.
  {
    match: /^(?:TS18046:\s*)?'([^']+)' is of type 'unknown'/,
    build: (m) => `'${m[1]}' is unknown — narrow it with typeof/instanceof or a type guard`,
  },
  // TS18047: 'X' is possibly 'null'.
  {
    match: /^(?:TS18047:\s*)?'([^']+)' is possibly 'null'/,
    build: (m) => `'${m[1]}' can be null — guard before using it`,
  },
  // TS18048: 'X' is possibly 'undefined'.
  {
    match: /^(?:TS18048:\s*)?'([^']+)' is possibly 'undefined'/,
    build: (m) => `'${m[1]}' can be undefined — guard before using it`,
  },
  // TS7006: Parameter 'X' implicitly has an 'any' type.
  {
    match: /^(?:TS7006:\s*)?Parameter '([^']+)' implicitly has an 'any' type/,
    build: (m) => `add a type annotation for '${m[1]}' so TS can check it`,
  },
  // TS7053: Element implicitly has an 'any' type because expression of type 'X' can't be used to index type 'Y'.
  {
    match: /^(?:TS7053:\s*)?Element implicitly has an 'any' type/,
    build: () => `TS can't infer the index type — add an index signature or use a typed key`,
  },
  // TS2769: No overload matches this call.
  {
    match: /^(?:TS2769:\s*)?No overload matches this call/,
    build: () => `none of the function signatures match — check the argument types`,
  },
  // TS2451: Cannot redeclare block-scoped variable 'X'.
  {
    match: /^(?:TS2451:\s*)?Cannot redeclare block-scoped variable '([^']+)'/,
    build: (m) => `'${m[1]}' is already declared in this scope — rename or remove one`,
  },
  // TS2552: Cannot find name 'X'. Did you mean 'Y'?
  {
    match: /^(?:TS2552:\s*)?Cannot find name '([^']+)'\.\s*Did you mean '([^']+)'/,
    build: (m) => `'${m[1]}' isn't defined — did you mean '${m[2]}'?`,
  },
];

// ---- ESLint ----
//
// ESLint surfaces messages without a stable code prefix; the rule name
// is appended in parens (e.g. "(no-unused-vars)"). aiExplainError
// receives the raw message — most messages are unique enough that the
// rule-name suffix is optional for matching.
const ESLINT_RULES: TemplateRule[] = [
  // 'X' is defined but never used. (no-unused-vars)
  {
    match: /^'([^']+)' is (?:defined|assigned a value) but never used/,
    build: (m) => `'${m[1]}' is unused — remove it or prefix with _ to silence`,
  },
  // 'X' is not defined. (no-undef)
  {
    match: /^'([^']+)' is not defined\b/,
    build: (m) => `'${m[1]}' isn't declared — import it or define it first`,
  },
  // Unexpected console statement. (no-console)
  {
    match: /^Unexpected console statement\b/,
    build: () => `console is disallowed here — use the project's logger or remove it`,
  },
  // Missing semicolon. (semi)
  {
    match: /^Missing semicolon\b/,
    build: () => `add a semicolon at the end of this statement`,
  },
  // 'X' is already defined. (no-redeclare)
  {
    match: /^'([^']+)' is already defined\b/,
    build: (m) => `'${m[1]}' is already declared in this scope`,
  },
  // Expected 'Y' but found 'X'. (multiple)
  {
    match: /^Expected '([^']+)' (?:but found|or [^']+, but found) '([^']+)'/,
    build: (m) => `expected '${m[1]}', got '${m[2]}'`,
  },
];

// ---- Python (pyright / pylance) ----
const PYTHON_RULES: TemplateRule[] = [
  // "X" is possibly unbound
  {
    match: /^"([^"]+)" is possibly unbound/,
    build: (m) => `'${m[1]}' might not be assigned on every path — initialize it before use`,
  },
  // "X" is not defined
  {
    match: /^"([^"]+)" is not defined/,
    build: (m) => `'${m[1]}' isn't imported or declared — add the import`,
  },
  // Argument of type "A" cannot be assigned to parameter "X" of type "B"
  {
    match: /^Argument of type "([^"]+)" cannot be assigned to parameter (?:"[^"]+" )?of type "([^"]+)"/,
    build: (m) => `passing ${m[1]} where ${m[2]} is expected`,
  },
  // Cannot access member "X" for type "Y"
  {
    match: /^Cannot access member "([^"]+)" for type "([^"]+)"/,
    build: (m) => `'${m[1]}' isn't a member of ${m[2]}`,
  },
  // No overloads for "X" match the provided arguments
  {
    match: /^No overloads for "([^"]+)" match/,
    build: (m) => `no overload of '${m[1]}' matches these arguments`,
  },
  // "X" is not callable
  {
    match: /^"([^"]+)" is not callable/,
    build: (m) => `'${m[1]}' isn't a function — check the type`,
  },
];

// ---- JavaScript runtime (less common in editor diagnostics, but
// shows up via vscode-eslint's report-unused-disable-directives and
// some bundler integrations) ----
const JS_RUNTIME_RULES: TemplateRule[] = [
  // Cannot read properties of undefined (reading 'X')
  {
    match: /Cannot read propert(?:y|ies) of undefined \(reading '([^']+)'\)/,
    build: (m) => `the value before .${m[1]} is undefined — guard with ?. or check it first`,
  },
  // Cannot read properties of null (reading 'X')
  {
    match: /Cannot read propert(?:y|ies) of null \(reading '([^']+)'\)/,
    build: (m) => `the value before .${m[1]} is null — guard before accessing`,
  },
  // X is not a function
  {
    match: /^([A-Za-z_$][A-Za-z0-9_$.]*) is not a function/,
    build: (m) => `'${m[1]}' isn't callable here — check the import or the type`,
  },
  // X is not defined
  {
    match: /^([A-Za-z_$][A-Za-z0-9_$.]*) is not defined/,
    build: (m) => `'${m[1]}' isn't declared in this scope`,
  },
];

const ALL_RULES: TemplateRule[] = [
  ...TS_RULES,
  ...ESLINT_RULES,
  ...PYTHON_RULES,
  ...JS_RUNTIME_RULES,
];

/**
 * Try to explain the error from the template table. Returns null on a
 * miss, signalling the caller should fall through to the LLM (or the
 * server cache, in Phase 2).
 */
export function tryTemplate(
  errorMessage: string,
  _language: string
): string | null {
  const trimmed = errorMessage.trim();
  for (const rule of ALL_RULES) {
    const m = trimmed.match(rule.match);
    if (m) return rule.build(m);
  }
  return null;
}
