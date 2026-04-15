import * as vscode from "vscode";
import type { MeResponse, HostToWebview } from "@protege/types";
import { openProtegePanel } from "./panel.js";
import { LauncherProvider } from "./launcher.js";
import { registerAnalyzer } from "./analyzer.js";
import { FindingCodeLensProvider } from "./codeLens.js";
import { broadcast, pushTeachFinding } from "./webviewHost.js";
import { getUserId, fetchMe } from "./protegeClient.js";
import { initActiveFileTracker } from "./activeFile.js";
import { startWatcher, type DispatchedNudge } from "./watcher/index.js";

let output: vscode.OutputChannel;
let statusBar: vscode.StatusBarItem;

function broadcastMe(me: MeResponse) {
  const msg: HostToWebview = {
    type: "iq/update",
    codeIq: me.codeIq,
    maxIq: me.maxIq,
    bonusIq: me.bonusIq,
    totalConcepts: me.totalConcepts,
    ruleCount: me.ruleCount,
    topConcepts: me.topConcepts,
    clusters: me.clusters,
    recentGains: me.recentGains,
    streak: me.streak,
    dailyIq: me.dailyIq,
    milestones: me.milestones,
    recommendations: me.recommendations,
  };
  broadcast(msg);
}

export async function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel("Protege");
  output.appendLine(`[protege] activated — user ${getUserId(context)}`);

  // ===== Status bar =====
  statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBar.text = "$(shield) Protege";
  statusBar.tooltip = "Open Protege mentor";
  statusBar.command = "protege.toggle";
  statusBar.show();

  // ===== Diagnostics + CodeLens =====
  const diagnostics = vscode.languages.createDiagnosticCollection("protege");
  const codeLens = new FindingCodeLensProvider();

  const codeLensSub = vscode.languages.registerCodeLensProvider(
    [
      { language: "javascript" },
      { language: "typescript" },
      { language: "javascriptreact" },
      { language: "typescriptreact" },
      { language: "python" },
    ],
    codeLens
  );

  // ===== Analyzer (file save → concepts + bugs + IQ update) =====
  const analyzerSub = registerAnalyzer(
    context,
    diagnostics,
    (me) => {
      updateStatusBar(me.codeIq, me.totalConcepts);
      codeLens.refresh();
      broadcastMe(me);
    },
    (gains, codeIq) => {
      broadcast({ type: "iq/gain", gains, codeIq });
      // Gentle toast for the most impactful gain in this save.
      const top = [...gains].sort((a, b) => b.deltaIq - a.deltaIq)[0];
      if (top && top.deltaIq > 0) {
        vscode.window.setStatusBarMessage(
          `$(sparkle) +${top.deltaIq} IQ · ${top.concept}`,
          4000
        );
      }
    },
    output
  );

  // Sticky active-file tracking — keeps last real editor even when
  // focus moves to the Protege panel (webview).
  initActiveFileTracker(context, (editor) => {
    broadcast({
      type: "file/active",
      file: editor
        ? {
            path: editor.document.fileName,
            language: editor.document.languageId,
          }
        : null,
    });
  });

  // ===== Ambient watcher (Phase 0 of hybrid intelligence plan) =====
  const watcher = startWatcher(context, output, (nudge: DispatchedNudge) => {
    openProtegePanel(context);
    broadcast({
      type: "watcher/nudge",
      nudge: {
        id: nudge.id,
        triggerId: nudge.triggerId as import("@protege/types").UnpromptedTriggerId,
        severity: nudge.severity,
        text: nudge.text,
        canEscalate: nudge.canEscalate,
        context: {
          filePath: nudge.context.filePath,
          errorMessage: nudge.context.error?.message,
          errorLine: nudge.context.error?.line,
          concept: nudge.context.concept,
          note: nudge.context.note,
        },
        createdAt: nudge.createdAt,
      },
    });
  });
  void watcher;

  // ===== Launcher (activity bar) =====
  const launcher = new LauncherProvider(context);

  context.subscriptions.push(
    output,
    statusBar,
    diagnostics,
    codeLensSub,
    analyzerSub,
    vscode.window.registerWebviewViewProvider("protege.launcher", launcher),
    vscode.commands.registerCommand("protege.toggle", () =>
      openProtegePanel(context)
    ),
    vscode.commands.registerCommand("protege.openInNewTab", () =>
      openProtegePanel(context)
    ),
    vscode.commands.registerCommand("protege.teachFinding", (finding) => {
      openProtegePanel(context);
      setTimeout(() => pushTeachFinding(finding), 300);
    }),
    vscode.commands.registerCommand("protege.refreshIQ", async () => {
      try {
        const me = await fetchMe(getUserId(context));
        updateStatusBar(me.codeIq, me.totalConcepts);
        broadcastMe(me);
      } catch (e) {
        output.appendLine(`[protege] refreshIQ err: ${e}`);
      }
    }),
    vscode.commands.registerCommand("protege.silenceToday", () => {
      watcher.dispatch.silenceForToday();
      vscode.window.showInformationMessage(
        "Protege: watcher silenced for today."
      );
    }),
    vscode.commands.registerCommand("protege.watcherStats", () => {
      const stats = watcher.dispatch.stats();
      vscode.window.showInformationMessage(
        `Protege watcher: ${JSON.stringify(stats)}`
      );
    })
  );

  setTimeout(() => {
    vscode.commands.executeCommand("protege.refreshIQ");
  }, 500);

  setTimeout(() => {
    try {
      openProtegePanel(context);
    } catch (e) {
      output.appendLine(`[protege] auto-open failed: ${String(e)}`);
    }
  }, 400);
}

function updateStatusBar(codeIq: number, totalConcepts: number) {
  statusBar.text = `$(shield) Protege  IQ ${codeIq}`;
  statusBar.tooltip = `Code IQ: ${codeIq}  ·  ${totalConcepts} concepts tracked`;
}

export function deactivate() {}
