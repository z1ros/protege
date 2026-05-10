import * as vscode from "vscode";
import { mountProtegeWebview } from "./chat/webviewHost.js";
import { devPortMapping, isDevMode } from "./devMode.js";
import { log } from "./log.js";

let current: vscode.WebviewPanel | undefined;
// In-flight creation promise. Without this, two near-simultaneous
// callers (launcher click + auth-success auto-open + ready handler)
// both pass the `if (current)` guard while the first call is still
// awaiting `newGroupRight`, and each runs newGroupRight — producing a
// stray empty editor group next to Protege. Holding the promise here
// makes the second caller await the first instead of starting its own
// group-creation sequence.
let opening: Promise<vscode.WebviewPanel> | undefined;
// Track when `opening` was last set. The original guard assumes the
// IIFE's `finally` always clears `opening` — but in practice we've
// observed the promise getting stuck (e.g., a hung newGroupRight call
// or an unhandled exception in a path the finally doesn't catch),
// after which EVERY subsequent caller short-circuits to the dead
// promise and no panel is ever created. If openingStartedAt is more
// than this many ms ago AND `current` is still empty, treat the
// promise as stale and force a fresh create.
let openingStartedAt = 0;
const OPENING_STALE_MS = 5000;

export async function openProtegePanel(context: vscode.ExtensionContext) {
  if (current) {
    // Re-reveal in whatever column it's already living in. The lock
    // applied at first-create persists with the group, so we don't
    // need to relock here (and re-running lockEditorGroup would
    // toggle the lock OFF, which is the opposite of what we want).
    //
    // Defensive: closing the panel via the tab's X button (or closing
    // the entire editor GROUP) doesn't always cleanly fire
    // `onDidDispose` before the user clicks the launcher again — the
    // ref can outlive the real panel.
    //
    // In Cursor specifically, `reveal()` and `viewColumn` getter both
    // silently no-op on a disposed panel instead of throwing — so the
    // earlier "wrap reveal in try/catch" approach never tripped, the
    // function returned the dead panel, and the launcher's post-await
    // `panel.viewType` access threw "Webview is disposed" (which IS
    // the one accessor that DOES throw on disposed panels in Cursor).
    //
    // Probe `viewType` directly here as our liveness check, BEFORE
    // calling reveal. If the panel is disposed, this throws, we clear
    // the stale ref, and fall through to build a fresh panel.
    let alive = false;
    try {
      void current.viewType;
      alive = true;
    } catch {
      console.log("[protege] panel: stale current ref (probe failed), rebuilding");
      current = undefined;
    }
    if (alive && current) {
      try {
        current.reveal(current.viewColumn ?? vscode.ViewColumn.Beside, false);
        return current;
      } catch {
        console.log("[protege] panel: stale current ref (reveal failed), rebuilding");
        current = undefined;
      }
    }
  }
  if (opening) {
    // Detect a stale `opening` promise. Symptom: every call sees
    // `opening? true currentPanel? false`, and the launcher's
    // `await openProtegePanel` resolves to `panel=present` ~1ms later
    // (i.e., the promise has settled but `finally` never cleared it
    // AND `current` was never set — broken state). Force a rebuild
    // rather than handing back the dead promise forever.
    const ageMs = Date.now() - openingStartedAt;
    if (!current && ageMs > OPENING_STALE_MS) {
      console.log(`[protege] panel: stale opening promise (age=${ageMs}ms), rebuilding`);
      opening = undefined;
      openingStartedAt = 0;
    } else {
      return opening;
    }
  }

  openingStartedAt = Date.now();
  opening = (async () => {
    try {
      console.log("[protege] panel: opening — picking target column");
      // Reuse an existing empty editor group if one's lying around — Cursor
      // restores empty groups across sessions (close Protege → group stays
      // empty → next launch we'd add YET ANOTHER group beside it). Scanning
      // tabGroups.all for a zero-tab group and dropping Protege there keeps
      // the layout clean across reopen cycles. If there's no empty group,
      // fall through to newGroupRight so we still always get our own column.
      let targetColumn: vscode.ViewColumn;
      try {
        const emptyGroup = vscode.window.tabGroups.all.find(
          (g) => g.tabs.length === 0
        );
        if (emptyGroup && emptyGroup.viewColumn !== undefined) {
          targetColumn = emptyGroup.viewColumn;
          console.log(`[protege] panel: reusing empty group at column ${targetColumn}`);
        } else {
          // Force a brand-new editor group to the right of the active one
          // and make it active. Without this, ViewColumn.Beside is unreliable:
          // if an editor group already exists to the right (common when the
          // user has split panes for source files), VS Code reuses that
          // group and drops Protege into it — sharing a tab strip with the
          // user's code, which the user explicitly flagged ("Protege should
          // always open as a NEW window — if there are 5 already, it's the
          // 6th"). workbench.action.newGroupRight is a built-in command
          // available in both VS Code and Cursor.
          await vscode.commands.executeCommand("workbench.action.newGroupRight");
          // Capture the actual column number of the newly-focused group
          // rather than passing ViewColumn.Active (-1). The Active enum
          // is resolved lazily by createWebviewPanel, and during the
          // post-newGroupRight transition the resolution can land on
          // the source column momentarily, which then triggers the
          // viewState transient that the lockOnce guard now rejects.
          // Using the explicit column makes both paths deterministic.
          const newCol = vscode.window.tabGroups.activeTabGroup.viewColumn;
          targetColumn = newCol ?? vscode.ViewColumn.Beside;
          console.log(`[protege] panel: created new group right at column ${targetColumn}`);
        }
      } catch (err) {
        // Group selection failed (newGroupRight rejected, tabGroups api
        // misbehaved, etc.) — fall back to ViewColumn.Beside which is
        // built into createWebviewPanel itself. Worse layout, but the
        // panel WILL appear, which is the priority.
        console.warn(
          `[protege] panel: column selection failed (${err instanceof Error ? err.message : String(err)}), falling back to ViewColumn.Beside`
        );
        targetColumn = vscode.ViewColumn.Beside;
      }

      console.log(`[protege] panel: createWebviewPanel column=${targetColumn}`);
      const panel = vscode.window.createWebviewPanel(
        // viewType bumped to v2 to clear stale per-viewType state
        // Cursor may have persisted under "protege.panel" (saved
        // column layout, serializer hooks, etc.) during the dispose
        // cascade investigation. Once Cursor has had a clean reopen
        // cycle on v2, this can be reverted.
        "protege.panel.v2",
        "Protege",
        // preserveFocus: true — preventing the webview from aggressively
        // stealing focus during creation. With preserveFocus:false,
        // Cursor flips focus through the panel's column, fires multiple
        // viewState transitions, and the panel cascades into dispose
        // when other text editors are open. preserveFocus:true keeps
        // the editor that had focus before, and we trigger an explicit
        // reveal AFTER the panel has fully mounted (see below).
        { viewColumn: targetColumn, preserveFocus: true },
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [
            vscode.Uri.joinPath(context.extensionUri, "dist", "webview"),
          ],
          ...(isDevMode(context.extensionMode) ? { portMapping: devPortMapping() } : {}),
        }
      );
      current = panel;
      console.log("[protege] panel: created");

      panel.iconPath = vscode.Uri.joinPath(
        context.extensionUri,
        "media",
        "icon.svg"
      );

      mountProtegeWebview(panel.webview, context);

      // NOTE: previously we ran `workbench.action.lockEditorGroup` here
      // to prevent opening files from the explorer / go-to-definition
      // from landing in the Protege column. In Cursor specifically,
      // executing that toggle against a webview-only editor group
      // disposes the webview ~13ms later (panel transitions
      // active→inactive→active→dispose after the lock command lands).
      // Removing the lock restores open-with-other-files behavior;
      // the Protege-column-pollution tradeoff is a smaller bug than
      // "panel never opens." If/when we want pollution prevention back,
      // replace the toggle with a declarative API or a Cursor-version
      // gate.
      // Defer the reveal to the next tick so it fires after the
      // createWebviewPanel(preserveFocus:true) lifecycle has fully
      // committed. Direct `panel.reveal(...)` synchronously after
      // create+mount destabilizes the panel in Cursor (multiple
      // viewState transitions inside one tick → dispose cascade).
      setTimeout(() => {
        try {
          panel.reveal(panel.viewColumn ?? vscode.ViewColumn.Beside, false);
        } catch {
          // Reveal can race against panel disposal in Cursor; the
          // user will see the panel via the create-time placement
          // either way. Swallow.
        }
      }, 0);

      panel.onDidDispose(() => {
        log("panel", "disposed — clearing current ref");
        if (current === panel) {
          current = undefined;
        }
      });

      return panel;
    } catch (err) {
      console.error("[protege] panel: IIFE threw:", err);
      throw err;
    } finally {
      opening = undefined;
      openingStartedAt = 0;
    }
  })();
  return opening;
}

export function isPanelOpen() {
  return current !== undefined;
}
