import * as vscode from "vscode";
import { exec } from "node:child_process";
import type { MeResponse, HostToWebview } from "@protege/types";
import { openProtegePanel } from "./panel.js";
import { LauncherProvider } from "./launcher.js";
import { registerAnalyzer } from "./analyzer.js";
import { FindingCodeLensProvider } from "./codeLens.js";
import { broadcast, pushTeachFinding } from "./webviewHost.js";
import { getUserId, fetchMe } from "./protegeClient.js";
import { initActiveFileTracker } from "./activeFile.js";
import { startWatcher, type DispatchedNudge } from "./watcher/index.js";
import { registerInlineErrors } from "./inlineErrors.js";
import { registerPeekTeach } from "./peekTeach.js";
import { registerLiveReview } from "./liveReview.js";
import { registerStatusBarLive, updateStatusBarData } from "./statusBarLive.js";
import { registerDidYouKnow } from "./didYouKnow.js";
import { registerCommands } from "./commands/index.js";
import { registerTeachPopup } from "./teachPopup.js";
import { registerTeachingFlow } from "./teachingFlow.js";
import { registerOnDeviceModel } from "./onDeviceModel.js";
import { registerExerciseEngine } from "./exerciseEngine.js";
import { initChatHistory, disposeChatHistory } from "./chatHistory.js";

let output: vscode.OutputChannel;

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
    pillars: me.pillars,
    level: me.level,
    synergies: me.synergies,
    velocity: me.velocity,
    breakdown: me.breakdown,
  };
  broadcast(msg);
}

