import * as vscode from "vscode";
import * as path from "node:path";
import { promisify } from "node:util";
import { execFile as execFileCb } from "node:child_process";
import { log } from "../log.js";

const execFile = promisify(execFileCb);

/**
 * "Protege: Why" — selection hover action.
 *
 * Surfaces the *intent* behind the selected lines using local git history
 * (and `gh` if installed). No AI calls — ground truth from the repo.
 *
 * Pipeline:
 *   1. `git blame -L startLine,endLine -- file` for the selection range,
 *      collect unique commit SHAs.
 *   2. Most-recent SHA → `git log -1 --format=%H%n%an%n%ar%n%s%n%b` for
 *      author, age, subject, body.
 *   3. Parse `(#NNN)` from subject → if `gh` is on PATH, fetch PR title
 *      + first ~30 lines of body.
 *   4. `git log --oneline --follow -- file` count → file age signal.
 *   5. Show as info notification with action buttons:
 *         [Open commit] [Open PR] [Show all touches]
 *
 * Failure modes are silent — if there's no git repo, no commit found,
 * gh missing, etc., we just skip that piece. The notification still
 * shows whatever we did get.
 *
 * Logs go to the Protege output channel under tag "why".
 */

const GIT_TIMEOUT_MS = 4000;
const GH_TIMEOUT_MS = 6000;
const PR_BODY_LINES = 12;

interface WhyResult {
  sha: string;
  shortSha: string;
  author: string;
  ageRel: string;
  subject: string;
  body: string;
  prNumber: number | null;
  prTitle: string | null;
  prBody: string | null;
  remoteUrl: string | null;
  fileTouches: number | null;
  uniqueCommitsInRange: number;
}

export async function whyCommand(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage("Protege: open a file first.");
    return;
  }

  if (editor.document.uri.scheme !== "file") {
    vscode.window.showInformationMessage(
      "Protege: Why only works on files saved to disk."
    );
    return;
  }

  const sel = editor.selection;
  // If nothing selected, fall back to the cursor line. Same UX as Explain.
  const startLine = sel.isEmpty ? sel.active.line : sel.start.line;
  const endLine = sel.isEmpty ? sel.active.line : sel.end.line;

  const filePath = editor.document.uri.fsPath;
  const cwd = path.dirname(filePath);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: "Protege: looking up history…",
    },
    async () => {
      try {
        const result = await runWhy(filePath, cwd, startLine + 1, endLine + 1);
        if (!result) {
          vscode.window.showInformationMessage(
            "Protege: no git history for this selection (uncommitted, ignored, or not in a repo)."
          );
          return;
        }
        await presentResult(result, editor.document.uri);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log("why", `failed — ${msg}`);
        vscode.window.showErrorMessage(`Protege Why failed: ${msg}`);
      }
    }
  );
}

async function runWhy(
  filePath: string,
  cwd: string,
  startLine1: number,
  endLine1: number
): Promise<WhyResult | null> {
  // Step 1 — blame the range. Porcelain output gives us SHA per line
  // even when neighbouring lines share a commit, which we collapse below.
  const blame = await git(
    cwd,
    [
      "blame",
      "-L",
      `${startLine1},${endLine1}`,
      "--porcelain",
      "--",
      filePath,
    ],
    GIT_TIMEOUT_MS
  );
  if (!blame) return null;

  const shaSet = new Set<string>();
  const shaOrder: string[] = [];
  for (const line of blame.split("\n")) {
    // Porcelain format: SHA appears at the start of a header line as
    // "<40-hex> <orig-line> <final-line> <num-lines?>". Skip the
    // "0000…" sentinel which marks not-yet-committed lines.
    const m = /^([0-9a-f]{40}) \d+ \d+/.exec(line);
    if (!m) continue;
    const sha = m[1];
    if (sha === "0".repeat(40)) continue;
    if (!shaSet.has(sha)) {
      shaSet.add(sha);
      shaOrder.push(sha);
    }
  }

  if (shaOrder.length === 0) return null;

  // Step 2 — most-recent commit metadata. `git log` over the SHAs
  // returns them in repo-history order, so the first entry is newest.
  const newest = await mostRecentSha(cwd, shaOrder);
  if (!newest) return null;

  const meta = await commitMeta(cwd, newest);
  if (!meta) return null;

  // Step 3 — PR linkage. Subjects like "feat: foo (#123)" or merge
  // commits like "Merge pull request #123 from …" both work.
  const prNumber = parsePrNumber(meta.subject) ?? parsePrNumber(meta.body);
  let prTitle: string | null = null;
  let prBody: string | null = null;
  if (prNumber !== null) {
    const pr = await fetchPr(cwd, prNumber);
    prTitle = pr?.title ?? null;
    prBody = pr?.body ?? null;
  }

  const remoteUrl = await getRemoteUrl(cwd);

  // Step 4 — file touch count. Cheap signal: hot vs stable file.
  const fileTouches = await fileTouchCount(cwd, filePath);

  return {
    sha: newest,
    shortSha: newest.slice(0, 7),
    author: meta.author,
    ageRel: meta.ageRel,
    subject: meta.subject,
    body: meta.body,
    prNumber,
    prTitle,
    prBody,
    remoteUrl,
    fileTouches,
    uniqueCommitsInRange: shaOrder.length,
  };
}

