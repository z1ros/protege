import * as vscode from "vscode";
import { aiTeachConcept } from "./aiExplain.js";

/**
 * Peek Teaching View — JARVIS Layer 3.
 *
 * Opens an inline teaching panel (webview) when the user triggers
 * "Protege: Teach this" on any symbol. Shows:
 *   - Plain-English explanation
 *   - 2-3 code examples with syntax highlighting
 *   - Common mistakes to avoid
 *   - Related concepts (clickable → opens teach for that concept)
 *   - "Practice" button (creates a scratch file with an exercise)
 *
 * Local knowledge base handles ~40 common concepts instantly.
 * Falls back to Claude for anything not in the local DB.
 *
 * Keyboard shortcut: Cmd+K T (chord)
 */

let currentPanel: vscode.WebviewPanel | null = null;

export function registerPeekTeach(
  context: vscode.ExtensionContext
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  // Main command — teaches the symbol at cursor
  disposables.push(
    vscode.commands.registerCommand("protege.teachThis", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const position = editor.selection.active;
      const wordRange = editor.document.getWordRangeAtPosition(position);
      const word = wordRange
        ? editor.document.getText(wordRange)
        : editor.document.lineAt(position.line).text.trim();

      if (!word) {
        vscode.window.showInformationMessage(
          "Put your cursor on a symbol and try again."
        );
        return;
      }

      await teachConcept(word, editor, context);
    })
  );

  // Command to teach a specific concept (used by related concept links)
  disposables.push(
    vscode.commands.registerCommand(
      "protege.teachConcept",
      async (concept: string) => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        await teachConcept(concept, editor, context);
      }
    )
  );

  // Command to create a practice file
  disposables.push(
    vscode.commands.registerCommand(
      "protege.practiceExercise",
      async (concept: string, lang: string) => {
        await createPracticeFile(concept, lang);
      }
    )
  );

  return disposables;
}

interface TeachCard {
  title: string;
  concept: string;
  explanation: string;
  examples: { label: string; code: string; lang: string }[];
  mistakes: string[];
  related: string[];
  tip?: string;
}

async function teachConcept(
  query: string,
  editor: vscode.TextEditor,
  context: vscode.ExtensionContext
): Promise<void> {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Protege: learning about "${query}"...`,
      cancellable: true,
    },
    async (_, token) => {
      try {
        const lang = editor.document.languageId;
        const lineText = editor.document.lineAt(
          editor.selection.active.line
        ).text;

        if (token.isCancellationRequested) return;

        const result = await aiTeachConcept(query, lang, lineText);
        if (token.isCancellationRequested) return;

        const card: TeachCard = {
          title: result?.title ?? query,
          concept: query,
          explanation: result?.explanation ?? `Could not generate explanation for "${query}".`,
          examples: result?.examples ?? [],
          mistakes: result?.mistakes ?? [],
          related: result?.related ?? [],
          tip: result?.tip,
        };

        showTeachPanel(card, editor, context);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Protege teach failed: ${msg}`);
      }
    }
  );
}

function showTeachPanel(
  card: TeachCard,
  editor: vscode.TextEditor,
  context: vscode.ExtensionContext
): void {
  // Reuse existing panel if open, or create a new one
  if (currentPanel) {
    currentPanel.webview.html = buildTeachHtml(card, editor.document.languageId);
    currentPanel.reveal(vscode.ViewColumn.Beside, true);
    return;
  }

  currentPanel = vscode.window.createWebviewPanel(
    "protegeTeach",
    `Teach: ${card.title}`,
    {
      viewColumn: vscode.ViewColumn.Beside,
      preserveFocus: true,
    },
    {
      enableScripts: true,
      retainContextWhenHidden: false,
    }
  );

  currentPanel.webview.html = buildTeachHtml(card, editor.document.languageId);

  // Handle messages from the webview
  currentPanel.webview.onDidReceiveMessage((msg) => {
    if (msg.type === "teachConcept") {
      vscode.commands.executeCommand("protege.teachConcept", msg.concept);
    } else if (msg.type === "practice") {
      vscode.commands.executeCommand(
        "protege.practiceExercise",
        msg.concept,
        msg.lang
      );
    } else if (msg.type === "insertCode") {
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor) {
        activeEditor.insertSnippet(
          new vscode.SnippetString(msg.code),
          activeEditor.selection.active
        );
      }
    }
  });

  currentPanel.onDidDispose(() => {
    currentPanel = null;
  });
}

async function createPracticeFile(
  concept: string,
  lang: string
): Promise<void> {
  const ext =
    lang === "typescript" || lang === "tsx"
      ? ".ts"
      : lang === "python"
        ? ".py"
        : ".js";

  const content = `// Practice: ${concept}
// Try using ${concept} below. Delete the comments and write your own code.
//
// Tip: When you save this file, Protege will track your concept usage
// and update your Code IQ.

`;

  const doc = await vscode.workspace.openTextDocument({
    content,
    language: lang === "tsx" ? "typescriptreact" : lang,
  });
  await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
}

// ---- HTML builder for the teach panel ----

