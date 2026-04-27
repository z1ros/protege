import * as vscode from "vscode";
import * as path from "node:path";
import { log } from "../log.js";

/**
 * "Protege: Find Similar" — selection hover action.
 *
 * Given a selection, finds other files in the workspace using a similar
 * pattern. The point isn't a literal text match — it's "show me other
 * places where this kind of thing is done", so the user can read parallel
 * implementations and learn idioms by comparison.
 *
 * Pipeline:
 *   1. Tokenise the selection: identifiers (length ≥ 4), method calls
 *      (`x.method(`), and a curated list of pattern keywords (`await`,
 *      `Promise.all`, `useEffect`, `try`, …). Drop language keywords
 *      and stopwords so we don't end up ranking by `const` or `return`.
 *   2. Pick the 3 most distinctive tokens (longest = rarest, roughly).
 *   3. Workspace scan via `vscode.workspace.findFiles`, capped at 600
 *      files. For each candidate, score = sum of token hits, with a
 *      bonus when ≥2 tokens co-occur on a single line (real pattern
 *      match, not coincidental name overlap).
 *   4. Show top N in a QuickPick: file:line + preview line. Picking an
 *      item opens the file at that line.
 *
 * No AI, no network. Works on every language since we tokenise with a
 * generic identifier regex.
 *
 * Logs go to the Protege output channel under tag "findSimilar".
 */

const MAX_FILES = 600;
const MAX_RESULTS = 12;
const MIN_IDENT_LEN = 4;
const SIGNATURE_TOKENS = 3;
const PREVIEW_MAX_CHARS = 140;

// Keep this list aggressive — anything common-enough to ruin scoring goes here.
// Mirrors the union of TS/JS/Python/Go/Rust keyword sets.
const STOPWORDS = new Set([
  "const", "let", "var", "function", "return", "import", "export",
  "from", "true", "false", "null", "undefined", "class", "extends",
  "implements", "interface", "type", "enum", "this", "self", "super",
  "new", "void", "any", "string", "number", "boolean", "object",
  "array", "promise", "async", "await", "yield", "throw", "throws",
  "if", "else", "for", "while", "do", "switch", "case", "break",
  "continue", "default", "try", "catch", "finally", "public", "private",
  "protected", "static", "readonly", "typeof", "instanceof", "delete",
  "in", "of", "as", "is", "with", "without", "true", "false",
  "console", "log", "error", "warn", "info", "debug", "data", "value",
  "result", "args", "props", "state", "name", "type", "kind", "key",
  "item", "items", "list", "map", "set", "get", "set", "true", "false",
  "then", "catch", "finally", "self", "node", "json", "text", "html",
  "func", "def", "lambda", "fn", "pub", "fn",
]);