export async function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel("Protege");
  output.appendLine(`[protege] activated — user ${getUserId(context)}`);

  // ===== Chat history persistence =====
  initChatHistory(context);

  // ===== Status bar (context-aware, JARVIS Layer 4) =====
  const statusBarDisposables = registerStatusBarLive(context);

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
  const analyzer = registerAnalyzer(
    context,
    diagnostics,
    (me) => {
      updateStatusBarData({ codeIq: me.codeIq, streakDays: me.streak.current, totalConcepts: me.totalConcepts });
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

  // ===== Ambient watcher — RE-ENABLED =====
  // Polls every 4s, detects: stuck errors, undo clusters (struggle),
  // stare pauses, build fail loops, wins, flow state, late night,
  // risky edits, concept breakthroughs. Dispatches nudges to the webview.
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

  // ===== Launcher (activity bar) =====
  const launcher = new LauncherProvider(context);

  // Highlights now persist until the user EXPLICITLY dismisses them via:
  //   1. Escape key (keybinding gated by protege.hasHighlights context key)
  //   2. "Clear highlights" link in the hover popup
  //   3. Sending a new chat message (handleChat calls clearAllHighlights)
  //   4. Auto-timer (25s inactivity, configured in tools.ts)
  //
  // We intentionally do NOT clear on:
  //   - Typing/editing the file (too aggressive — user loses context)
  //   - Switching to another file (they might come back)
  //
  // This matches the user's expectation: "I can see the highlights while
  // I read/fix, and dismiss them when I'm done."

  // ===== JARVIS Layer 2: Inline error explanations =====
  const inlineErrorDisposables = registerInlineErrors(context);

  // ===== JARVIS Layer 3: Peek teaching view =====
  const peekTeachDisposables = registerPeekTeach(context);

  // ===== JARVIS Layer 4: Live code review =====
  const liveReviewDisposables = registerLiveReview(context);

  // ===== JARVIS Layer 4: "Did You Know?" proactive tips =====
  const didYouKnowDisposables = registerDidYouKnow(context);

  // ===== JARVIS Layer 5: Command palette commands =====
  const commandDisposables = registerCommands(context);

  context.subscriptions.push(
    output,
    ...statusBarDisposables,
    diagnostics,
    codeLensSub,
    analyzer.disposable,
    ...inlineErrorDisposables,
    ...peekTeachDisposables,
    ...liveReviewDisposables,
    ...didYouKnowDisposables,
    ...commandDisposables,
    ...registerTeachPopup(),
    ...registerTeachingFlow(),
    ...registerOnDeviceModel(context),
    ...registerExerciseEngine(context),
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
        updateStatusBarData({ codeIq: me.codeIq, streakDays: me.streak.current, totalConcepts: me.totalConcepts });
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
    }),
    vscode.commands.registerCommand("protege.clearHighlights", async () => {
      const { clearAllHighlights } = await import("./tools.js");
      await clearAllHighlights();
    }),
    vscode.commands.registerCommand("protege.scanActiveFile", async () => {
      broadcast({ type: "scan/started" });
      try {
        const result = await analyzer.scanActive();
        if (!result) {
          broadcast({ type: "scan/done", found: 0, summary: "" });
          return;
        }
        const base = result.path.split(/[\\/]/).pop() ?? result.path;
        const summary =
          result.found === 0
            ? `Scanned ${base} — looks clean. No findings.`
            : `Scanned ${base} — found ${result.found} issue${
                result.found === 1 ? "" : "s"
              }. Tap the highlighted lines in the editor for details.`;
        broadcast({ type: "scan/done", found: result.found, summary });
      } catch (e) {
        broadcast({
          type: "scan/done",
          found: 0,
          summary: `Scan failed: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }),
    vscode.commands.registerCommand(
      "protege.applyFix",
      async (args: { path: string; startLine: number; endLine: number; fix: string }) => {
        try {
          const { clearAllHighlights } = await import("./tools.js");
          const uri = args.path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(args.path)
            ? vscode.Uri.file(args.path)
            : vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, args.path);
          const doc = await vscode.workspace.openTextDocument(uri);
          const editor = await vscode.window.showTextDocument(doc);
          const startIdx = Math.max(0, args.startLine - 1);
          const endIdx = Math.max(startIdx, args.endLine - 1);
          const endLine = doc.lineAt(Math.min(endIdx, doc.lineCount - 1));
          const range = new vscode.Range(startIdx, 0, endLine.lineNumber, endLine.text.length);
          await editor.edit((b) => b.replace(range, args.fix));
          await clearAllHighlights();
          vscode.window.setStatusBarMessage("$(check) Fix applied", 2000);
        } catch (err) {
          vscode.window.showErrorMessage(
            `Fix failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    ),
    vscode.commands.registerCommand(
      "protege.teachHighlight",
      (args: { kind?: string; label?: string }) => {
        // User clicked "Teach me more" inside a highlight hover popup.
        // Open the panel, then send a chat/autoSend message into the
        // webview — it routes through the same code path as if the user
        // had typed + clicked send.
        openProtegePanel(context);
        const kind = args?.kind ?? "focus";
        const label = args?.label ?? "";
        const prompt = label
          ? `Can you teach me more about this ${kind} you highlighted: "${label}"? Walk me through it with a real example.`
          : `Can you explain the ${kind} you just highlighted in the editor?`;
        setTimeout(() => {
          broadcast({ type: "chat/autoSend", message: prompt });
        }, 300);
      }
    ),
    vscode.commands.registerCommand("protege.openMicSettings", async () => {
      // macOS: direct-link to the Microphone pane
      if (process.platform === "darwin") {
        await vscode.env.openExternal(
          vscode.Uri.parse(
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
          )
        );
      } else {
        vscode.window.showInformationMessage(
          "Mic permission settings are OS-specific. Grant Cursor microphone access in your system privacy settings."
        );
      }
    }),
    vscode.commands.registerCommand("protege.resetMicPermission", async () => {
      if (process.platform !== "darwin") {
        vscode.window.showInformationMessage(
          "Mic permission reset is macOS-only. On other platforms, revoke + re-grant mic access to Cursor in your system privacy settings."
        );
        return;
      }
      const choice = await vscode.window.showWarningMessage(
        "This resets macOS microphone permissions for ALL apps. You'll need to re-grant mic access to Cursor (and any other apps) after relaunching. Continue?",
        { modal: true },
        "Reset + Guide me",
        "Cancel"
      );
      if (choice !== "Reset + Guide me") return;

      output.appendLine("[protege] running `tccutil reset Microphone`…");
      try {
        await new Promise<void>((resolve, reject) => {
          exec("tccutil reset Microphone", (err, _stdout, stderr) => {
            if (err) {
              reject(new Error(stderr || err.message));
              return;
            }
            resolve();
          });
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        output.appendLine(`[protege] tccutil failed: ${msg}`);
        vscode.window.showErrorMessage(
          `Mic reset failed: ${msg}. You can do it manually: remove Cursor from System Settings → Privacy → Microphone, then add it back.`
        );
        return;
      }

      output.appendLine("[protege] tccutil reset ok");
      const next = await vscode.window.showInformationMessage(
        "Done. Now FULLY QUIT Cursor (Cmd+Q — not just close the window) and reopen it. The first time you use voice mode, grant mic access when macOS prompts.",
        "Quit Cursor",
        "I'll quit manually"
      );
      if (next === "Quit Cursor") {
        await vscode.commands.executeCommand("workbench.action.quit");
      }
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

// Old updateStatusBar removed — replaced by statusBarLive.ts

export function deactivate() {}