function buildTeachHtml(card: TeachCard, currentLang: string): string {
  const examplesHtml = card.examples
    .map(
      (ex, i) => `
    <div class="example">
      <div class="example-header">
        <span class="example-label">${esc(ex.label)}</span>
        <button class="btn-sm" onclick="copyCode(${i})">Copy</button>
        <button class="btn-sm" onclick="insertCode(${i})">Insert</button>
      </div>
      <pre class="code-block" id="code-${i}"><code>${esc(ex.code)}</code></pre>
    </div>`
    )
    .join("\n");

  const mistakesHtml = card.mistakes
    .map((m) => `<li>${esc(m)}</li>`)
    .join("\n");

  const relatedHtml = card.related
    .map(
      (r) =>
        `<button class="related-chip" onclick="teach('${esc(r)}')">${esc(r)}</button>`
    )
    .join(" ");

  const examplesData = JSON.stringify(card.examples.map((e) => e.code));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    background: #1a1b26;
    color: #c0caf5;
    padding: 20px 24px;
    line-height: 1.6;
    font-size: 13px;
  }
  h1 {
    font-size: 22px;
    font-weight: 700;
    color: #c0caf5;
    margin-bottom: 4px;
    letter-spacing: -0.02em;
  }
  .subtitle {
    font-size: 11px;
    color: #565f89;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    margin-bottom: 16px;
  }
  .explanation {
    font-size: 14px;
    line-height: 1.7;
    color: #a9b1d6;
    margin-bottom: 20px;
    border-left: 3px solid #3d59a1;
    padding-left: 14px;
  }
  .section-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.16em;
    color: #565f89;
    margin: 20px 0 8px;
    font-weight: 600;
  }
  .example {
    margin-bottom: 14px;
    border: 1px solid #292e42;
    border-radius: 8px;
    overflow: hidden;
  }
  .example-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    background: #16161e;
    border-bottom: 1px solid #292e42;
  }
  .example-label {
    flex: 1;
    font-size: 11px;
    font-weight: 600;
    color: #7aa2f7;
  }
  .code-block {
    padding: 12px 14px;
    background: #1a1b26;
    overflow-x: auto;
    font-family: 'Geist Mono', 'SF Mono', Menlo, monospace;
    font-size: 12px;
    line-height: 1.6;
    color: #c0caf5;
  }
  .code-block code { white-space: pre; }
  .btn-sm {
    padding: 3px 8px;
    background: #292e42;
    border: 1px solid #3b4261;
    border-radius: 4px;
    color: #7aa2f7;
    font-size: 10px;
    cursor: pointer;
    font-family: inherit;
  }
  .btn-sm:hover {
    background: #3b4261;
    color: #c0caf5;
  }
  .mistakes {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .mistakes li {
    padding: 8px 12px;
    background: rgba(219, 75, 75, 0.08);
    border: 1px solid rgba(219, 75, 75, 0.2);
    border-radius: 6px;
    font-size: 12px;
    color: #c0caf5;
  }
  .mistakes li::before {
    content: "⚠ ";
    color: #e0af68;
  }
  .tip {
    padding: 10px 14px;
    background: rgba(158, 206, 106, 0.08);
    border: 1px solid rgba(158, 206, 106, 0.2);
    border-radius: 8px;
    font-size: 12px;
    color: #9ece6a;
    margin-top: 14px;
  }
  .tip::before {
    content: "💡 ";
  }
  .related-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .related-chip {
    padding: 5px 12px;
    background: #292e42;
    border: 1px solid #3b4261;
    border-radius: 999px;
    color: #7aa2f7;
    font-size: 11px;
    cursor: pointer;
    font-family: inherit;
    transition: background 150ms;
  }
  .related-chip:hover {
    background: #3b4261;
    color: #c0caf5;
  }
  .practice-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-top: 16px;
    padding: 8px 16px;
    background: rgba(122, 162, 247, 0.12);
    border: 1px solid rgba(122, 162, 247, 0.3);
    border-radius: 8px;
    color: #7aa2f7;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    font-family: inherit;
    transition: background 150ms;
  }
  .practice-btn:hover {
    background: rgba(122, 162, 247, 0.2);
  }
  .footer {
    margin-top: 24px;
    padding-top: 14px;
    border-top: 1px solid #292e42;
    font-size: 10px;
    color: #565f89;
    text-align: center;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
</style>
</head>
<body>
  <h1>${esc(card.title)}</h1>
  <div class="subtitle">Protege Teaching Card</div>

  <div class="explanation">${esc(card.explanation)}</div>

  ${
    card.examples.length > 0
      ? `<div class="section-label">Examples</div>\n${examplesHtml}`
      : ""
  }

  ${
    card.mistakes.length > 0
      ? `<div class="section-label">Common Mistakes</div>\n<ul class="mistakes">${mistakesHtml}</ul>`
      : ""
  }

  ${card.tip ? `<div class="tip">${esc(card.tip)}</div>` : ""}

  ${
    card.related.length > 0
      ? `<div class="section-label">Related Concepts</div>\n<div class="related-chips">${relatedHtml}</div>`
      : ""
  }

  <button class="practice-btn" onclick="practice()">
    <span>✏️</span> Practice this concept
  </button>

  <div class="footer">Protege · learn by doing</div>

  <script>
    const vscode = acquireVsCodeApi();
    const examples = ${examplesData};

    function copyCode(idx) {
      navigator.clipboard.writeText(examples[idx]);
    }

    function insertCode(idx) {
      vscode.postMessage({ type: 'insertCode', code: examples[idx] });
    }

    function teach(concept) {
      vscode.postMessage({ type: 'teachConcept', concept });
    }

    function practice() {
      vscode.postMessage({
        type: 'practice',
        concept: ${JSON.stringify(card.concept)},
        lang: ${JSON.stringify(currentLang)},
      });
    }
  </script>
</body>
</html>`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