// ---- presentation ----

async function presentResult(
  r: WhyResult,
  uri: vscode.Uri
): Promise<void> {
  // Headline: most-recent commit subject + author + age. Keep it scannable.
  const headline = `${r.subject} — ${r.author}, ${r.ageRel}`;

  const actions: string[] = ["Show details"];
  if (r.remoteUrl && r.prNumber !== null) actions.push("Open PR");
  if (r.remoteUrl) actions.push("Open commit");

  const choice = await vscode.window.showInformationMessage(
    headline,
    ...actions
  );

  if (choice === "Show details") {
    await openDetailsDocument(r, uri);
  } else if (choice === "Open PR" && r.remoteUrl && r.prNumber !== null) {
    const url = prUrl(r.remoteUrl, r.prNumber);
    if (url) await vscode.env.openExternal(vscode.Uri.parse(url));
  } else if (choice === "Open commit" && r.remoteUrl) {
    const url = commitUrl(r.remoteUrl, r.sha);
    if (url) await vscode.env.openExternal(vscode.Uri.parse(url));
  }
}

async function openDetailsDocument(
  r: WhyResult,
  uri: vscode.Uri
): Promise<void> {
  const lines: string[] = [];
  lines.push(`# Why — ${path.basename(uri.fsPath)}`);
  lines.push("");
  lines.push(`**Last touched** · ${r.author} · ${r.ageRel} · \`${r.shortSha}\``);
  lines.push(`**Subject** · ${r.subject}`);
  if (r.uniqueCommitsInRange > 1) {
    lines.push(
      `**Selection touched by** · ${r.uniqueCommitsInRange} commits (showing newest)`
    );
  }
  if (r.fileTouches !== null) {
    const label =
      r.fileTouches >= 25
        ? "hot — frequently rewritten"
        : r.fileTouches >= 8
          ? "active"
          : "stable";
    lines.push(`**File churn** · ${r.fileTouches} commits (${label})`);
  }
  lines.push("");
  if (r.body.trim()) {
    lines.push("## Commit body");
    lines.push("");
    lines.push(r.body.trim());
    lines.push("");
  }
  if (r.prNumber !== null) {
    lines.push(`## PR #${r.prNumber}${r.prTitle ? ` — ${r.prTitle}` : ""}`);
    lines.push("");
    if (r.prBody) {
      lines.push(r.prBody);
    } else {
      lines.push(
        "_PR body unavailable — install GitHub CLI (`gh`) and run `gh auth login` to surface PR descriptions._"
      );
    }
  }
  const doc = await vscode.workspace.openTextDocument({
    content: lines.join("\n"),
    language: "markdown",
  });
  await vscode.window.showTextDocument(doc, {
    viewColumn: vscode.ViewColumn.Beside,
    preview: true,
  });
}

// ---- git helpers ----

