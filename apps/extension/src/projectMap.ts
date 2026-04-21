import * as vscode from "vscode";
import * as path from "node:path";
import { promisify } from "node:util";
import { exec as execCb } from "node:child_process";
import { createHash } from "node:crypto";
import type { ProjectMapData, ProjectMapFile } from "@protege/types";
import { aiQuery } from "./aiBackend.js";
import { log } from "./log.js";
import { getOwnership } from "./ownership.js";

/**
 * Project Map (A1) — builds the data the sidebar MAP tab renders.
 *
 * The map answers "what matters in this codebase?" using cheap signals:
 *   - file tree (vscode.workspace.findFiles, excluding common junk)
 *   - git log over the last 7 days (edit counts, per-author)
 *   - light entry-point heuristic (package.json main, activate(),
 *     app.listen, Next.js app/page.tsx)
 *
 * On-demand file summaries go through `aiQuery` with a tight prompt
 * and a cache keyed by file-hash so re-opening the same file doesn't
 * re-bill a Haiku call. The cache lives in `context.globalState` with
 * a 7-day TTL.
 *
 * None of this requires backend infrastructure. One git shell-out, one
 * file-tree scan, one cached LLM call per click. Safe if git is absent
 * (skips the edit-count signals, still shows the tree).
 */

const exec = promisify(execCb);

const GIT_SINCE = "7.days";
const HOT_FILE_LIMIT = 12;
const ENTRY_POINT_LIMIT = 6;
const UNTOUCHED_BY_ME_LIMIT = 8;
const MAX_FILES = 400;       // sanity cap for big monorepos
const SUMMARY_TTL_MS = 7 * 24 * 60 * 60_000;
const SUMMARY_LINES = 200;   // first N lines of a file sent to the model

const SUMMARY_CACHE_KEY = "protege.projectMap.summaryCache";
interface SummaryCacheEntry {
  summary: string;
  computedAt: number;
  fileHash: string;
}

// Languages considered "source code" for the map. Skip the rest to
// keep the tree focused on what the user is actually building.
const SOURCE_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".kt", ".kts",
  ".c", ".cc", ".cpp", ".h", ".hpp",
  ".cs", ".rb", ".php", ".swift", ".scala",
  ".vue", ".svelte",
  ".sh", ".bash", ".zsh",
]);

// Never include these path segments — too much noise.
const EXCLUDE_SEGMENTS = [
  "node_modules", "dist", "build", "out", ".next", ".turbo",
  ".cache", "coverage", ".git", ".vscode", ".idea",
  "__pycache__", ".venv", "venv",
  "target",             // Rust build
  ".nuxt", ".svelte-kit",
];

// ---- Public API ----

let moduleContext: vscode.ExtensionContext | null = null;

export function registerProjectMap(
  context: vscode.ExtensionContext
): vscode.Disposable[] {
  moduleContext = context;
  // No listeners/commands here — everything is request-response through
  // the webview message handlers in webviewHost.ts.
  return [];
}

/**
 * Collect the full project map. Called on `map/request` from the webview.
 * Safe to run repeatedly — no state mutation, caller should decide on
 * its own caching cadence.
 */
export async function collectProjectMap(): Promise<ProjectMapData> {
  const warnings: string[] = [];
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;

  if (!root) {
    return {
      root: null,
      files: [],
      hotFiles: [],
      entryPoints: [],
      untouchedByMe: [],
      computedAt: Date.now(),
      warnings: ["No workspace folder open."],
    };
  }

  const files = await listFiles(root);
  if (files.length === 0) {
    warnings.push("No source files found in this workspace.");
  }

  // Git-derived edit counts. If git isn't available, skip quietly.
  const gitAll = await gitEditCounts(root, GIT_SINCE);
  const myEmail = await gitUserEmail(root);
  const gitMine =
    myEmail && gitAll.ok
      ? await gitEditCounts(root, GIT_SINCE, myEmail)
      : { ok: false as const, counts: new Map<string, number>() };

  if (!gitAll.ok) warnings.push("git log unavailable — edit counts skipped.");
  else if (!myEmail) warnings.push("git user.email unset — 'edits by me' skipped.");

  // Merge file list + git signals + entry-point heuristic + ownership.
  // Ownership is a plain read from globalState — no IO, cheap to include
  // for every file. We only attach it when the state is not "untracked"
  // so the wire payload stays lean.
  const merged: ProjectMapFile[] = files.map((rel) => {
    const absUri = vscode.Uri.file(path.join(root, rel));
    const summary = getOwnership(absUri);
    return {
      path: rel,
      editsTotal: gitAll.counts.get(rel) ?? 0,
      editsByMe: gitMine.counts.get(rel) ?? 0,
      isEntryPoint: false,
      ownership: summary.state === "untracked" ? undefined : summary,
    };
  });

  // Entry-point detection. Run heuristics in order; first match wins.
  await markEntryPoints(root, merged);

  // Sort by team edit count (descending), ties broken by path.
  merged.sort(
    (a, b) => b.editsTotal - a.editsTotal || a.path.localeCompare(b.path)
  );

  const hotFiles = merged
    .filter((f) => f.editsTotal > 0)
    .slice(0, HOT_FILE_LIMIT);

  const entryPoints = merged
    .filter((f) => f.isEntryPoint)
    .slice(0, ENTRY_POINT_LIMIT);

  // "Untouched by me" = files with zero `editsByMe` that at least one
  // other person has edited (so truly dormant files don't drown out the
  // list). If git isn't available, fall back to "never opened in this
  // workspace session" — approximated as empty set; we'd need session
  // tracking otherwise. Better quiet than noisy.
  const untouchedByMe =
    gitAll.ok && myEmail
      ? merged
          .filter((f) => f.editsByMe === 0 && f.editsTotal > 0)
          .slice(0, UNTOUCHED_BY_ME_LIMIT)
      : [];

  return {
    root,
    files: merged,
    hotFiles,
    entryPoints,
    untouchedByMe,
    computedAt: Date.now(),
    warnings,
  };
}

