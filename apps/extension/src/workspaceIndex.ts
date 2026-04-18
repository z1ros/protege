import * as vscode from "vscode";
import * as path from "node:path";

/**
 * Workspace Index — a lazy, cheap import graph for the current project.
 *
 * This is the substrate every higher-tier scan sits on. Without it, the
 * SAVE and IDLE scanners would be blind to anything outside the active
 * file. With it, we can answer two questions at microsecond latency:
 *
 *   1. What files does this file import?  (direct dependencies)
 *   2. Who imports this file?              (reverse dependencies)
 *
 * The index is built with regex — not a full AST — on purpose. It's wrong
 * ~2% of the time (dynamic `require`, string-concat paths) and fast the
 * other 98%. Higher tiers validate hits with the actual file contents, so
 * a noisy index never produces a bad suggestion.
 *
 * Rebuilds on:
 *   - extension activation (one pass, idle)
 *   - file save (single-file refresh)
 *   - file create / delete / rename (targeted refresh)
 */

interface FileNode {
  /** Files this node imports — absolute fs paths. */
  imports: string[];
  /** Files that import this node — absolute fs paths. */
  importedBy: Set<string>;
  /** Unix epoch ms of last index. */
  indexedAt: number;
}

const SUPPORTED = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
]);

const MAX_INDEX_FILES = 2_000; // safety cap
const MAX_FILE_BYTES = 200_000;

const graph = new Map<string, FileNode>();
let rootWarmed = false;
let warmingPromise: Promise<void> | null = null;

// ---- Public API ----

export function workspaceIndexReady(): boolean {
  return rootWarmed;
}

export async function ensureWorkspaceIndex(): Promise<void> {
  if (rootWarmed) return;
  if (warmingPromise) return warmingPromise;
  warmingPromise = warmFromWorkspace().finally(() => {
    rootWarmed = true;
    warmingPromise = null;
  });
  return warmingPromise;
}

/** Files imported by `uri`, resolved to absolute paths. */
export function getImports(uri: vscode.Uri): string[] {
  const node = graph.get(uri.fsPath);
  return node ? [...node.imports] : [];
}

/** Files that import `uri`. */
export function getImporters(uri: vscode.Uri): string[] {
  const node = graph.get(uri.fsPath);
  return node ? [...node.importedBy] : [];
}

/**
 * 1-hop neighbors of a file — its imports plus its importers. Most block-
 * and flow-scope findings live within this neighborhood.
 */
export function getNeighbors(uri: vscode.Uri, limit = 12): string[] {
  const out = new Set<string>();
  for (const p of getImports(uri)) out.add(p);
  for (const p of getImporters(uri)) out.add(p);
  return [...out].slice(0, limit);
}

/** Re-index a single file. Cheap. */
export async function reindexFile(uri: vscode.Uri): Promise<void> {
  if (!isIndexable(uri.fsPath)) return;
  try {
    const buf = await vscode.workspace.fs.readFile(uri);
    if (buf.byteLength > MAX_FILE_BYTES) return;
    const text = new TextDecoder().decode(buf);
    updateNodeFromSource(uri.fsPath, text);
  } catch {
    // File may have been deleted between save + read. Swallow.
  }
}

/** Drop a file from the index (e.g. on delete). */
export function forgetFile(uri: vscode.Uri): void {
  const fsPath = uri.fsPath;
  const node = graph.get(fsPath);
  if (!node) return;
  // Clean up reverse edges.
  for (const importedFs of node.imports) {
    const target = graph.get(importedFs);
    if (target) target.importedBy.delete(fsPath);
  }
  // Clean up forward edges from importers (they'll re-scan lazily).
  for (const importerFs of node.importedBy) {
    const target = graph.get(importerFs);
    if (target) target.imports = target.imports.filter((p) => p !== fsPath);
  }
  graph.delete(fsPath);
}

export function debug_dump(): unknown {
  return {
    size: graph.size,
    sample: [...graph.entries()].slice(0, 5).map(([k, v]) => ({
      path: k,
      imports: v.imports.length,
      importedBy: v.importedBy.size,
    })),
  };
}

// ---- Disposable registration ----

export function registerWorkspaceIndex(
  context: vscode.ExtensionContext
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  // Kick off the initial warm in the background. Never blocks activation.
  setTimeout(() => {
    ensureWorkspaceIndex().catch((err) =>
      console.warn("[protege] workspaceIndex warm failed:", err)
    );
  }, 1000);

  // Keep the index fresh on save / create / delete.
  disposables.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      void reindexFile(doc.uri);
    }),
    vscode.workspace.onDidCreateFiles((e) => {
      for (const uri of e.files) void reindexFile(uri);
    }),
    vscode.workspace.onDidDeleteFiles((e) => {
      for (const uri of e.files) forgetFile(uri);
    }),
    vscode.workspace.onDidRenameFiles((e) => {
      for (const { oldUri, newUri } of e.files) {
        forgetFile(oldUri);
        void reindexFile(newUri);
      }
    })
  );

  // Cleanup.
  disposables.push(
    new vscode.Disposable(() => {
      graph.clear();
      rootWarmed = false;
    })
  );

  void context;
  return disposables;
}

