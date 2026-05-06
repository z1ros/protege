import * as vscode from "vscode";
import type { Iq3EditorNavigationEvent } from "@protege/types";
import { getBatcher } from "../../echo/batcher.js";

/** Hook def-jump and file-bounce navigation. */
export function startEditorNavigationProducer(ctx: vscode.ExtensionContext) {
  const lastEditByFile = new Map<string, number>();

  ctx.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      lastEditByFile.set(e.document.uri.toString(), Date.now());
    }),
  );

  let lastFile: vscode.Uri | null = null;
  ctx.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor) return;
      const cur = editor.document.uri;
      if (lastFile && lastFile.toString() !== cur.toString()) {
        const lastEditTs = lastEditByFile.get(lastFile.toString());
        const event: Iq3EditorNavigationEvent = {
          type: "editor_navigation",
          ts: Date.now(),
          kind: "file-bounce",
          fromFile: vscode.workspace.asRelativePath(lastFile),
          toFile: vscode.workspace.asRelativePath(cur),
          msSinceEdit: lastEditTs !== undefined
            ? Date.now() - lastEditTs
            : Number.MAX_SAFE_INTEGER,
        };
        getBatcher()?.push(event);
      }
      lastFile = cur;
    }),
  );

  // Def-jump detection: VS Code's command-execution interception isn't
  // cleanly exposed; for Phase A, file-bounce above covers the common
  // navigation pattern. Refinement in a later task.
}