/**
 * Fetch a 2-sentence summary of a file. Cached by file-hash for 7 days.
 * Returns null on failure (caller displays a retry prompt).
 */
export async function getFileSummary(
  relPath: string
): Promise<string | null> {
  if (!moduleContext) return null;
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return null;

  const absPath = path.join(root, relPath);
  let fileContent: string;
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(absPath));
    fileContent = doc.getText();
  } catch (err) {
    log(
      "projectMap",
      `summary open fail · ${relPath} — ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }

  const fileHash = sha1(fileContent);
  const cache = moduleContext.globalState.get<Record<string, SummaryCacheEntry>>(
    SUMMARY_CACHE_KEY
  ) ?? {};
  const cacheKey = relPath;
  const cached = cache[cacheKey];
  if (
    cached &&
    cached.fileHash === fileHash &&
    Date.now() - cached.computedAt < SUMMARY_TTL_MS
  ) {
    return cached.summary;
  }

  // First 200 lines are almost always enough to know what a file does.
  // Going deeper rarely improves summary quality and eats tokens.
  const lines = fileContent.split("\n");
  const preview = lines.slice(0, SUMMARY_LINES).join("\n");
  const lang = relPath.split(".").pop() ?? "";

  const prompt = `Summarize this ${lang} file for a developer who's new to the codebase.

Two sentences, plain English, under 55 words total:
Sentence 1: What this file DOES — its role in the project (not just "it's a TypeScript file").
Sentence 2: Key exports / entry points OR what other files typically touch it.

No preamble. No "This file...". Start with a verb or a noun. Be specific.

File: ${relPath}

\`\`\`${lang}
${preview}
\`\`\``;

  let reply: string | null = null;
  try {
    reply = await aiQuery(prompt, 180, { kind: "teach" });
  } catch (err) {
    log(
      "projectMap",
      `summary aiQuery fail · ${relPath} — ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
  if (!reply) return null;

  const cleaned = cleanSummary(reply);
  if (!cleaned) return null;

  cache[cacheKey] = {
    summary: cleaned,
    computedAt: Date.now(),
    fileHash,
  };
  // Prune cache entries older than TTL so it doesn't grow forever.
  const cutoff = Date.now() - SUMMARY_TTL_MS;
  for (const k of Object.keys(cache)) {
    if (cache[k]!.computedAt < cutoff) delete cache[k];
  }
  await moduleContext.globalState.update(SUMMARY_CACHE_KEY, cache);

  return cleaned;
}

/**
 * Open a file in the editor. Called when the user clicks the "Open"
 * button inside the MAP tab.
 */
export async function openMapFile(relPath: string): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return;
  const absPath = path.join(root, relPath);
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(absPath));
    await vscode.window.showTextDocument(doc, { preview: false });
  } catch (err) {
    log(
      "projectMap",
      `open file fail · ${relPath} — ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// ---- Internals ----

async function listFiles(root: string): Promise<string[]> {
  // Use a language-specific include glob so `findFiles` never has to
  // consider non-source files in the first place. Earlier bug: the
  // `**/*` include returned up to MAX_FILES results sorted arbitrarily,
  // then we filtered by extension AFTER — on a big repo with lots of
  // assets / lockfiles / generated data we could exhaust the cap
  // before hitting any source file. Language-specific include bakes
  // the filter into the walk.
  const exts = [...SOURCE_EXT].map((e) => e.slice(1)); // drop leading dot
  const include = `**/*.{${exts.join(",")}}`;
  const exclude = `{${EXCLUDE_SEGMENTS.map((s) => `**/${s}/**`).join(",")}}`;
  const files = await vscode.workspace.findFiles(include, exclude, MAX_FILES);
  const relPaths: string[] = [];
  for (const uri of files) {
    const abs = uri.fsPath;
    if (!abs.startsWith(root)) continue;
    const rel = path.relative(root, abs).split(path.sep).join("/");
    relPaths.push(rel);
  }
  return relPaths.sort();
}

interface GitCountResult {
  ok: boolean;
  counts: Map<string, number>;
}

async function gitEditCounts(
  root: string,
  since: string,
  author?: string
): Promise<GitCountResult> {
  const authorArg = author ? `--author=${shellEscape(author)}` : "";
  const cmd =
    `git -C ${shellEscape(root)} log --since=${since} --name-only --pretty=format: ${authorArg}`;
  try {
    const { stdout } = await exec(cmd, { maxBuffer: 16 * 1024 * 1024 });
    const counts = new Map<string, number>();
    for (const line of stdout.split("\n")) {
      const p = line.trim();
      if (!p) continue;
      counts.set(p, (counts.get(p) ?? 0) + 1);
    }
    return { ok: true, counts };
  } catch {
    return { ok: false, counts: new Map() };
  }
}

async function gitUserEmail(root: string): Promise<string | null> {
  try {
    const { stdout } = await exec(
      `git -C ${shellEscape(root)} config user.email`,
      { timeout: 3000 }
    );
    const email = stdout.trim();
    return email.length > 0 ? email : null;
  } catch {
    return null;
  }
}

/**
 * Entry-point heuristics, cheapest first:
 *   - package.json main/bin/module fields
 *   - known Next.js / Remix / Nuxt convention paths
 *   - VS Code extension: file containing `export function activate(`
 *   - Node HTTP server: file containing `.listen(` near module top
 * Mutates `files[].isEntryPoint = true` for matches.
 */
async function markEntryPoints(
  root: string,
  files: ProjectMapFile[]
): Promise<void> {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const mark = (p: string) => {
    const f = byPath.get(p);
    if (f) f.isEntryPoint = true;
  };

  // 1. package.json main/module/bin
  try {
    const pkgUri = vscode.Uri.file(path.join(root, "package.json"));
    const raw = await vscode.workspace.fs.readFile(pkgUri);
    const pkg = JSON.parse(new TextDecoder().decode(raw));
    const candidates: string[] = [];
    if (typeof pkg.main === "string") candidates.push(pkg.main);
    if (typeof pkg.module === "string") candidates.push(pkg.module);
    if (typeof pkg.bin === "string") candidates.push(pkg.bin);
    if (typeof pkg.bin === "object" && pkg.bin) {
      for (const v of Object.values(pkg.bin)) {
        if (typeof v === "string") candidates.push(v);
      }
    }
    for (const c of candidates) {
      const normalized = c.replace(/^\.\//, "");
      mark(normalized);
    }
  } catch {
    // No package.json or unreadable — skip.
  }

  // 2. Convention paths
  const conventionPaths = [
    "app/page.tsx", "app/page.jsx", "app/layout.tsx",         // Next.js app router
    "pages/_app.tsx", "pages/index.tsx",                      // Next.js pages
    "src/main.ts", "src/main.tsx", "src/index.ts",            // common starters
    "src/app.ts", "src/server.ts", "src/index.js",
    "app.py", "main.py", "manage.py",                          // Python
    "cmd/main.go",                                             // Go
  ];
  for (const p of conventionPaths) mark(p);

  // 3. VS Code extension activate + HTTP-server patterns.
  // Scan only files already in the tree (cheap).
  const ACTIVATE_RE = /export\s+(?:async\s+)?function\s+activate\s*\(/;
  const LISTEN_RE = /(app|server|fastify|serve|hono)\.(listen|serve)\s*\(/;
  const scanLimit = 40; // cap to avoid slow pass on big monorepos
  let scanned = 0;
  for (const f of files) {
    if (scanned >= scanLimit) break;
    if (f.isEntryPoint) continue;
    // Only scan plausible candidates — top-level src/backend/extension dirs.
    const lower = f.path.toLowerCase();
    if (
      !/^(src|apps?|backend|server|extension)\b/.test(lower) &&
      !/index\.(t|j)sx?$/.test(lower)
    ) {
      continue;
    }
    try {
      const uri = vscode.Uri.file(path.join(root, f.path));
      const buf = await vscode.workspace.fs.readFile(uri);
      const text = new TextDecoder().decode(buf.slice(0, 4_000));
      if (ACTIVATE_RE.test(text) || LISTEN_RE.test(text)) {
        f.isEntryPoint = true;
      }
      scanned++;
    } catch {
      // Skip unreadable files.
    }
  }
}

function cleanSummary(raw: string): string {
  return raw
    .trim()
    .replace(/<followups>[\s\S]*?<\/followups>/gi, "")
    .replace(/^```[a-zA-Z]*\n?/g, "")
    .replace(/```$/g, "")
    .replace(/^"(.+)"$/s, "$1")
    .trim();
}

function sha1(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}

function shellEscape(s: string): string {
  // Basic single-quote escape. Covers the paths + emails we pass. Not
  // suitable for arbitrary user input, but we only pass workspace
  // paths + user.email from git config.
  return `'${s.replace(/'/g, "'\\''")}'`;
}