// ---- Internals ----

async function warmFromWorkspace(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return;

  // One cheap glob across supported extensions, excluding common noise.
  const pattern = "**/*.{ts,tsx,js,jsx,mjs,cjs,py}";
  const excludes = "**/{node_modules,.git,dist,build,out,coverage,.next,.turbo,.vercel,__pycache__}/**";

  const files = await vscode.workspace.findFiles(
    pattern,
    excludes,
    MAX_INDEX_FILES
  );

  // Index in chunks so the UI stays responsive.
  const CHUNK = 50;
  for (let i = 0; i < files.length; i += CHUNK) {
    const slice = files.slice(i, i + CHUNK);
    await Promise.all(slice.map((uri) => reindexFile(uri)));
    // Yield the event loop.
    await new Promise((r) => setTimeout(r, 0));
  }
}

function isIndexable(fsPath: string): boolean {
  const ext = path.extname(fsPath).toLowerCase();
  return SUPPORTED.has(ext);
}

function updateNodeFromSource(fsPath: string, source: string): void {
  const parsed = parseImports(fsPath, source);

  const existing = graph.get(fsPath);
  const previousImports = existing ? existing.imports : [];

  // Remove reverse edges for imports that disappeared.
  for (const oldImport of previousImports) {
    if (!parsed.includes(oldImport)) {
      const target = graph.get(oldImport);
      if (target) target.importedBy.delete(fsPath);
    }
  }

  // Add reverse edges for new imports.
  for (const newImport of parsed) {
    if (!previousImports.includes(newImport)) {
      let target = graph.get(newImport);
      if (!target) {
        target = {
          imports: [],
          importedBy: new Set<string>(),
          indexedAt: 0,
        };
        graph.set(newImport, target);
      }
      target.importedBy.add(fsPath);
    }
  }

  graph.set(fsPath, {
    imports: parsed,
    importedBy: existing?.importedBy ?? new Set<string>(),
    indexedAt: Date.now(),
  });
}

// ---- Import parsing (regex-based, deliberately cheap) ----

const JS_IMPORT_RE = /(?:import\s+(?:[\w*{},\s]+)\s+from\s+|import\s+|require\s*\()\s*["']([^"']+)["']\)?/g;
const PY_IMPORT_RE = /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm;

function parseImports(fromFs: string, source: string): string[] {
  const ext = path.extname(fromFs).toLowerCase();
  const fromDir = path.dirname(fromFs);
  const out: string[] = [];

  if (ext === ".py") {
    let m: RegExpExecArray | null;
    const re = new RegExp(PY_IMPORT_RE);
    while ((m = re.exec(source)) !== null) {
      const mod = (m[1] ?? m[2] ?? "").trim();
      if (!mod) continue;
      const resolved = resolvePythonImport(fromDir, mod);
      if (resolved) out.push(resolved);
    }
    return dedup(out);
  }

  // JS/TS: regex-match the `from "..."` / require("...") specifier.
  const re = new RegExp(JS_IMPORT_RE);
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const spec = m[1];
    if (!spec) continue;
    // Skip bare package imports — we only care about in-workspace edges.
    if (!spec.startsWith(".") && !spec.startsWith("/")) continue;

    const resolved = resolveJsImport(fromDir, spec);
    if (resolved) out.push(resolved);
  }

  return dedup(out);
}

function resolveJsImport(fromDir: string, spec: string): string | undefined {
  const basePath = path.isAbsolute(spec) ? spec : path.resolve(fromDir, spec);
  // Try direct extensions.
  const candidates = [
    basePath,
    ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].map((e) => basePath + e),
    // index files
    ...[".ts", ".tsx", ".js", ".jsx"].map((e) => path.join(basePath, "index" + e)),
  ];
  for (const c of candidates) {
    if (graph.has(c)) return c;
    // Not in graph yet? Trust it exists if extension matches known set. We
    // don't stat from here to stay cheap; lazy resolution picks up later.
    const ext = path.extname(c).toLowerCase();
    if (SUPPORTED.has(ext)) return c;
  }
  return undefined;
}

function resolvePythonImport(fromDir: string, mod: string): string | undefined {
  const parts = mod.split(".");
  const basePath = path.resolve(fromDir, ...parts);
  const candidates = [basePath + ".py", path.join(basePath, "__init__.py")];
  for (const c of candidates) {
    if (graph.has(c)) return c;
    return c; // optimistic — we fix up on next save
  }
  return undefined;
}

function dedup(xs: string[]): string[] {
  return Array.from(new Set(xs));
}
