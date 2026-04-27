import * as vscode from "vscode";
import { aiQuery } from "../ai/aiBackend.js";
import { log, logBlock } from "../log.js";

/**
 * "Protege: Compare" — selection hover action.
 *
 * Asks the AI for a senior-style rewrite of the selection and shows it
 * in a side-by-side diff. The teaching angle is "what would a more
 * experienced engineer write here, and why?" — so the response is
 * structured (rewrite + 1-3 brief reasons) rather than a wall of
 * commentary.
 *
 * Pipeline:
 *   1. Take the selection (or current line if empty), grab language.
 *   2. Strict JSON-out prompt asking for `rewrite` + `reasons[]` +
 *      optional `tradeoffs`. Premium tier — this is a teach call,
 *      not a scan.
 *   3. Open a read-only diff via TextDocumentContentProvider:
 *        left   = original
 *        right  = rewrite
 *      `vscode.diff` gives the user navigation, copy, and inline
 *      decoration for free.
 *   4. Show reasoning in a notification with three buttons:
 *        [Apply rewrite] · [Show reasoning] · [Dismiss]
 *      Apply replaces the original selection with the rewrite. Show
 *      reasoning opens a markdown doc with the structured response.
 *
 * Read-only is enforced through the content scheme — neither side is
 * an editable buffer, so the user can't accidentally save junk.
 *
 * Logs go to the Protege output channel under tag "compare".
 */

const COMPARE_SCHEME = "protege-compare";
const MAX_INPUT_CHARS = 2400;
const COMPARE_MAX_TOKENS = 800;

interface CompareResult {
  rewrite: string;
  reasons: string[];
  tradeoffs?: string;
}

interface ActiveDiff {
  original: string;
  rewrite: string;
  language: string;
}

const activeDiffs = new Map<string, ActiveDiff>();
let providerRegistered = false;
let provider: CompareContentProvider | null = null;

class CompareContentProvider implements vscode.TextDocumentContentProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    // URI shape: protege-compare:/<sessionId>/<side>.<ext>
    // The trailing extension preserves syntax highlighting in the diff
    // editor (e.g. `.ts` lights up the TypeScript grammar).
    const segments = uri.path.split("/").filter(Boolean);
    const sessionId = segments[0];
    const side = segments[1]?.split(".")[0]; // "original" | "rewrite"
    const session = activeDiffs.get(sessionId);
    if (!session) return "";
    return side === "rewrite" ? session.rewrite : session.original;
  }
}

export function registerCompareProvider(
  _context: vscode.ExtensionContext
): vscode.Disposable[] {
  if (providerRegistered) return [];
  provider = new CompareContentProvider();
  providerRegistered = true;
  return [
    vscode.workspace.registerTextDocumentContentProvider(
      COMPARE_SCHEME,
      provider
    ),
  ];
}

export async function compareCommand(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage("Protege: open a file first.");
    return;
  }

  const sel = editor.selection;
  const range = sel.isEmpty
    ? editor.document.lineAt(sel.active.line).range
    : new vscode.Range(sel.start, sel.end);
  const original = editor.document.getText(range);

  if (original.trim().length < 8) {
    vscode.window.showInformationMessage(
      "Protege: select some code first — a function, an expression, anything substantive."
    );
    return;
  }

  if (original.length > MAX_INPUT_CHARS) {
    vscode.window.showInformationMessage(
      `Protege: selection too large (${original.length} chars > ${MAX_INPUT_CHARS}). Compare works best on a function or block at a time.`
    );
    return;
  }

  const language = editor.document.languageId;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Protege: drafting a senior-style rewrite…",
      cancellable: false,
    },
    async () => {
      try {
        const result = await fetchCompare(original, language);
        if (!result) {
          vscode.window.showWarningMessage(
            "Protege: couldn't get a rewrite — the AI returned an unparseable response."
          );
          return;
        }
        await presentDiff(result, original, language, editor, range);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log("compare", `failed — ${msg}`);
        vscode.window.showErrorMessage(`Protege Compare failed: ${msg}`);
      }
    }
  );
}

async function fetchCompare(
  code: string,
  language: string
): Promise<CompareResult | null> {
  const prompt = buildPrompt(code, language);
  const reply = await aiQuery(prompt, COMPARE_MAX_TOKENS, { kind: "teach" });
  if (!reply) return null;
  logBlock("compare", "raw response", reply);
  return parseResponse(reply);
}

function buildPrompt(code: string, language: string): string {
  return `You are a senior engineer reviewing a teammate's code. Rewrite the snippet below to match how an experienced engineer would write it.

Rules:
- Keep behaviour identical. No new features, no extra parameters.
- Prefer idiomatic ${language}. Use standard library, modern syntax.
- Improve clarity, safety, performance — in that priority order.
- If the code is already idiomatic, say so in reasons[0] and return it unchanged.
- The rewrite must compile. No prose inside the code block.

Respond with strict JSON, no markdown fence:
{
  "rewrite": "<full rewritten snippet>",
  "reasons": ["<one short reason per change, present-tense, under 90 chars>", ...],
  "tradeoffs": "<optional, one sentence on what the rewrite gives up — null if none>"
}

Snippet:
\`\`\`${language}
${code}
\`\`\``;
}

