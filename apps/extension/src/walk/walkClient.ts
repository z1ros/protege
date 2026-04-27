import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import type {
  WalkRequest,
  WalkResponse,
  WalkImportExcerpt,
  WalkRepoSummary,
  WalkQuotaError,
} from "@protege/types";
import { authedFetch, BACKEND_URL, requireUserId } from "../user/protegeClient.js";
import { log } from "../log.js";

const MAX_FILE_BYTES = 50_000;
const MAX_IMPORTS = 5;
const MAX_IMPORT_LINES = 80;
const MAX_IMPORT_BYTES = 6_000;

export class WalkQuotaExceededError extends Error {
  used: number;
  limit: number;
  resetAt: number;
  constructor(q: WalkQuotaError) {
    super(`Daily walk quota exceeded (${q.used}/${q.limit}).`);
    this.name = "WalkQuotaExceededError";
    this.used = q.used;
    this.limit = q.limit;
    this.resetAt = q.resetAt;
  }
}

export interface FetchWalkArgs {
  document: vscode.TextDocument;
  repoSummary?: WalkRepoSummary;
}

export async function fetchWalk(args: FetchWalkArgs): Promise<WalkResponse> {
  const userId = requireUserId();
  const content = args.document.getText();
  if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
    throw new Error(
      `File too large for walk (${Buffer.byteLength(content, "utf8")} > ${MAX_FILE_BYTES} bytes).`
    );
  }
  const imports = await collectImportExcerpts(args.document);

  const body: WalkRequest = {
    userId,
    file: {
      path: args.document.uri.fsPath,
      language: args.document.languageId,
      content,
    },
    imports,
    repoSummary: args.repoSummary,
  };

  const res = await authedFetch(`${BACKEND_URL}/walk`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (res.status === 429) {
    const quota = (await res.json()) as WalkQuotaError;
    throw new WalkQuotaExceededError(quota);
  }
  if (!res.ok) {
    throw new Error(`walk HTTP ${res.status}`);
  }
  const data = (await res.json()) as WalkResponse;
  log("walk", `fetched ${data.steps.length} steps · cached=${data.cached}`);
  return data;
}

const IMPORT_PATTERNS: RegExp[] = [
  // ES modules: import x from "./y" / import "./y"
  /^\s*import\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/gm,
  // CommonJS: require("./y")
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  // Python: from .y import / from .y.z import
  /^\s*from\s+([.\w][.\w]*)\s+import\b/gm,
];

const ALLOWED_EXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
]);

async function collectImportExcerpts(
  doc: vscode.TextDocument
): Promise<WalkImportExcerpt[]> {
  const out: WalkImportExcerpt[] = [];
  const text = doc.getText();
  const fromPath = doc.uri.fsPath;
  const fromDir = path.dirname(fromPath);
  const seen = new Set<string>();
  let totalBytes = 0;

  const candidates: string[] = [];
  for (const re of IMPORT_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      candidates.push(m[1]);
      if (candidates.length > 40) break;
    }
  }

  for (const spec of candidates) {
    if (out.length >= MAX_IMPORTS) break;
    if (totalBytes >= MAX_IMPORT_BYTES) break;
    if (!isLocalSpec(spec)) continue;
    const resolved = await resolveLocal(fromDir, spec);
    if (!resolved) continue;
    if (seen.has(resolved)) continue;
    seen.add(resolved);

    let raw: string;
    try {
      raw = await fs.readFile(resolved, "utf8");
    } catch {
      continue;
    }
    const lines = raw.split("\n").slice(0, MAX_IMPORT_LINES).join("\n");
    const remainingBudget = MAX_IMPORT_BYTES - totalBytes;
    const trimmed = lines.slice(0, remainingBudget);
    totalBytes += Buffer.byteLength(trimmed, "utf8");

    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const rel = root && resolved.startsWith(root)
      ? resolved.slice(root.length + 1)
      : path.basename(resolved);
    out.push({ path: rel.split(path.sep).join("/"), excerpt: trimmed });
  }

  return out;
}

function isLocalSpec(spec: string): boolean {
  // Ignore bare module specifiers — we only care about local files where
  // the user can navigate the source.
  if (spec.startsWith(".") || spec.startsWith("/")) return true;
  // Python: relative imports start with "." too. Plain `import os` etc. → skip.
  return false;
}

async function resolveLocal(fromDir: string, spec: string): Promise<string | null> {
  // Python relative module like ".foo.bar" → ./foo/bar.py
  const looksPython = /^\.+[a-zA-Z_]/.test(spec) && !spec.includes("/");
  let base: string;
  if (looksPython) {
    const dots = spec.match(/^\.+/)?.[0].length ?? 1;
    const rest = spec.slice(dots).replace(/\./g, "/");
    let parent = fromDir;
    for (let i = 1; i < dots; i++) parent = path.dirname(parent);
    base = path.join(parent, rest);
  } else {
    base = path.resolve(fromDir, spec);
  }

  const ext = path.extname(base);
  const candidates: string[] = [];
  if (ext && ALLOWED_EXT.has(ext)) {
    candidates.push(base);
  } else {
    for (const e of ALLOWED_EXT) candidates.push(base + e);
    for (const e of ALLOWED_EXT) candidates.push(path.join(base, "index" + e));
    for (const e of ALLOWED_EXT) candidates.push(path.join(base, "__init__" + e));
  }
  for (const c of candidates) {
    try {
      const stat = await fs.stat(c);
      if (stat.isFile()) return c;
    } catch {
      /* keep trying */
    }
  }
  return null;
}
