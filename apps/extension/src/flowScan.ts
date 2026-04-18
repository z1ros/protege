import * as vscode from "vscode";
import * as path from "node:path";
import { aiQuery } from "./aiBackend.js";
import { ingestFindings } from "./liveReview.js";
import {
  ensureWorkspaceIndex,
  workspaceIndexReady,
} from "./workspaceIndex.js";
import type { Anchor, Suggestion } from "./reviewEngine.js";

/**
 * IDLE clock — Tier 3 of the tiered scan pipeline.
 *
 * Runs quietly in the background when the user is idle (no keystrokes /
 * cursor moves for ≥ IDLE_TRIGGER_MS). Looks for FLOW-scope issues —
 * architectural bugs that span multiple files, like:
 *   • provider-consumer mismatch
 *   • prop drilling ≥3 hops
 *   • shared state mutated from an unexpected place
 *   • API contract drift between frontend + backend
 *
 * Implementation: rotates through small "clusters" of related files from
 * the workspace index and asks the on-device model to identify cross-file
 * flows. One cluster per idle window so we never block the machine.
 *
 * Feature-flagged to off by default for now — enable via setting
 * `protege.flowScanEnabled` (Stage 5 of ambient-coach-plan.md).
 */

const IDLE_TRIGGER_MS = 30_000;     // user must be idle this long
const IDLE_COOLDOWN_MS = 90_000;    // min gap between two IDLE passes
const CLUSTER_SIZE = 4;             // files per pass
const MAX_BYTES_PER_FILE = 40_000;
const NEIGHBOR_HEAD_LINES = 30;
const MAX_PASS_TIME_MS = 20_000;    // kill-switch if Qwen stalls

let lastActivityMs = Date.now();
let lastPassEndedMs = 0;
let passInFlight = false;
let tickTimer: ReturnType<typeof setInterval> | null = null;

// ---- Registration ----

export function registerFlowScan(
  _context: vscode.ExtensionContext
): vscode.Disposable[] {
  if (!isEnabled()) return [];

  const disposables: vscode.Disposable[] = [];

  // Treat any editor activity as "the user is busy".
  const bump = () => {
    lastActivityMs = Date.now();
  };
  disposables.push(
    vscode.window.onDidChangeTextEditorSelection(bump),
    vscode.workspace.onDidChangeTextDocument(bump),
    vscode.window.onDidChangeActiveTextEditor(bump)
  );

  // Tick every 10s, decide whether to run a pass.
  tickTimer = setInterval(() => {
    void maybeRunPass();
  }, 10_000);

  disposables.push(
    new vscode.Disposable(() => {
      if (tickTimer) clearInterval(tickTimer);
      tickTimer = null;
    })
  );

  return disposables;
}

// ---- Tick loop ----

async function maybeRunPass(): Promise<void> {
  if (passInFlight) return;
  if (!isEnabled()) return;

  const now = Date.now();
  if (now - lastActivityMs < IDLE_TRIGGER_MS) return;
  if (now - lastPassEndedMs < IDLE_COOLDOWN_MS) return;

  await ensureWorkspaceIndex();
  if (!workspaceIndexReady()) return;

  passInFlight = true;
  const killTimer = setTimeout(() => {
    // Hard kill-switch — if the model stalls we don't want to pin CPU.
    passInFlight = false;
    console.warn("[protege] flowScan: kill-switch fired");
  }, MAX_PASS_TIME_MS);

  try {
    await runOnePass();
  } catch (err) {
    console.warn("[protege] flowScan pass failed:", err);
  } finally {
    clearTimeout(killTimer);
    passInFlight = false;
    lastPassEndedMs = Date.now();
  }
}

// ---- Pass implementation ----

async function runOnePass(): Promise<void> {
  const cluster = pickCluster();
  if (cluster.length < 2) return;

  // Build a prompt with head snippets of each file.
  const snippets = await Promise.all(
    cluster.map(async (fsPath) => {
      try {
        const uri = vscode.Uri.file(fsPath);
        const buf = await vscode.workspace.fs.readFile(uri);
        if (buf.byteLength > MAX_BYTES_PER_FILE) return null;
        const text = new TextDecoder().decode(buf);
        const head = text.split("\n").slice(0, NEIGHBOR_HEAD_LINES).join("\n");
        return { fsPath, head };
      } catch {
        return null;
      }
    })
  );
  const usable = snippets.filter((s): s is { fsPath: string; head: string } => !!s);
  if (usable.length < 2) return;

  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
  const block = usable
    .map(
      (s) =>
        `### FILE: ${root ? path.relative(root, s.fsPath) : s.fsPath}\n\`\`\`\n${s.head}\n\`\`\``
    )
    .join("\n\n");

  const prompt = `You are auditing a cluster of related files for ARCHITECTURAL issues — bugs that span MULTIPLE FILES, not style nits. Examples:
- context provider wraps the wrong subtree for a consumer
- stale state passed through multiple component hops
- API shape mismatch between producer and consumer
- prop drilling ≥3 hops
- cleanup missing across mount/unmount boundaries

Return ONLY a JSON array. Each item is an object:
- "primaryFile": relative path — the file that should host the main finding
- "line": 1-based line in primaryFile
- "severity": "warn" | "perf" | "info"
- "message": one sentence, plain English, specific
- "ruleId": short kebab-case id
- "anchors": array of { "file": "<relative path>", "line": <1-based>, "label": "<why this line matters>" } — MUST include 1+ anchor in a DIFFERENT file to count as a flow
- "flowId": short unique id for this finding

Rules:
- Return at most 2 items, only if truly cross-file
- Zero items is the right answer most of the time — don't invent findings
- Output ONLY the JSON array

${block}`;

  const raw = await aiQuery(prompt, 800);
  if (!raw) return;

  const findings = parseFlowFindings(raw, usable);

  // Group findings by primary-file URI and push to the store.
  const byUri = new Map<string, Suggestion[]>();
  for (const f of findings) {
    const arr = byUri.get(f._primaryUri) ?? [];
    arr.push(f.suggestion);
    byUri.set(f._primaryUri, arr);
  }
  for (const [uri, list] of byUri) {
    ingestFindings(uri, list);
  }
}

