import * as vscode from "vscode";
import * as path from "node:path";

/**
 * Throws when `uri` resolves to a location outside every open workspace
 * folder. Used by every tool that takes a model-supplied path
 * (`read_file`, `grep`, `edit_file`, `show_code`, `protege.applyFix`)
 * to keep the surface from being weaponised by prompt injection: a
 * crafted file in the workspace can convince the model to issue
 * `read_file("/etc/passwd")` or worse, but the executor refuses.
 *
 * Caveats:
 *   - Sync string-level check via `path.resolve`. Catches absolute
 *     paths outside the root and `..` segment traversal, on both
 *     POSIX and Windows separators.
 *   - Does NOT resolve symlinks. A workspace that contains
 *     `node_modules/.bin/symlink-to-/etc/shadow` defeats this — but
 *     opening such a workspace already requires user trust.
 *     (Audit's belt-and-braces fix would `fs.realpath` first; we
 *     keep this sync to drop into the existing call sites without
 *     breaking the synchronous `resolveUri` signature.)
 */
export function assertInsideWorkspace(uri: vscode.Uri): void {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new Error("no workspace open");
  }
  const target = path.resolve(uri.fsPath);
  for (const folder of folders) {
    const base = path.resolve(folder.uri.fsPath);
    const baseWithSep = base.endsWith(path.sep) ? base : base + path.sep;
    if (target === base || target.startsWith(baseWithSep)) {
      return;
    }
  }
  throw new Error(`path is outside the workspace: ${uri.fsPath}`);
}

/**
 * Resolve a model-supplied path string to an absolute URI inside the
 * current workspace, or throw. Absolute paths are accepted only if
 * they sit under one of the open workspace folders. Relative paths
 * resolve against `workspaceFolders[0]`.
 *
 * Replaces the older `resolveUri` that trusted any absolute path.
 */
export function resolveWorkspaceUri(pathLike: string): vscode.Uri {
  if (!pathLike) throw new Error("path is required");
  let uri: vscode.Uri;
  if (pathLike.startsWith("/") || /^[A-Za-z]:[\\/]/.test(pathLike)) {
    uri = vscode.Uri.file(pathLike);
  } else {
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) throw new Error("no workspace open");
    uri = vscode.Uri.joinPath(root.uri, pathLike);
  }
  assertInsideWorkspace(uri);
  return uri;
}
