import * as vscode from "vscode";
import type { Suggestion } from "./reviewEngine.js";

/**
 * TipComment — renders the Protege card as a native VS Code Comment Thread
 * docked between code lines. Uses the STABLE `vscode.comments` API, so it
 * works in Cursor and VS Code without any proposed-API flags or setup.
 *
 * Layout feel: GitLens-style inline annotation. Native chrome, collapsible,
 * keyboard-accessible. No stacking with TS/cSpell hovers.
 */

let controller: vscode.CommentController | null = null;
const activeByUri = new Map<string, vscode.CommentThread>();

interface ProtegeComment extends vscode.Comment {
  ruleId: string;
  fix?: string;
  line: number;
  docUri: string;
}

function ensureController(context: vscode.ExtensionContext): vscode.CommentController {
  if (controller) return controller;
  controller = vscode.comments.createCommentController(
    "protege.tips",
    "Protege"
  );
  controller.commentingRangeProvider = {
    provideCommentingRanges: () => [],
  };
  context.subscriptions.push(controller);
  return controller;
}

const SEVERITY_META: Record<Suggestion["severity"], { label: string; icon: string }> = {
  warn: { label: "Potential bug",    icon: "$(warning)" },
  perf: { label: "Perf hit",         icon: "$(zap)" },
  info: { label: "Heads up",         icon: "$(lightbulb)" },
};

function titleForRule(ruleId: string, severity: Suggestion["severity"]): string {
  const clean = ruleId.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return `${SEVERITY_META[severity].label} — ${clean}`;
}

function buildBody(s: Suggestion, currentLine: string, lang: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.isTrusted = true;
  md.supportThemeIcons = true;

  md.appendMarkdown(`${SEVERITY_META[s.severity].icon} **${titleForRule(s.ruleId, s.severity)}**\n\n`);
  md.appendMarkdown(`${s.message}\n\n`);

  if (currentLine && currentLine.trim()) {
    md.appendMarkdown(`**Current**\n`);
    md.appendCodeblock(currentLine, lang || "plaintext");
  }
  if (s.fix && s.fix.trim()) {
    md.appendMarkdown(`**Suggested**\n`);
    md.appendCodeblock(s.fix.trim(), lang || "plaintext");
  }

  const args = encodeURIComponent(JSON.stringify({ ruleId: s.ruleId }));
  md.appendMarkdown(
    `\n\n[$(mortar-board) Teach me](command:protege.teachConcept?${encodeURIComponent(JSON.stringify(s.ruleId))})`
  );
  if (s.fix) {
    const fixArgs = encodeURIComponent(
      JSON.stringify({
        uri: "__URI__",
        line: s.range.start.line,
        fix: s.fix,
      })
    );
    // applyReviewFix expects a stringified payload — wrap in outer JSON
    // (command URI re-stringifies args once)
    md.appendMarkdown(`  ·  [$(wand) Apply fix](command:protege.applyReviewFix?${fixArgs})`);
  }
  md.appendMarkdown(`  ·  [$(close) Dismiss](command:protege.dismissTipThread)`);
  md.appendMarkdown(`\n\n<sub>${s.ruleId}</sub>`);
  return md;
}

export function showTipComment(
  context: vscode.ExtensionContext,
  args: {
    suggestion: Suggestion;
    editor: vscode.TextEditor;
    currentLine: string;
    lang: string;
  }
): boolean {
  try {
    const c = ensureController(context);
    const key = args.editor.document.uri.toString();

    // Dispose any prior thread for this doc so only one card shows
    const prior = activeByUri.get(key);
    if (prior) {
      try { prior.dispose(); } catch {}
      activeByUri.delete(key);
    }

    const line = args.suggestion.range.start.line;
    const range = new vscode.Range(line, 0, line, 0);

    const body = buildBody(args.suggestion, args.currentLine, args.lang);
    // Command URIs for applyReviewFix need the real doc URI — inject it now
    body.value = body.value.replace(
      /__URI__/g,
      args.editor.document.uri.toString()
    );

    const comment: ProtegeComment = {
      author: { name: "Protege" },
      body,
      mode: vscode.CommentMode.Preview,
      ruleId: args.suggestion.ruleId,
      fix: args.suggestion.fix,
      line,
      docUri: args.editor.document.uri.toString(),
    };

    const thread = c.createCommentThread(
      args.editor.document.uri,
      range,
      [comment]
    );
    thread.label = `Protege · ${SEVERITY_META[args.suggestion.severity].label}`;
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    thread.canReply = false;
    thread.contextValue = "protege.tip";

    activeByUri.set(key, thread);
    return true;
  } catch (err) {
    console.warn("[protege] comment thread failed:", err);
    return false;
  }
}

export function dismissActiveTipThread(): void {
  const uri = vscode.window.activeTextEditor?.document.uri.toString();
  if (!uri) {
    for (const [k, t] of activeByUri) {
      try { t.dispose(); } catch {}
      activeByUri.delete(k);
    }
    return;
  }
  const t = activeByUri.get(uri);
  if (t) {
    try { t.dispose(); } catch {}
    activeByUri.delete(uri);
  }
}
