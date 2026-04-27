import * as vscode from "vscode";
import type { WalkStep } from "@protege/types";
import { fetchWalk, WalkQuotaExceededError } from "./walkClient.js";
import { NotAuthenticatedError } from "../user/protegeClient.js";
import { log } from "../log.js";
import {
  pushWalkState,
  setWalkActionHandler,
  type WalkSidebarState,
} from "./walkView.js";

/**
 * File Walk — sequential mentor-narrated walkthrough of a single file.
 *
 * Surfaces (no inline comment thread anymore — the sidebar webview owns
 * the explanation; the editor only carries the highlight):
 *   • Sidebar webview (`walkView.ts`) — sticky on scroll. Shows current
 *     step title + body + concept Teach buttons + nav + step list.
 *   • Editor decoration — line-range highlight on the active step.
 *   • Status bar cluster (◀ · "File Walk · 3/10" · ▶) — always-visible
 *     fallback nav independent of editor-title space.
 *   • Editor title icons — shown when `protege.fileWalk.active`.
 *
 * Past the last step → loops back to step 0. Closing the doc resets.
 */

interface ActiveSession {
  uri: vscode.Uri;
  steps: WalkStep[];
  index: number;
  decoration: vscode.TextEditorDecorationType;
  cached: boolean;
}

interface WalkStatusBar {
  prev: vscode.StatusBarItem;
  progress: vscode.StatusBarItem;
  next: vscode.StatusBarItem;
}

let session: ActiveSession | null = null;
let starting = false;
let statusBar: WalkStatusBar | null = null;
const ACTIVE_CONTEXT_KEY = "protege.fileWalk.active";

function makeDecoration(): vscode.TextEditorDecorationType {
  return vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor("editor.findMatchHighlightBackground"),
    isWholeLine: true,
    overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.findMatchForeground"),
    overviewRulerLane: vscode.OverviewRulerLane.Center,
  });
}

export async function startFileWalk(target?: vscode.Uri): Promise<void> {
  if (starting) return;
  starting = true;
  try {
    const uri = target ?? vscode.window.activeTextEditor?.document.uri;
    if (!uri) {
      vscode.window.showInformationMessage(
        "Open a file first, then try File Walk."
      );
      return;
    }

    let document: vscode.TextDocument;
    try {
      document = await vscode.workspace.openTextDocument(uri);
    } catch (err) {
      vscode.window.showErrorMessage(
        `Couldn't open ${uri.fsPath}: ${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }
    const editor = await vscode.window.showTextDocument(document, { preview: false });

    // Reset any prior session — only one walk at a time.
    disposeSession();

    const fileBase = uri.path.split("/").pop() ?? uri.fsPath;
    const fetched = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Protege · planning walk through ${fileBase}…`,
        cancellable: false,
      },
      async () => {
        try {
          return await fetchWalk({ document });
        } catch (err) {
          if (err instanceof NotAuthenticatedError) {
            vscode.window.showWarningMessage(
              "Sign in with GitHub to use File Walk."
            );
            return null;
          }
          if (err instanceof WalkQuotaExceededError) {
            const reset = new Date(err.resetAt);
            vscode.window.showWarningMessage(
              `Daily File Walk quota reached (${err.used}/${err.limit}). Resets ${reset.toLocaleString()}.`
            );
            return null;
          }
          vscode.window.showErrorMessage(
            `File Walk failed: ${err instanceof Error ? err.message : String(err)}`
          );
          return null;
        }
      }
    );
    if (!fetched || fetched.steps.length === 0) return;

    session = {
      uri,
      steps: fetched.steps,
      index: 0,
      decoration: makeDecoration(),
      cached: fetched.cached,
    };
    await vscode.commands.executeCommand("setContext", ACTIVE_CONTEXT_KEY, true);
    showCurrentStep(editor);
    pushSidebarState();
    log(
      "walk",
      `started · ${fileBase} · ${fetched.steps.length} steps · cached=${fetched.cached}`
    );
  } finally {
    starting = false;
  }
}

function pushSidebarState(): void {
  if (!session) {
    pushWalkState(null);
    return;
  }
  const fileBase = session.uri.path.split("/").pop() ?? session.uri.fsPath;
  const state: WalkSidebarState = {
    filePath: fileBase,
    index: session.index,
    cached: session.cached,
    current: session.steps[session.index],
    steps: session.steps.map((s) => ({
      index: s.index,
      title: s.title,
      lineStart: s.lineStart,
      lineEnd: s.lineEnd,
    })),
  };
  pushWalkState(state);
}

