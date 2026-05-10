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

/**
 * Count assertion-shaped calls in newly-added lines. Conservative regex —
 * matches the common testing-library names (`expect(`, `assert*(`,
 * `toBe`/`toEqual`/`toContain`/`toHaveBeenCalled`, `should.`) without
 * trying to parse the AST. Cross-framework: Vitest, Jest, Mocha, Chai,
 * node:test, Jasmine.
 */
const ASSERTION_RX =
  /\b(?:expect|assert\w*|toBe\w*|toEqual\w*|toContain\w*|toMatch\w*|toHaveBeenCalled\w*|should\.)\s*\(/g;

function countAssertionsInAddedLines(prior: string[], current: string[]): number {
  const priorSet = new Set(prior);
  let count = 0;
  for (const line of current) {
    if (priorSet.has(line)) continue;
    const matches = line.match(ASSERTION_RX);
    if (matches) count += matches.length;
  }
  return count;
}

export function startLineDiffer(
  context: vscode.ExtensionContext
): vscode.Disposable {
  // Seed snapshots when documents open so the first save has a real
  // baseline to diff against. Without this, the first save of every
  // file emitted no event (the snapshot didn't exist yet), which broke
  // signals for users who edit-and-save a single file in a session.
  // For brand-new files (created via "New File" with no prior content),
  // onDidOpenTextDocument fires with an empty document → snapshot is
  // empty → first save legitimately diffs all-current as added.
  const seedSub = vscode.workspace.onDidOpenTextDocument((doc) => {
    if (doc.uri.scheme !== "file") return;
    if (snapshots.has(doc.fileName)) return;
    snapshots.set(doc.fileName, doc.getText().split(/\r?\n/));
  });

  const sub = vscode.workspace.onDidSaveTextDocument((doc) => {
    if (doc.uri.scheme !== "file") return;
    const file = doc.fileName;
    const now = Date.now();
    const current = doc.getText().split(/\r?\n/);
    // Fallback to empty prior if we somehow missed the open event
    // (rare — e.g. file written by an external tool then saved by
    // the user without an editor open). Treats the whole document
    // as freshly added, which is the correct behavior for that case.
    const prior = snapshots.get(file) ?? [];
    snapshots.set(file, current);

    const { linesAdded, linesRemoved, rewritten } = computeLineDiff(
      prior,
      current,
      file,
      { hashString }
    );

    if (linesAdded === 0 && linesRemoved === 0 && rewritten.length === 0) return;

    const b = getBatcher();
    if (!b) return;
    const assertionsAdded = countAssertionsInAddedLines(prior, current);
    b.push({
      type: "line_diff",
      ts: now,
      file,
      linesAdded,
      linesRemoved,
      assertionsAdded,
      rewrittenFingerprints: rewritten.slice(0, 50),
    });
  });

  context.subscriptions.push(seedSub, sub);
  return sub;
}