// Short, distinctive multi-token patterns we explicitly look for. These
// score higher than plain identifiers because they encode an intent
// (concurrency, side effects, error handling) that a name alone won't.
const PATTERN_HINTS: Array<{ regex: RegExp; weight: number; label: string }> = [
  { regex: /Promise\.all\b/, weight: 5, label: "Promise.all" },
  { regex: /Promise\.allSettled\b/, weight: 5, label: "Promise.allSettled" },
  { regex: /useEffect\b/, weight: 4, label: "useEffect" },
  { regex: /useState\b/, weight: 3, label: "useState" },
  { regex: /useMemo\b/, weight: 4, label: "useMemo" },
  { regex: /useCallback\b/, weight: 4, label: "useCallback" },
  { regex: /\.map\s*\(\s*async\b/, weight: 5, label: ".map(async" },
  { regex: /\bfor\s+await\b/, weight: 5, label: "for await" },
  { regex: /\btry\s*\{/, weight: 2, label: "try" },
  { regex: /\.catch\s*\(/, weight: 3, label: ".catch(" },
  { regex: /\babort(?:Controller|Signal)\b/i, weight: 4, label: "abort" },
  { regex: /\bsetTimeout\b/, weight: 2, label: "setTimeout" },
  { regex: /\bsetInterval\b/, weight: 3, label: "setInterval" },
  { regex: /createHash\s*\(/, weight: 3, label: "createHash" },
  { regex: /JSON\.parse\b/, weight: 2, label: "JSON.parse" },
  { regex: /JSON\.stringify\b/, weight: 2, label: "JSON.stringify" },
  { regex: /\bfetch\s*\(/, weight: 3, label: "fetch(" },
  { regex: /vscode\.workspace\b/, weight: 2, label: "vscode.workspace" },
  { regex: /vscode\.window\b/, weight: 2, label: "vscode.window" },
];

interface Match {
  uri: vscode.Uri;
  line: number;
  preview: string;
  score: number;
  hits: string[];
}

export async function findSimilarCommand(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage("Protege: open a file first.");
    return;
  }

  const sel = editor.selection;
  if (sel.isEmpty) {
    vscode.window.showInformationMessage(
      "Protege: select some code first — a function call, an expression, a pattern."
    );
    return;
  }

  const text = editor.document.getText(sel);
  if (text.trim().length < 8) {
    vscode.window.showInformationMessage(
      "Protege: selection too short to find a meaningful pattern."
    );
    return;
  }

  const signature = buildSignature(text);
  if (signature.tokens.length === 0 && signature.patterns.length === 0) {
    vscode.window.showInformationMessage(
      "Protege: no distinctive tokens to search for — try selecting a function call or a multi-line expression."
    );
    return;
  }

  log(
    "findSimilar",
    `query · tokens=[${signature.tokens.join(",")}] patterns=[${signature.patterns.map((p) => p.label).join(",")}]`
  );

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: "Protege: scanning workspace…",
    },
    async () => {
      const matches = await scanWorkspace(signature, editor.document.uri);
      if (matches.length === 0) {
        vscode.window.showInformationMessage(
          "Protege: no similar code found in this workspace."
        );
        return;
      }
      await presentMatches(matches);
    }
  );
}

interface Signature {
  tokens: string[];        // regex-safe identifier strings
  patterns: typeof PATTERN_HINTS;
}

function buildSignature(text: string): Signature {
  // Strip string + comment content so identifiers inside literals don't
  // skew the distinctiveness ranking. Cheap pass — not perfect parsing.
  const stripped = text
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/`(?:\\.|[^`\\])*`/g, "``");

  const idents = new Map<string, number>();
  for (const m of stripped.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\b/g)) {
    const tok = m[1];
    if (tok.length < MIN_IDENT_LEN) continue;
    if (STOPWORDS.has(tok.toLowerCase())) continue;
    if (/^\d/.test(tok)) continue;
    idents.set(tok, (idents.get(tok) ?? 0) + 1);
  }

  // Rank: prefer tokens that appear multiple times in the selection
  // (they're load-bearing) and break ties by length (rarer in workspace).
  const ranked = [...idents.entries()]
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return b[0].length - a[0].length;
    })
    .slice(0, SIGNATURE_TOKENS)
    .map(([tok]) => tok);

  const patterns = PATTERN_HINTS.filter((p) => p.regex.test(stripped));

  return { tokens: ranked, patterns };
}

async function scanWorkspace(
  sig: Signature,
  origin: vscode.Uri
): Promise<Match[]> {
  // Source-ish files only — skip lockfiles, JSON, configs that bloat
  // the scan without surfacing teachable patterns.
  const include =
    "**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,kt,swift,rb,php,c,cc,cpp,h,hpp,cs,vue,svelte}";
  const exclude =
    "**/{node_modules,dist,build,out,.next,.nuxt,.git,coverage,target,vendor,__pycache__}/**";

  const uris = await vscode.workspace.findFiles(include, exclude, MAX_FILES);

  // Pre-build per-token regexes (escape since identifiers can contain $)
  const tokenRegexes = sig.tokens.map((t) => ({
    token: t,
    re: new RegExp(`\\b${escapeRegex(t)}\\b`, "g"),
  }));

  const matches: Match[] = [];

  // Read in parallel batches so a 600-file scan doesn't serialise on
  // disk I/O. Batch size keeps us well under the FD limit.
  const BATCH = 24;
  for (let i = 0; i < uris.length; i += BATCH) {
    const batch = uris.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map((uri) => scoreFile(uri, sig, tokenRegexes, origin))
    );
    for (const r of results) {
      if (r) matches.push(r);
    }
  }

  matches.sort((a, b) => b.score - a.score);
  return matches.slice(0, MAX_RESULTS);
}

async function scoreFile(
  uri: vscode.Uri,
  sig: Signature,
  tokenRegexes: Array<{ token: string; re: RegExp }>,
  origin: vscode.Uri
): Promise<Match | null> {
  if (uri.toString() === origin.toString()) return null;
  let buf: Uint8Array;
  try {
    buf = await vscode.workspace.fs.readFile(uri);
  } catch {
    return null;
  }
  const text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  if (text.length === 0 || text.length > 500_000) return null;

  // Total file score (cheap pre-filter) — if no token hit at all, bail
  // before splitting into lines.
  let totalScore = 0;
  const hitsForFile = new Set<string>();

  for (const { token, re } of tokenRegexes) {
    re.lastIndex = 0;
    let count = 0;
    while (re.exec(text) !== null) count++;
    if (count > 0) {
      totalScore += Math.min(count, 5); // cap so a token-spam file doesn't dominate
      hitsForFile.add(token);
    }
  }
  for (const p of sig.patterns) {
    if (p.regex.test(text)) {
      totalScore += p.weight;
      hitsForFile.add(p.label);
    }
  }

  if (totalScore === 0) return null;

  // Find the line with the most overlap — that's what we'll preview.
  const lines = text.split("\n");
  let bestLine = 0;
  let bestLineScore = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length === 0 || line.length > 400) continue;
    let score = 0;
    let tokensOnLine = 0;
    for (const { re } of tokenRegexes) {
      re.lastIndex = 0;
      if (re.test(line)) {
        score += 1;
        tokensOnLine++;
      }
    }
    for (const p of sig.patterns) {
      if (p.regex.test(line)) {
        score += p.weight;
        tokensOnLine++;
      }
    }
    // Co-occurrence bonus: a single line containing 2+ signature
    // pieces is strong evidence of a real pattern match, not just
    // accidental name reuse across the file.
    if (tokensOnLine >= 2) score += 4;
    if (score > bestLineScore) {
      bestLineScore = score;
      bestLine = i;
    }
  }

  return {
    uri,
    line: bestLine,
    preview: lines[bestLine]?.trim().slice(0, PREVIEW_MAX_CHARS) ?? "",
    score: totalScore + bestLineScore,
    hits: [...hitsForFile],
  };
}

async function presentMatches(matches: Match[]): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const items: Array<vscode.QuickPickItem & { match: Match }> = matches.map(
    (m) => {
      const rel = root
        ? path.relative(root, m.uri.fsPath).split(path.sep).join("/")
        : path.basename(m.uri.fsPath);
      return {
        label: `$(file-code) ${rel}:${m.line + 1}`,
        description: `score ${m.score} · ${m.hits.slice(0, 3).join(", ")}`,
        detail: m.preview,
        match: m,
      };
    }
  );

  const pick = await vscode.window.showQuickPick(items, {
    title: "Protege · Find Similar",
    placeHolder: "Pick a match to open the file at that line",
    matchOnDescription: true,
    matchOnDetail: true,
  });

  if (!pick) return;

  const doc = await vscode.workspace.openTextDocument(pick.match.uri);
  const editor = await vscode.window.showTextDocument(doc, {
    viewColumn: vscode.ViewColumn.Beside,
    preview: true,
  });
  const pos = new vscode.Position(pick.match.line, 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(
    new vscode.Range(pos, pos),
    vscode.TextEditorRevealType.InCenter
  );
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
