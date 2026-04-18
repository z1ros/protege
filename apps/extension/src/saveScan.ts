import * as vscode from "vscode";
import * as path from "node:path";
import { aiQuery } from "./aiBackend.js";
import { ingestFindings } from "./liveReview.js";
import {
  ensureWorkspaceIndex,
  getNeighbors,
  workspaceIndexReady,
} from "./workspaceIndex.js";
import type { Anchor, Suggestion } from "./reviewEngine.js";

/**
 * SAVE clock — Tier 2 of the tiered scan pipeline.
 *
 * Fires on `onDidSaveTextDocument` with a short grace period so it doesn't
 * step on the LIVE scanner. Re-scans the saved file WITH context from its
 * direct neighbors (1-hop imports + importers), using the on-device model.
 *
 * What LIVE can't see, SAVE can:
 *   - "this prop is defined but never used in the child"
 *   - "you export `Foo` from here but nobody imports it"
 *   - "the provider in A wraps the wrong subtree for consumer in B"
 *   - "this function is ~20 lines and has a stale-closure bug"
 *
 * Emits `Suggestion`s with `scope: "block" | "flow"` + `anchors[]`. They
 * merge into the same store the LIVE scanner writes to, so the Whisper
 * and Ghost render them without any surface changes.
 *
 * On-device-friendly: keeps neighbor context budget small (5 files max,
 * top 40 lines each) so Qwen 1.5B can chew it in ~3-5s.
 */

// ---- Tuning ----

const SAVE_DEBOUNCE_MS = 1_500;
const MAX_NEIGHBORS = 5;
const NEIGHBOR_HEAD_LINES = 40;
const MAX_BYTES_PER_FILE = 60_000;
const MAX_TARGET_LINES = 300;

// ---- State ----

const pending = new Map<string, ReturnType<typeof setTimeout>>();
const inFlight = new Set<string>();

// ---- Public API ----

export function registerSaveScan(
  _context: vscode.ExtensionContext
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  disposables.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (!isScannable(doc)) return;
      schedule(doc);
    })
  );

  // Cleanup — cancel pending timers.
  disposables.push(
    new vscode.Disposable(() => {
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
      inFlight.clear();
    })
  );

  return disposables;
}

// ---- Scheduling ----

function schedule(doc: vscode.TextDocument): void {
  const key = doc.uri.toString();

  const prev = pending.get(key);
  if (prev) clearTimeout(prev);

  const timer = setTimeout(() => {
    pending.delete(key);
    void run(doc);
  }, SAVE_DEBOUNCE_MS);

  pending.set(key, timer);
}

async function run(doc: vscode.TextDocument): Promise<void> {
  const key = doc.uri.toString();
  if (inFlight.has(key)) return;

  inFlight.add(key);
  try {
    await ensureWorkspaceIndex();
    if (!workspaceIndexReady()) return;

    const target = doc.getText();
    if (!target.trim()) return;

    const neighbors = await collectNeighborContext(doc);

    const prompt = buildPrompt(doc, target, neighbors);
    const raw = await aiQuery(prompt, 768);
    if (!raw) return;

    const findings = parseFindings(raw, doc, neighbors);
    if (findings.length > 0) {
      ingestFindings(key, findings);
    } else {
      // Fire an empty update so downstream observers refresh too.
      ingestFindings(key, []);
    }
  } catch (err) {
    console.warn("[protege] saveScan failed:", err);
  } finally {
    inFlight.delete(key);
  }
}

// ---- Neighbor context ----

interface NeighborSnippet {
  fsPath: string;
  relPath: string;
  head: string;
}

async function collectNeighborContext(
  doc: vscode.TextDocument
): Promise<NeighborSnippet[]> {
  const neighbors = getNeighbors(doc.uri, MAX_NEIGHBORS);
  const root = vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.fsPath ?? "";
  const out: NeighborSnippet[] = [];

  for (const fsPath of neighbors) {
    try {
      const uri = vscode.Uri.file(fsPath);
      const buf = await vscode.workspace.fs.readFile(uri);
      if (buf.byteLength > MAX_BYTES_PER_FILE) continue;
      const text = new TextDecoder().decode(buf);
      const lines = text.split("\n").slice(0, NEIGHBOR_HEAD_LINES);
      out.push({
        fsPath,
        relPath: root ? path.relative(root, fsPath) : fsPath,
        head: lines.join("\n"),
      });
    } catch {
      // Skip unreadable files.
    }
  }

  return out;
}

// ---- Prompt ----