function parseResponse(raw: string): CompareResult | null {
  // Models occasionally wrap JSON in a fence despite the instruction.
  // Strip if present, then locate the outermost {…} block.
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  const slice = cleaned.slice(start, end + 1);
  try {
    const parsed = JSON.parse(slice) as Partial<CompareResult>;
    if (typeof parsed.rewrite !== "string") return null;
    if (!Array.isArray(parsed.reasons)) return null;
    return {
      rewrite: parsed.rewrite,
      reasons: parsed.reasons.filter((r): r is string => typeof r === "string"),
      tradeoffs:
        typeof parsed.tradeoffs === "string" && parsed.tradeoffs.trim().length > 0
          ? parsed.tradeoffs
          : undefined,
    };
  } catch (err) {
    log("compare", `JSON parse failed — ${(err as Error).message}`);
    return null;
  }
}

async function presentDiff(
  result: CompareResult,
  original: string,
  language: string,
  sourceEditor: vscode.TextEditor,
  sourceRange: vscode.Range
): Promise<void> {
  const sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const ext = extensionFor(language);
  activeDiffs.set(sessionId, {
    original,
    rewrite: result.rewrite,
    language,
  });

  // Cap retained sessions so long-running editor sessions don't leak
  // memory through accumulated content provider entries.
  if (activeDiffs.size > 24) {
    const oldestKey = activeDiffs.keys().next().value;
    if (oldestKey) activeDiffs.delete(oldestKey);
  }

  const left = vscode.Uri.parse(`${COMPARE_SCHEME}:/${sessionId}/original.${ext}`);
  const right = vscode.Uri.parse(`${COMPARE_SCHEME}:/${sessionId}/rewrite.${ext}`);

  await vscode.commands.executeCommand(
    "vscode.diff",
    left,
    right,
    "Protege · Compare (you ↔ senior rewrite)",
    { preview: true, viewColumn: vscode.ViewColumn.Beside }
  );

  const headline = result.reasons[0]
    ? truncate(result.reasons[0], 120)
    : "Rewrite ready.";

  const choice = await vscode.window.showInformationMessage(
    headline,
    "Apply rewrite",
    "Show reasoning",
    "Dismiss"
  );

  if (choice === "Apply rewrite") {
    await applyRewrite(sourceEditor, sourceRange, result.rewrite);
  } else if (choice === "Show reasoning") {
    await openReasoningDoc(result, original, language);
  }
}

async function applyRewrite(
  editor: vscode.TextEditor,
  range: vscode.Range,
  rewrite: string
): Promise<void> {
  // The editor reference can be stale if the user closed the source
  // tab while the AI call was in flight. Re-resolve via URI before
  // editing — falls back gracefully.
  const liveEditor = vscode.window.visibleTextEditors.find(
    (e) => e.document.uri.toString() === editor.document.uri.toString()
  );
  const target = liveEditor ?? editor;
  await target.edit((eb) => {
    eb.replace(range, rewrite);
  });
}

async function openReasoningDoc(
  result: CompareResult,
  original: string,
  language: string
): Promise<void> {
  const lines: string[] = [];
  lines.push("# Protege · Compare");
  lines.push("");
  lines.push("## Why the rewrite changed things");
  lines.push("");
  for (const r of result.reasons) {
    lines.push(`- ${r}`);
  }
  if (result.tradeoffs) {
    lines.push("");
    lines.push("## Tradeoffs");
    lines.push("");
    lines.push(result.tradeoffs);
  }
  lines.push("");
  lines.push("## Original");
  lines.push("");
  lines.push("```" + language);
  lines.push(original);
  lines.push("```");
  lines.push("");
  lines.push("## Rewrite");
  lines.push("");
  lines.push("```" + language);
  lines.push(result.rewrite);
  lines.push("```");

  const doc = await vscode.workspace.openTextDocument({
    content: lines.join("\n"),
    language: "markdown",
  });
  await vscode.window.showTextDocument(doc, {
    viewColumn: vscode.ViewColumn.Beside,
    preview: true,
  });
}

function extensionFor(language: string): string {
  // The extension only feeds the diff editor's syntax highlighter — a
  // close-enough match is fine. Unknown languages fall back to .txt.
  switch (language) {
    case "typescript":
    case "typescriptreact":
      return "ts";
    case "javascript":
    case "javascriptreact":
      return "js";
    case "python":
      return "py";
    case "go":
      return "go";
    case "rust":
      return "rs";
    case "java":
      return "java";
    case "csharp":
      return "cs";
    case "ruby":
      return "rb";
    case "php":
      return "php";
    case "swift":
      return "swift";
    case "kotlin":
      return "kt";
    case "cpp":
      return "cpp";
    case "c":
      return "c";
    default:
      return "txt";
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