function showCurrentStep(editor?: vscode.TextEditor): void {
  if (!session) return;
  const ed = editor ?? activeEditorForSession();
  if (!ed) return;
  const step = session.steps[session.index];
  if (!step) return;

  const doc = ed.document;
  const startLine = Math.max(0, Math.min(doc.lineCount - 1, step.lineStart - 1));
  const endLine = Math.max(startLine, Math.min(doc.lineCount - 1, step.lineEnd - 1));
  const range = new vscode.Range(
    startLine,
    0,
    endLine,
    doc.lineAt(endLine).text.length
  );
  ed.setDecorations(session.decoration, [range]);
  ed.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);

  updateProgressItem();
}

function updateProgressItem(): void {
  if (!session) return;
  if (!statusBar) {
    // Three left-aligned items so prev/next are always one click away,
    // independent of editor-title space, palette fuzzy-match quirks, or
    // tab overflow. Higher priority renders further left, so the order
    // visible to the user is: ◀ · "File Walk · 3/10" · ▶
    const prev = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      102
    );
    prev.text = "$(arrow-left)";
    prev.command = "protege.fileWalk.prev";
    prev.tooltip = "File Walk — previous step";

    const progress = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      101
    );
    progress.command = "protege.fileWalk.exit";
    progress.tooltip = "File Walk — click to exit";

    const next = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    next.text = "$(arrow-right)";
    next.command = "protege.fileWalk.next";
    next.tooltip = "File Walk — next step";

    statusBar = { prev, progress, next };
  }
  statusBar.progress.text = `$(debug-step-into) File Walk · ${session.index + 1}/${session.steps.length}`;
  statusBar.prev.show();
  statusBar.progress.show();
  statusBar.next.show();
}

function activeEditorForSession(): vscode.TextEditor | undefined {
  if (!session) return undefined;
  return vscode.window.visibleTextEditors.find(
    (e) => e.document.uri.toString() === session!.uri.toString()
  );
}

export function nextStep(): void {
  if (!session) return;
  // Past the last step → loop back to 0 (product spec).
  session.index = (session.index + 1) % session.steps.length;
  showCurrentStep();
  pushSidebarState();
}

export function prevStep(): void {
  if (!session) return;
  session.index =
    (session.index - 1 + session.steps.length) % session.steps.length;
  showCurrentStep();
  pushSidebarState();
}

export function jumpToStep(index: number): void {
  if (!session) return;
  if (index < 0 || index >= session.steps.length) return;
  session.index = index;
  showCurrentStep();
  pushSidebarState();
}

export function exitWalk(): void {
  disposeSession();
  log("walk", "exited");
}

function disposeSession(): void {
  if (!session) return;
  for (const ed of vscode.window.visibleTextEditors) {
    if (ed.document.uri.toString() === session.uri.toString()) {
      ed.setDecorations(session.decoration, []);
    }
  }
  session.decoration.dispose();
  session = null;
  if (statusBar) {
    statusBar.prev.hide();
    statusBar.progress.hide();
    statusBar.next.hide();
    statusBar.prev.dispose();
    statusBar.progress.dispose();
    statusBar.next.dispose();
    statusBar = null;
  }
  void vscode.commands.executeCommand("setContext", ACTIVE_CONTEXT_KEY, false);
  pushWalkState(null);
}

export function registerFileWalk(
  _context: vscode.ExtensionContext
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  disposables.push(
    vscode.commands.registerCommand(
      "protege.startFileWalk",
      async (target?: vscode.Uri) => {
        // Editor-title menu passes a Uri argument; explorer/context passes a
        // Uri too. Palette gives nothing → fall through to active editor.
        await startFileWalk(target instanceof vscode.Uri ? target : undefined);
      }
    )
  );
  disposables.push(
    vscode.commands.registerCommand("protege.fileWalk.next", () => nextStep())
  );
  disposables.push(
    vscode.commands.registerCommand("protege.fileWalk.prev", () => prevStep())
  );
  disposables.push(
    vscode.commands.registerCommand("protege.fileWalk.exit", () => exitWalk())
  );

  // Sidebar webview action handler — relays clicks from walkView.html
  // back into the same code paths used by the editor-title icons,
  // status-bar buttons, and command palette. Concept chips route
  // through the existing `protege.teachConcept` dispatcher.
  setWalkActionHandler((action) => {
    switch (action.type) {
      case "next":
        nextStep();
        break;
      case "prev":
        prevStep();
        break;
      case "exit":
        exitWalk();
        break;
      case "start":
        void startFileWalk();
        break;
      case "jumpTo":
        jumpToStep(action.index);
        break;
      case "teachConcept":
        void vscode.commands.executeCommand(
          "protege.teachConcept",
          action.concept
        );
        break;
    }
  });

  // Auto-clean if the user closes the walked document.
  disposables.push(
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (session && doc.uri.toString() === session.uri.toString()) {
        disposeSession();
      }
    })
  );

  disposables.push(
    new vscode.Disposable(() => {
      disposeSession();
    })
  );

  return disposables;
}
