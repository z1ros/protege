import * as vscode from "vscode";
import { mountProtegeWebview } from "./chat/webviewHost.js";
import { devPortMapping, isDevMode } from "./devMode.js";

let current: vscode.WebviewPanel | undefined;

export async function openProtegePanel(context: vscode.ExtensionContext) {
  if (current) {
    // Re-reveal in whatever column it's already living in. The lock
    // applied at first-create persists with the group, so we don't
    // need to relock here (and re-running lockEditorGroup would
    // toggle the lock OFF, which is the opposite of what we want).
    current.reveal(current.viewColumn ?? vscode.ViewColumn.Beside, false);
    return current;
  }

  // Force a brand-new editor group to the right of the active one and
  // make it active. Without this, ViewColumn.Beside is unreliable: if
  // an editor group already exists to the right (common when the user
  // has split panes for source files), VS Code reuses that group and
  // drops Protege into it — sharing a tab strip with the user's code,
  // which the user explicitly flagged ("Protege should always open as
  // a NEW window — if there are 5 already, it's the 6th"). Creating
  // an empty group first guarantees Protege gets its own dedicated
  // slot every time. workbench.action.newGroupRight is a built-in
  // command available in both VS Code and Cursor.
  await vscode.commands.executeCommand("workbench.action.newGroupRight");

  current = vscode.window.createWebviewPanel(
    "protege.panel",
    "Protege",
    // ViewColumn.Active = the now-empty group we just created, since
    // newGroupRight focused it. This guarantees Protege lands in the
    // dedicated new column, never merged with an existing one.
    { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.joinPath(context.extensionUri, "dist", "webview"),
      ],
      ...(isDevMode(context.extensionMode) ? { portMapping: devPortMapping() } : {}),
    }
  );

  current.iconPath = vscode.Uri.joinPath(
    context.extensionUri,
    "media",
    "icon.svg"
  );

  mountProtegeWebview(current.webview, context);

  // Lock the Protege editor group so opening files from the explorer
  // (or via go-to-definition, search, etc.) doesn't drop them into
  // the Protege column and shove the panel around.
  //
  // The lock command operates on whichever group is *active*. After
  // createWebviewPanel the new group exists but VS Code's focus
  // transfer hasn't settled yet — a microtask-deferred lock still
  // races and ends up locking the previously active column. A
  // setTimeout(0) macrotask gives the workbench time to finish the
  // group creation + focus shift, then we re-reveal the panel to
  // make absolutely sure its column is active before issuing the
  // lock toggle.
  setTimeout(() => {
    if (!current) return;
    const col = current.viewColumn;
    if (col === undefined) return;
    current.reveal(col, false);
    vscode.commands
      .executeCommand("workbench.action.lockEditorGroup")
      .then(() => undefined, () => undefined);
  }, 50);

  current.onDidDispose(() => {
    current = undefined;
  });

  return current;
}

export function isPanelOpen() {
  return current !== undefined;
}
