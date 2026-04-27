import * as vscode from "vscode";

/**
 * Feature flag plumbing for the Editor Intelligence settings panel.
 *
 * Reads boolean toggles from VS Code's `protege.*` configuration namespace.
 * Each surface registered through `gated()` automatically disposes when
 * the user flips its toggle off and re-registers when they flip it back
 * on — no editor reload required.
 *
 * Naming: keys passed in are short — `codeReview.liveReview`,
 * `teaching.didYouKnow` — and the helper prepends the `protege.` section.
 * Full keys (`protege.codeReview.liveReview`) are also accepted so call
 * sites that already type the prefix do not break.
 */

const SECTION = "protege";

function normalizeKey(key: string): string {
  return key.startsWith(`${SECTION}.`) ? key.slice(SECTION.length + 1) : key;
}

function fullKey(key: string): string {
  return key.startsWith(`${SECTION}.`) ? key : `${SECTION}.${key}`;
}

/** Read the current value of a boolean feature flag. Defaults to false
 *  when the property is absent — package.json is the source of truth for
 *  defaults, and a missing key means the feature simply has no toggle. */
export function isEnabled(key: string): boolean {
  return (
    vscode.workspace
      .getConfiguration(SECTION)
      .get<boolean>(normalizeKey(key)) ?? false
  );
}

/** Subscribe to changes for a single key. Fires the callback whenever
 *  VS Code reports the property changed. */
export function onChange(
  key: string,
  cb: () => void
): vscode.Disposable {
  const target = fullKey(key);
  return vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(target)) cb();
  });
}

type RegisterFn = () => vscode.Disposable | vscode.Disposable[];

/**
 * Register a feature behind a boolean flag.
 *
 *   gated("codeReview.liveReview", () => registerLiveReview(context));
 *
 * Returns a single Disposable that owns the feature lifecycle. When the
 * flag flips off, the underlying register's disposables are disposed.
 * When it flips back on, register() runs again. When the parent context
 * disposes (extension deactivation), everything is cleaned up.
 */
export function gated(
  key: string,
  register: RegisterFn
): vscode.Disposable {
  let active: vscode.Disposable | vscode.Disposable[] | null = null;

  const apply = (): void => {
    const want = isEnabled(key);
    const have = active !== null;
    if (want && !have) {
      try {
        active = register();
      } catch (err) {
        console.warn(
          `[protege] gated(${key}) register failed:`,
          err instanceof Error ? err.message : String(err)
        );
        active = null;
      }
    } else if (!want && have) {
      disposeAll(active);
      active = null;
    }
  };

  apply();
  const sub = onChange(key, apply);

  return new vscode.Disposable(() => {
    sub.dispose();
    if (active) disposeAll(active);
    active = null;
  });
}

function disposeAll(d: vscode.Disposable | vscode.Disposable[] | null): void {
  if (!d) return;
  if (Array.isArray(d)) {
    for (const x of d) {
      try {
        x.dispose();
      } catch {
        // Swallow — disposal failures should never crash the extension.
      }
    }
  } else {
    try {
      d.dispose();
    } catch {
      // Same — best-effort cleanup.
    }
  }
}