async function git(
  cwd: string,
  args: string[],
  timeoutMs: number
): Promise<string | null> {
  try {
    const { stdout } = await execFile("git", args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    log("why", `git ${args[0]} failed — ${(err as Error).message}`);
    return null;
  }
}

async function mostRecentSha(
  cwd: string,
  shas: string[]
): Promise<string | null> {
  // `git log` with explicit SHAs sorts by commit date desc. We pass
  // them all and read the first one back.
  const out = await git(
    cwd,
    ["log", "--no-walk", "--format=%H", ...shas],
    GIT_TIMEOUT_MS
  );
  if (!out) return shas[0];
  const first = out.split("\n").find((s) => s.trim().length > 0);
  return first?.trim() ?? shas[0];
}

interface CommitMeta {
  author: string;
  ageRel: string;
  subject: string;
  body: string;
}

async function commitMeta(
  cwd: string,
  sha: string
): Promise<CommitMeta | null> {
  // Custom separator avoids quoting headaches when subjects contain colons.
  const sep = "<<<PROTEGE_SEP>>>";
  const out = await git(
    cwd,
    [
      "log",
      "-1",
      `--format=%an${sep}%ar${sep}%s${sep}%b`,
      sha,
    ],
    GIT_TIMEOUT_MS
  );
  if (!out) return null;
  const parts = out.split(sep);
  if (parts.length < 4) return null;
  return {
    author: parts[0].trim(),
    ageRel: parts[1].trim(),
    subject: parts[2].trim(),
    body: parts.slice(3).join(sep).trim(),
  };
}

async function fileTouchCount(
  cwd: string,
  filePath: string
): Promise<number | null> {
  const out = await git(
    cwd,
    ["log", "--follow", "--oneline", "--", filePath],
    GIT_TIMEOUT_MS
  );
  if (!out) return null;
  return out.split("\n").filter((l) => l.trim().length > 0).length;
}

async function getRemoteUrl(cwd: string): Promise<string | null> {
  const out = await git(
    cwd,
    ["config", "--get", "remote.origin.url"],
    GIT_TIMEOUT_MS
  );
  return out ? out.trim() : null;
}

function parsePrNumber(text: string): number | null {
  // Match `(#123)` (squash-merge convention) or `#123 ` standalone.
  const m =
    /\(#(\d+)\)/.exec(text) ??
    /pull request #(\d+)/i.exec(text) ??
    /(?:^|\s)#(\d+)\b/.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

async function fetchPr(
  cwd: string,
  prNumber: number
): Promise<{ title: string; body: string } | null> {
  // gh CLI is the cleanest path. If it's missing or the user isn't
  // authed we silently skip — Why still works without it.
  try {
    const { stdout } = await execFile(
      "gh",
      [
        "pr",
        "view",
        String(prNumber),
        "--json",
        "title,body",
      ],
      { cwd, timeout: GH_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }
    );
    const parsed = JSON.parse(stdout) as { title?: string; body?: string };
    const title = parsed.title?.trim() ?? "";
    const rawBody = parsed.body?.trim() ?? "";
    const trimmedBody = rawBody
      .split("\n")
      .slice(0, PR_BODY_LINES)
      .join("\n");
    const truncated = rawBody.split("\n").length > PR_BODY_LINES;
    return {
      title,
      body: truncated ? `${trimmedBody}\n\n_…(truncated)_` : trimmedBody,
    };
  } catch (err) {
    log("why", `gh pr view failed — ${(err as Error).message}`);
    return null;
  }
}

// ---- url builders ----

function prUrl(remoteUrl: string, prNumber: number): string | null {
  const base = githubBaseUrl(remoteUrl);
  return base ? `${base}/pull/${prNumber}` : null;
}

function commitUrl(remoteUrl: string, sha: string): string | null {
  const base = githubBaseUrl(remoteUrl);
  return base ? `${base}/commit/${sha}` : null;
}

function githubBaseUrl(remoteUrl: string): string | null {
  // Handles both `git@github.com:owner/repo.git` and
  // `https://github.com/owner/repo.git`. GitLab/Bitbucket: skip — we'd
  // need different path conventions, not worth the complexity for v1.
  const ssh = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/.exec(remoteUrl);
  if (ssh) return `https://github.com/${ssh[1]}/${ssh[2]}`;
  const https = /^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/.exec(
    remoteUrl
  );
  if (https) return `https://github.com/${https[1]}/${https[2]}`;
  return null;
}
