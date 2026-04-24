import * as vscode from "vscode";
import { createHash } from "node:crypto";
import { computeLineDiff } from "@protege/types";
import { getBatcher } from "./batcher.js";

/**
 * Line-level diff on save. Compares the current document text against the
 * prior save snapshot, emits a line_diff event with added/removed counts
 * and fingerprints for lines that were rewritten in place. The backend's
 * LineRewriteCounter bumps on each fingerprint it sees. The pure math
 * lives in @protege/types so it can be unit-tested without VS Code.
 */

const snapshots = new Map<string, string[]>();

function hashString(s: string): string {
  return createHash("sha1").update(s).digest("hex").slice(0, 16);
}

export function startLineDiffer(
  context: vscode.ExtensionContext
): vscode.Disposable {
  const sub = vscode.workspace.onDidSaveTextDocument((doc) => {
    if (doc.uri.scheme !== "file") return;
    const file = doc.fileName;
    const now = Date.now();
    const current = doc.getText().split(/\r?\n/);
    const prior = snapshots.get(file);
    snapshots.set(file, current);
    if (!prior) return;

    const { linesAdded, linesRemoved, rewritten } = computeLineDiff(
      prior,
      current,
      file,
      { hashString }
    );

    if (linesAdded === 0 && linesRemoved === 0 && rewritten.length === 0) return;

    const b = getBatcher();
    if (!b) return;
    b.push({
      type: "line_diff",
      ts: now,
      file,
      linesAdded,
      linesRemoved,
      rewrittenFingerprints: rewritten.slice(0, 50),
    });
  });

  context.subscriptions.push(sub);
  return sub;
}
