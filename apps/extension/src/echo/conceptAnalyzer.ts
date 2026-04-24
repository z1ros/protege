import * as vscode from "vscode";
import { conceptCluster } from "@protege/types";
import { detectHybrid } from "../concepts/hybridDetector.js";
import { getBatcher } from "./batcher.js";

/**
 * R1 concept analyzer. Subscribes to onDidOpenTextDocument and
 * onDidSaveTextDocument, runs the existing hybrid concept detector (AST +
 * regex; AI layer skipped — we want reliability, not novelty), and emits
 * a `concept_encountered` EchoEvent for each concept found.
 *
 * Deduplication is local: a short-lived Map<filePath, Set<concept>>
 * suppresses repeat emissions for the same (file, concept) pair. The
 * cache is cleared every 24h so next-day reopens are tracked as fresh
 * encounters. The backend also dedupes by (userId, concept, file,
 * day-of-seenAt) as a second line of defense.
 *
 * Guardrails: skip plaintext/binary, skip
 * node_modules / dist / .git / build, skip files larger than 2 MB. All
 * work runs inside a microtask so the editor stays responsive.
 */

const MAX_FILE_SIZE = 2 * 1024 * 1024;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PATH_SKIP_RE = /(^|\/)(node_modules|dist|\.git|build)(\/|$)/;

const recentlySeen = new Map<string, Set<string>>();
let lastCacheReset = Date.now();

function maybeResetCache(): void {
  const now = Date.now();
  if (now - lastCacheReset > CACHE_TTL_MS) {
    recentlySeen.clear();
    lastCacheReset = now;
  }
}

function shouldSkip(doc: vscode.TextDocument): boolean {
  if (doc.uri.scheme !== "file") return true;
  const lang = doc.languageId;
  if (!lang || lang === "plaintext" || lang === "binary") return true;
  const size = doc.getText().length;
  if (size === 0 || size > MAX_FILE_SIZE) return true;
  if (PATH_SKIP_RE.test(doc.fileName)) return true;
  return false;
}

async function analyzeAndEmit(doc: vscode.TextDocument): Promise<void> {
  if (shouldSkip(doc)) return;
  maybeResetCache();
  const file = doc.fileName;
  const content = doc.getText();
  // AI layer disabled — the encounter signal must be deterministic. AST
  // + regex already cover every concept in CONCEPT_META.
  const detection = await detectHybrid(content, file, doc.languageId, "", false);
  if (detection.concepts.length === 0) return;

  const seen = recentlySeen.get(file) ?? new Set<string>();
  const fresh: Array<{ name: string; cluster: string }> = [];
  for (const c of detection.concepts) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    fresh.push({ name: c.name, cluster: conceptCluster(c.name) });
  }
  recentlySeen.set(file, seen);
  if (fresh.length === 0) return;

  const b = getBatcher();
  if (!b) return;
  const ts = Date.now();
  // languageId can be "plaintext" for files VS Code can't classify; we
  // prefer null over that label so the picker never offers "plaintext".
  const rawLang = doc.languageId;
  const language =
    rawLang && rawLang !== "plaintext" ? rawLang : null;
  for (const c of fresh) {
    b.push({
      type: "concept_encountered",
      ts,
      file,
      concept: c.name,
      cluster: c.cluster,
      language,
    });
  }
}

export function startConceptAnalyzer(
  context: vscode.ExtensionContext
): vscode.Disposable {
  const subs: vscode.Disposable[] = [];

  subs.push(
    vscode.workspace.onDidOpenTextDocument((doc) => {
      // Defer to microtask so opening a file stays snappy.
      queueMicrotask(() => {
        void analyzeAndEmit(doc);
      });
    })
  );

  subs.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      queueMicrotask(() => {
        void analyzeAndEmit(doc);
      });
    })
  );

  const disposable = new vscode.Disposable(() => {
    for (const s of subs) s.dispose();
    recentlySeen.clear();
  });
  context.subscriptions.push(disposable);
  return disposable;
}