// ---- Cluster picking ----
//
// Simple heuristic: rotate through currently-open editors each idle pass
// and grab N-1 of the chosen seed's workspace neighbors.

let cursor = 0;

function pickCluster(): string[] {
  const openUris = vscode.window.visibleTextEditors
    .map((e) => e.document.uri)
    .filter((u) => u.scheme === "file");

  const seeds = openUris.map((u) => u.fsPath);
  if (seeds.length === 0) return [];

  const seed = seeds[cursor % seeds.length];
  if (!seed) return [];
  cursor = (cursor + 1) % Math.max(1, seeds.length);

  // Static import ordering is fine here — workspaceIndex doesn't import us.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getNeighbors } = require("./workspaceIndex.js") as {
    getNeighbors: (uri: vscode.Uri, limit?: number) => string[];
  };
  const neighbors = getNeighbors(vscode.Uri.file(seed), CLUSTER_SIZE - 1);
  return [seed, ...neighbors];
}

// ---- Parse ----

interface RawFlowFinding {
  primaryFile?: string;
  line?: number;
  severity?: Suggestion["severity"];
  message?: string;
  ruleId?: string;
  anchors?: Array<{ file?: string; line?: number; label?: string }>;
  flowId?: string;
}

function parseFlowFindings(
  raw: string,
  usable: Array<{ fsPath: string; head: string }>
): Array<{ suggestion: Suggestion; _primaryUri: string }> {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return [];

  let arr: unknown;
  try {
    arr = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];

  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
  const out: Array<{ suggestion: Suggestion; _primaryUri: string }> = [];

  for (const item of arr as RawFlowFinding[]) {
    if (!item || typeof item !== "object") continue;
    if (typeof item.message !== "string" || typeof item.line !== "number") continue;
    if (!["warn", "perf", "info"].includes(item.severity ?? "")) continue;
    if (!item.primaryFile || !Array.isArray(item.anchors) || item.anchors.length === 0) continue;

    const primary = usable.find(
      (u) =>
        u.fsPath === path.resolve(root, item.primaryFile ?? "") ||
        u.fsPath.endsWith(item.primaryFile ?? "__unlikely__")
    );
    if (!primary) continue;

    const anchors: Anchor[] = [];
    for (const a of item.anchors) {
      if (!a || typeof a.file !== "string" || typeof a.line !== "number") continue;
      if (a.file === item.primaryFile) continue; // skip self-anchors
      const match = usable.find(
        (u) =>
          u.fsPath === path.resolve(root, a.file ?? "") ||
          u.fsPath.endsWith(a.file ?? "__unlikely__")
      );
      if (!match) continue;
      anchors.push({
        uri: vscode.Uri.file(match.fsPath).toString(),
        line: Math.max(0, Math.floor(a.line) - 1),
        label: typeof a.label === "string" ? a.label : "related",
      });
    }
    if (anchors.length === 0) continue; // flow requires ≥1 cross-file anchor

    const primaryUri = vscode.Uri.file(primary.fsPath);
    const line = Math.max(0, Math.floor(item.line) - 1);
    const range = new vscode.Range(line, 0, line, 0);

    out.push({
      _primaryUri: primaryUri.toString(),
      suggestion: {
        range,
        message: item.message.trim(),
        severity: item.severity!,
        ruleId: (item.ruleId || "cross-file-flow").trim(),
        scope: "flow",
        anchors,
        flowId: item.flowId || `flow-${Date.now().toString(36)}`,
        tier: "idle",
      },
    });
  }

  return out;
}

// ---- Feature flag ----

function isEnabled(): boolean {
  return (
    vscode.workspace
      .getConfiguration("protege")
      .get<boolean>("flowScanEnabled", false) === true
  );
}
