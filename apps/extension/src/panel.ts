import * as vscode from "vscode";
import { mountProtegeWebview } from "./chat/webviewHost.js";

let current: vscode.WebviewPanel | undefined;

export function openProtegePanel(context: vscode.ExtensionContext) {
  const column = vscode.ViewColumn.Two;

  if (current) {
    current.reveal(column, false);
    return current;
  }

  current = vscode.window.createWebviewPanel(
    "protege.panel",
    "Protege",
    { viewColumn: column, preserveFocus: false },
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.joinPath(context.extensionUri, "dist", "webview"),
      ],
    }
  );

  current.iconPath = vscode.Uri.joinPath(
    context.extensionUri,
    "media",
    "icon.svg"
  );

  mountProtegeWebview(current.webview, context);

  current.onDidDispose(() => {
    current = undefined;
  });

  return current;
}

export function isPanelOpen() {
  return current !== undefined;
}
