import * as path from "node:path";
import * as vscode from "vscode";
import { authHeaders } from "../user/auth.js";
import { BACKEND_URL } from "../user/protegeClient.js";
import { detectHybrid } from "../concepts/hybridDetector.js";

/**
 * Rv5.B — workspace concept scanner.
 *
 * One-shot scan of the current workspace's source files. For each file
 * we run the regex-only concept detector (AI layer off for speed and
 * determinism) and stream per-file batches to `/echo/repo-scan`, which
 * populates `RepoConceptIndex` for W17.
 *
 * Guardrails:
 *   - 2000-file cap (matches `findFiles`'s `maxResults`)
 *   - per-file size cap 2 MB
 *   - binary heuristic (NUL bytes / non-printable ratio in first 1 KB)
 *   - 60 s wall-clock timeout — marks the scan `truncated` if exceeded
 *   - 20-file chunks with `setImmediate` yielding so the editor never
 *     freezes
 *   - idempotent via `globalState["protege.echo.scannedWorkspaces"]`:
 *     same workspace won't re-scan unless `force` is set
 *   - exponential backoff on backend 429 (start 5 s, cap 60 s)
 */

const SCANNED_WORKSPACES_KEY = "protege.echo.scannedWorkspaces";
const FILE_CAP = 2000;
const SIZE_CAP_BYTES = 2 * 1024 * 1024;
const CHUNK_SIZE = 20;
const BATCH_POST_SIZE = 50;
const WALL_CLOCK_LIMIT_MS = 60_000;
const BINARY_SAMPLE_BYTES = 1024;

// Shared excludes glob (kept in sync with the plan — update both together).
const INCLUDE_GLOB =
  "**/*.{ts,tsx,js,jsx,py,rs,go,java,rb,cpp,cc,h,hpp,cs,php,swift,kt,scala,html,css,scss,json,yml,yaml,md,sh}";
const EXCLUDE_GLOB =
  "{**/node_modules/**,**/dist/**,**/build/**,**/.git/**,**/out/**,**/.next/**,**/.cache/**,**/*.lock,**/*.min.js,**/*.bundle.js,**/*.map,**/*.png,**/*.jpg,**/*.gif,**/*.svg,**/*.webp,**/*.woff,**/*.woff2,**/*.ttf,**/*.eot,**/*.ico,**/*.pdf,**/*.zip,**/*.tar,**/*.gz}";

/** Map file extension → VS Code-style language id. Matches the server
 *  allow-list (see `sanitizeLanguage`). Anything not in the table falls
 *  back to `null`. */
const EXT_TO_LANG: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".rb": "ruby",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".h": "c",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".php": "php",
  ".swift": "swift",
  ".kt": "kotlin",
  ".scala": "scala",
  ".html": "html",
  ".css": "css",
  ".scss": "scss",
  ".json": "json",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".md": "markdown",
  ".sh": "shellscript",
};

function languageForFile(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  return EXT_TO_LANG[ext] ?? null;
}

export interface ScanOptions {
  force?: boolean;
  userId?: string;
  onStatus?: (info: {
    state: "scanning" | "done" | "truncated";
    scannedFiles: number;
    totalCandidates: number;
    finishedAt?: string;
  }) => void;
}

export interface ScanResult {
  workspaceRoot: string;
  scannedFiles: number;
  totalCandidates: number;
  truncated: boolean;
  startedAt: string;
  finishedAt: string;
}

interface RepoScanBatch {
  file: string;
  language: string | null;
  concepts: string[];
}

/** Quick heuristic for binary-ish content. Sample the first 1 KB of a
 *  buffer: if any NUL byte or > 30 % non-printable characters appear,
 *  treat as binary and skip. Cheaper than a full charset sniff and
 *  good enough for the scanner's "source code only" contract. */
function looksBinary(buf: Uint8Array): boolean {
  const sample = buf.length > BINARY_SAMPLE_BYTES ? buf.subarray(0, BINARY_SAMPLE_BYTES) : buf;
  if (sample.length === 0) return true;
  let nonPrintable = 0;
  for (let i = 0; i < sample.length; i++) {
    const b = sample[i];
    if (b === 0x00) return true;
    // Printable ASCII + common whitespace (tab, LF, CR) are "printable".
    const printable =
      b === 0x09 ||
      b === 0x0a ||
      b === 0x0d ||
      (b >= 0x20 && b <= 0x7e) ||
      b >= 0x80; // UTF-8 continuation / multibyte — assume text
    if (!printable) nonPrintable += 1;
  }
  return nonPrintable / sample.length > 0.3;
}

function getScannedWorkspaces(context: vscode.ExtensionContext): string[] {
  const stored = context.globalState.get<string[]>(SCANNED_WORKSPACES_KEY, []);
  return Array.isArray(stored) ? stored.filter((s) => typeof s === "string") : [];
}

async function setScannedWorkspaces(
  context: vscode.ExtensionContext,
  next: string[]
): Promise<void> {
  try {
    await context.globalState.update(SCANNED_WORKSPACES_KEY, next);
  } catch {
    // globalState write failures are non-fatal — next open retries.
  }
}

export async function markWorkspaceScanned(
  context: vscode.ExtensionContext,
  workspaceRoot: string
): Promise<void> {
  const current = getScannedWorkspaces(context);
  if (current.includes(workspaceRoot)) return;
  await setScannedWorkspaces(context, [...current, workspaceRoot]);
}

