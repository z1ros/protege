/**
 * Pure classifier(s) used by the rollup producers. Lives in its own
 * module so unit tests can import it without pulling in `vscode`
 * (rollups.ts imports the VS Code namespace for setTimeout
 * subscriptions, which makes vitest fail to resolve under the
 * non-VS-Code Node test environment).
 */

/**
 * Classify the read pattern given how long the user spent before the
 * first edit and how many navigations they made in between.
 *
 *   "deep"    = >=30s + >=2 navs (reads-high)
 *   "jump-in" = <5s + 0 navs   (reads-low)
 *   "skim"    = anything else (deliberately noncommittal — emits no
 *               matchKey on the backend)
 */
export function classifyReadPattern(
  msToFirstEdit: number,
  navCount: number,
): "deep" | "skim" | "jump-in" {
  if (msToFirstEdit >= 30000 && navCount >= 2) return "deep";
  if (msToFirstEdit < 5000 && navCount === 0) return "jump-in";
  return "skim";
}