function buildPrompt(
  doc: vscode.TextDocument,
  targetText: string,
  neighbors: NeighborSnippet[]
): string {
  const lang = doc.languageId;
  const fileName = doc.fileName.split(/[\\/]/).pop() ?? "file";
  const truncated = truncate(targetText, MAX_TARGET_LINES);

  const neighborBlock =
    neighbors.length === 0
      ? "(no neighbors indexed yet)"
      : neighbors
          .map(
            (n) =>
              `### NEIGHBOR: ${n.relPath}\n\`\`\`\n${n.head}\n\`\`\``
          )
          .join("\n\n");

  return `You are a senior code reviewer auditing a file plus its immediate neighbors. Find issues that span MULTIPLE lines (a whole function) or MULTIPLE files (usage / provider / contract mismatches). SKIP one-line nits — those are caught elsewhere.

Return ONLY a JSON array. Each item is an object with:
- "line": 1-based start line IN THE TARGET FILE
- "endLine": 1-based end line in the target file (same as "line" for single-line; larger for block issues)
- "severity": "warn" | "perf" | "info"
- "scope": "block" (within the target file, spans multiple lines) OR "flow" (involves a neighbor)
- "message": one plain-English sentence describing the issue
- "fix": OPTIONAL replacement text for the target-file range (only if you're confident)
- "ruleId": short kebab-case id
- "anchors": OPTIONAL array of { "file": "<relative path of a neighbor>", "line": <1-based>, "label": "<why this line matters>" } — ONLY for scope="flow"

Rules:
- Return at most 4 items, highest-value first
- Skip atoms (single-line typos / missing semicolons)
- Skip issues in commented-out code
- If nothing cross-line or cross-file is wrong, return []
- Output ONLY the JSON array — no prose, no markdown, no code fences

TARGET FILE: ${fileName}
LANGUAGE: ${lang}

\`\`\`${lang}
${truncated}
\`\`\`

${neighborBlock}`;
}

function truncate(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join("\n") + "\n// …truncated";
}

// ---- Parsing ----

interface RawFinding {
  line: number;
  endLine?: number;
  severity: Suggestion["severity"];
  scope?: "block" | "flow";
  message: string;
  fix?: string;
  ruleId?: string;
  anchors?: Array<{ file?: string; line?: number; label?: string }>;
}

function parseFindings(
  raw: string,
  doc: vscode.TextDocument,
  neighbors: NeighborSnippet[]
): Suggestion[] {
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

  const out: Suggestion[] = [];

  for (const item of arr as RawFinding[]) {
    if (!item || typeof item !== "object") continue;
    if (typeof item.line !== "number" || typeof item.message !== "string") continue;
    if (!["warn", "perf", "info"].includes(item.severity)) continue;

    const startLine = clampLine(doc, item.line - 1);
    const endLine = clampLine(
      doc,
      typeof item.endLine === "number" ? item.endLine - 1 : startLine
    );
    const s = Math.min(startLine, endLine);
    const e = Math.max(startLine, endLine);

    const lineText = doc.lineAt(s).text;
    const endLineText = doc.lineAt(e).text;
    const rangeStart = new vscode.Position(s, lineText.search(/\S/) === -1 ? 0 : lineText.search(/\S/));
    const rangeEnd = new vscode.Position(e, endLineText.length);

    const scope: Suggestion["scope"] =
      item.scope === "flow" ? "flow" :
      item.scope === "block" ? "block" :
      s !== e ? "block" :
      "block";

    const anchors: Anchor[] = [];
    if (Array.isArray(item.anchors)) {
      for (const a of item.anchors) {
        if (!a || typeof a.file !== "string" || typeof a.line !== "number") continue;
        const match = neighbors.find(
          (n) => n.relPath === a.file || n.fsPath.endsWith(a.file)
        );
        if (!match) continue;
        anchors.push({
          uri: vscode.Uri.file(match.fsPath).toString(),
          line: Math.max(0, Math.floor(a.line) - 1),
          label: typeof a.label === "string" ? a.label : "related",
        });
      }
    }

    const suggestion: Suggestion = {
      range: new vscode.Range(rangeStart, rangeEnd),
      message: item.message.trim(),
      severity: item.severity,
      ruleId: (item.ruleId || `save-${scope}`).trim(),
      fix: item.fix?.trim() || undefined,
      scope: anchors.length > 0 ? "flow" : scope,
      anchors: anchors.length > 0 ? anchors : undefined,
      flowId: anchors.length > 0 ? makeFlowId(doc.uri, startLine) : undefined,
      tier: "save",
    };
    out.push(suggestion);
  }

  return out;
}

function clampLine(doc: vscode.TextDocument, line: number): number {
  return Math.max(0, Math.min(doc.lineCount - 1, Math.floor(line)));
}

function makeFlowId(uri: vscode.Uri, line: number): string {
  return `${path.basename(uri.fsPath)}:${line}:${Date.now().toString(36).slice(-4)}`;
}

// ---- Guards ----

function isScannable(doc: vscode.TextDocument): boolean {
  if (doc.uri.scheme !== "file") return false;
  if (doc.isUntitled) return false;
  const ext = path.extname(doc.fileName).toLowerCase();
  return [
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".py",
  ].includes(ext);
}
