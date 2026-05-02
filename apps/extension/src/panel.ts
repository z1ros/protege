import * as vscode from "vscode";
import { mountProtegeWebview } from "./chat/webviewHost.js";
import { devPortMapping, isDevMode } from "./devMode.js";

let current: vscode.WebviewPanel | undefined;
// In-flight creation promise. Without this, two near-simultaneous
// callers (launcher click + auth-success auto-open + ready handler)
// both pass the `if (current)` guard while the first call is still
// awaiting `newGroupRight`, and each runs newGroupRight — producing a
// stray empty editor group next to Protege. Holding the promise here
// makes the second caller await the first instead of starting its own
// group-creation sequence.
let opening: Promise<vscode.WebviewPanel> | undefined;

export async function openProtegePanel(context: vscode.ExtensionContext) {
  if (current) {
    // Re-reveal in whatever column it's already living in. The lock
    // applied at first-create persists with the group, so we don't
    // need to relock here (and re-running lockEditorGroup would
    // toggle the lock OFF, which is the opposite of what we want).
    current.reveal(current.viewColumn ?? vscode.ViewColumn.Beside, false);
    return current;
  }
  if (opening) return opening;

  opening = (async () => {
    try {
      // Reuse an existing empty editor group if one's lying around — Cursor
      // restores empty groups across sessions (close Protege → group stays
      // empty → next launch we'd add YET ANOTHER group beside it). Scanning
      // tabGroups.all for a zero-tab group and dropping Protege there keeps
      // the layout clean across reopen cycles. If there's no empty group,
      // fall through to newGroupRight so we still always get our own column.
      const emptyGroup = vscode.window.tabGroups.all.find(
        (g) => g.tabs.length === 0
      );
      let targetColumn: vscode.ViewColumn;
      if (emptyGroup) {
        targetColumn = emptyGroup.viewColumn;
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
        // ViewColumn.Active = the now-empty group we just created, since
        // newGroupRight focused it.
        targetColumn = vscode.ViewColumn.Active;
      }

      const panel = vscode.window.createWebviewPanel(
        "protege.panel",
        "Protege",
        { viewColumn: targetColumn, preserveFocus: false },
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

      panel.iconPath = vscode.Uri.joinPath(
        context.extensionUri,
        "media",
        "icon.svg"
      );

      mountProtegeWebview(panel.webview, context);

      // Lock the Protege editor group so opening files from the explorer
      // (or via go-to-definition, search, etc.) doesn't drop them into
      // the Protege column and shove the panel around.
      //
      // `workbench.action.lockEditorGroup` is a TOGGLE that operates on
      // whichever group is *active* at fire time. A fixed setTimeout
      // races the focus-shift after createWebviewPanel — fires too
      // early and the toggle lands on the wrong group (or no-ops).
      // Instead, gate on the panel becoming active: onDidChangeViewState
      // emits with `active=true` exactly when VS Code marks our column
      // focused, which is the same signal lockEditorGroup uses to pick
      // its target. Self-disposes after the first fire so the toggle
      // runs once, not on every re-focus.
      const lockOnce = panel.onDidChangeViewState((e) => {
        if (!e.webviewPanel.active) return;
        lockOnce.dispose();
        vscode.commands
          .executeCommand("workbench.action.lockEditorGroup")
          .then(() => undefined, () => undefined);
      });
      context.subscriptions.push(lockOnce);
      // Kick a reveal to guarantee the active state fires even if the
      // user clicked away during the brief creation window.
      panel.reveal(panel.viewColumn ?? vscode.ViewColumn.Beside, false);

      panel.onDidDispose(() => {
        current = undefined;
      });

      return panel;
    } finally {
      opening = undefined;
    }
  })();
  return opening;
}

export function isPanelOpen() {
  return current !== undefined;
}