export async function clearScannedWorkspace(
  context: vscode.ExtensionContext,
  workspaceRoot: string
): Promise<void> {
  const current = getScannedWorkspaces(context);
  await setScannedWorkspaces(
    context,
    current.filter((w) => w !== workspaceRoot)
  );
}

export function isWorkspaceScanned(
  context: vscode.ExtensionContext,
  workspaceRoot: string
): boolean {
  return getScannedWorkspaces(context).includes(workspaceRoot);
}

export function currentWorkspaceRoot(): string | null {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return null;
  return folder.uri.fsPath;
}

async function postBatch(
  userId: string,
  workspaceRoot: string,
  batches: RepoScanBatch[]
): Promise<void> {
  if (batches.length === 0) return;
  let delayMs = 5_000;
  const maxDelayMs = 60_000;
  // Retry only on 429; any other failure is swallowed (the scan is
  // best-effort — partial data is better than blocking for minutes).
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(`${BACKEND_URL}/echo/repo-scan`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...authHeaders(userId),
        },
        body: JSON.stringify({ userId, workspaceRoot, batches }),
      });
      if (res.ok) return;
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, delayMs));
        delayMs = Math.min(delayMs * 2, maxDelayMs);
        continue;
      }
      // Non-retryable error; log once and move on.
      console.warn(`[echo/scan] repo-scan POST HTTP ${res.status}`);
      return;
    } catch (err) {
      console.warn("[echo/scan] repo-scan POST threw:", err);
      return;
    }
  }
}

/**
 * Scan the active workspace root for concepts. Returns `null` when there
 * is no workspace or when the cache says we've already scanned and
 * `options.force` is false. Otherwise drives a full scan and returns a
 * `ScanResult`.
 */
export async function scanWorkspace(
  context: vscode.ExtensionContext,
  options: ScanOptions = {}
): Promise<ScanResult | null> {
  const workspaceRoot = currentWorkspaceRoot();
  if (!workspaceRoot) return null;

  if (!options.force && isWorkspaceScanned(context, workspaceRoot)) {
    return null;
  }

  const userId = options.userId ?? "local-dev";
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const startMarker: ScanResult["startedAt"] = startedAt;

  let truncated = false;
  let scannedFiles = 0;

  options.onStatus?.({
    state: "scanning",
    scannedFiles: 0,
    totalCandidates: 0,
  });

  // `findFiles` respects .gitignore by default and stops at maxResults.
  // We grab one extra so we can tell whether `findFiles` hit the cap
  // and surface `truncated` to the caller.
  const uris = await vscode.workspace.findFiles(
    INCLUDE_GLOB,
    EXCLUDE_GLOB,
    FILE_CAP
  );
  const totalCandidates = uris.length;
  if (uris.length === FILE_CAP) {
    // We don't actually know how many more there are — `findFiles` never
    // reports beyond `maxResults`. Treating a full cap as "truncated" is
    // the best honest signal we can give W17.
    truncated = true;
  }

  const buffer: RepoScanBatch[] = [];
  const flushIfFull = async () => {
    while (buffer.length >= BATCH_POST_SIZE) {
      const chunk = buffer.splice(0, BATCH_POST_SIZE);
      await postBatch(userId, workspaceRoot, chunk);
    }
  };

  for (let i = 0; i < uris.length; i += CHUNK_SIZE) {
    if (Date.now() - startMs > WALL_CLOCK_LIMIT_MS) {
      truncated = true;
      break;
    }
    const chunkUris = uris.slice(i, i + CHUNK_SIZE);
    for (const uri of chunkUris) {
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size === 0 || stat.size > SIZE_CAP_BYTES) continue;
        const raw = await vscode.workspace.fs.readFile(uri);
        if (looksBinary(raw)) continue;
        const text = Buffer.from(raw).toString("utf-8");
        if (text.length === 0) continue;
        const filePath = uri.fsPath;
        // Safety: server-side validator also checks, but we pre-filter
        // obviously broken paths so we don't waste an HTTP round-trip.
        if (!filePath.startsWith(workspaceRoot)) continue;
        const language = languageForFile(filePath);
        // Hybrid detector with AI disabled — AST path is dead for
        // non-JS/TS files but the regex layer still runs, which is the
        // contract: regex-only mode for the scanner.
        const detection = await detectHybrid(
          text,
          filePath,
          language ?? "plaintext",
          "",
          false
        );
        if (detection.concepts.length === 0) continue;
        const concepts = detection.concepts.map((c) => c.name);
        buffer.push({ file: filePath, language, concepts });
        scannedFiles += 1;
      } catch (err) {
        // One bad file doesn't kill the scan.
        console.warn("[echo/scan] per-file failure:", err);
      }
    }
    await flushIfFull();
    // Yield so the editor thread stays responsive.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  // Final flush of whatever didn't fill a batch.
  while (buffer.length > 0) {
    const chunk = buffer.splice(0, BATCH_POST_SIZE);
    await postBatch(userId, workspaceRoot, chunk);
  }

  const finishedAt = new Date().toISOString();
  if (!truncated) {
    await markWorkspaceScanned(context, workspaceRoot);
  }

  const result: ScanResult = {
    workspaceRoot,
    scannedFiles,
    totalCandidates,
    truncated,
    startedAt: startMarker,
    finishedAt,
  };

  options.onStatus?.({
    state: truncated ? "truncated" : "done",
    scannedFiles,
    totalCandidates,
    finishedAt,
  });

  return result;
}
