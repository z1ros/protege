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

/**
 * Decide whether an `onDidChangeTextDocument` change should count as
 * an "edit during the post-paste / post-AI-accept window" toward
 * `editedDuring` / `sawEdit`.
 *
 * Codex review caught a self-invalidation bug: the paste itself fires
 * a `text_change` whose document version equals the version observed
 * at the moment `paste_classified` is dispatched. Without gating, the
 * rollup producer's own `onDidChangeTextDocument` handler flips
 * `editedDuring=true` on the same paste, so `kept-as-is` never fires.
 *
 * Primary defence: VS Code increments `TextDocument.version` on every
 * content change. Capture the post-paste version when we observe the
 * paste; only count subsequent changes whose version is strictly
 * greater. Same-version changes are the paste itself (or pre-paste
 * residue we don't want to credit either).
 *
 * Secondary defence (belt-and-suspenders): a 100 ms time grace covers
 * the rare case where the doc can't be located (e.g. the paste
 * happened in a now-closed editor or different file scheme, in which
 * case `pendingVersion` is 0 and version-gating degrades).
 */
export function shouldCountAsEdit(
  pendingVersion: number,
  changeVersion: number,
  pendingTs: number,
  nowMs: number,
  graceMs = 100,
): boolean {
  if (changeVersion <= pendingVersion) return false;
  if (nowMs - pendingTs < graceMs) return false;
  return true;
}
