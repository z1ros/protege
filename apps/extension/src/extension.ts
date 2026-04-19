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
// Editor-surface UI modules paused — imports removed so the bundle doesn't
// carry them while we redesign:
//   inlineErrors, peekTeach, didYouKnow, findingHover
// Live review still loads because its scan pipeline feeds the sidebar data.
import { registerLiveReview } from "./liveReview.js";
import { registerStatusBarLive, updateStatusBarData } from "./statusBarLive.js";
import { registerUnderlineWhisper } from "./underlineWhisper.js";
import { registerGhostMentor } from "./ghostMentor.js";
import { registerTeachingThread } from "./teachingThread.js";
import { registerSmartFix } from "./smartFix.js";
// Inline lesson comment surface (the big `/* PROTEGE · ... */` block) is
// disabled — too much visual chrome stacked above the finding line.
// Teach now shows the hover popup + plays voice instead. The module
// stays in tree to make re-enabling a one-line change.
// import { registerInlineLessonComment } from "./inlineLessonComment.js";
import { registerWorkspaceIndex } from "./workspaceIndex.js";
import { registerSaveScan } from "./saveScan.js";
import { registerFlowScan } from "./flowScan.js";
import { registerFindingDiagnostics } from "./findingDiagnostics.js";
import { registerInsetWizardCommand } from "./insetWizard.js";
import { registerCommands } from "./commands/index.js";
import { registerTeachPopup } from "./teachPopup.js";
import { registerTeachingFlow } from "./teachingFlow.js";
import { registerOnDeviceModel } from "./onDeviceModel.js";
import { initAiBackend, onBackendCall } from "./aiBackend.js";
import { registerExerciseEngine } from "./exerciseEngine.js";
import { initChatHistory, disposeChatHistory } from "./chatHistory.js";
import { runWakeCalibration, hasCompletedWakeCalibration } from "./wakeWordCalibration.js";
import { stopWakeWordListener, isWakeWordListening } from "./voiceCapture.js";

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
    iqV2: me.iqV2,
  };
  broadcast(msg);
}

export async function activate(context: vscode.ExtensionContext) {
  // Reuse the shared output channel (see ./log.ts). Previously we created a
  // second channel with the same name here, which made the dropdown show
  // "Protege" twice and split our logs across them.
  const { getOutputChannel, log: logLine } = await import("./log.js");
  output = getOutputChannel();
  logLine("extension", `activated — user ${getUserId(context)}`);

  // ===== Chat history persistence =====
  initChatHistory(context);

  // ===== Editor Inset proposed API — opt-in via command only =====
  // Cursor's runtime doesn't expose `createWebviewTextEditorInset`, so the
  // argv.json flag is a no-op there. We no longer auto-prompt; power users
  // on a VS Code Insiders build can still run `Protege: Enable Inline Cards`
  // from the command palette. Default UX uses the stable Comment Thread
  // card — no setup required.

  // ===== AI backend choice — load from globalState so it survives reloads =====
  initAiBackend(context);
  // Every time an aiQuery actually runs, push a chip update to all mounted
  // webviews — so the user can see, live, which backend just handled a call.
  const aiCallSub = onBackendCall((info) => {
    broadcast({
      type: "ai/lastCall",
      backend: info.backend,
      atMs: info.atMs,
      durationMs: info.durationMs,
      ok: info.ok,
      fallback: info.fallback,
    });
  });
  context.subscriptions.push(new vscode.Disposable(aiCallSub));

  // ===== Status bar (context-aware, JARVIS Layer 4) =====
  const statusBarDisposables = registerStatusBarLive(context);

  // ===== Diagnostics + CodeLens =====
  const diagnostics = vscode.languages.createDiagnosticCollection("protege");
  // FindingCodeLensProvider (the "Ask Protege" CodeLens above finding lines)
  // is paused while we redesign editor-surface UX. Instantiated but never
  // registered — `refresh()` is a safe no-op if anything still calls it.
  const codeLens = new FindingCodeLensProvider();
  const codeLensSub: vscode.Disposable = new vscode.Disposable(() => {});

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

  // ===== Editor-surface UI paused (2026-04-17) =====
  // Temporarily disabled: inline error explanations, peek teach, live-review
  // gutter/inlay/codelens/comment thread, "Did You Know?" tips, finding
  // hovers. Redesigning the in-editor UX from scratch. Backend stays live —
  // analyzer still runs, findings still broadcast to the sidebar webview.
  const inlineErrorDisposables: vscode.Disposable[] = [];
  const peekTeachDisposables: vscode.Disposable[] = [];
  const didYouKnowDisposables: vscode.Disposable[] = [];
  const findingHoverDisposables: vscode.Disposable[] = [];

  // Live review scan pipeline stays on so the sidebar keeps getting data,
  // but its editor surfaces (gutter/inlay/codelens/comment thread) are
  // neutralised inside registerLiveReview itself.
  const liveReviewDisposables = registerLiveReview(context);

  // ===== Ambient Coach — in-editor surfaces =====
  // Two in-code surfaces that together teach while the user codes, without
  // popups, gutters, or sidebar interruptions:
  //   • Underline Whisper — thin Protege-blue underline on teachable tokens.
  //     Ambient brand signal. Hover → one-line tip. Learn link → inline peek.
  //   • Ghost Mentor — `// 💡` comment-style ghost line under the cursor on
  //     high-confidence teachable moments. Tab applies the fix, Esc dismisses.
  // See Architecture/ambient-coach-plan.md — Surfaces 2 + 3.
  const whisperDisposables = registerUnderlineWhisper(context);
  const ghostDisposables = registerGhostMentor(context);
  // Teaching Thread — the "full lesson" surface. Renders a multi-line
  // Comment Thread bubble between code lines when the user asks for depth.
  // Wired into the hover's "Teach me more" button and the ⌘. keybinding.
  // See Architecture/unified-teaching-surfaces-plan.md.
  const teachingThreadDisposables = registerTeachingThread(context);
  // Smart Fix — replaces the pre-stored `fix` string with a fresh Haiku
  // round-trip when the user clicks Fix. Better quality, worth the ~1s
  // and ~$0.0001 per click.
  const smartFixDisposables = registerSmartFix(context);
  // Inline lesson comment temporarily disabled — too much chrome
  // stacked above the finding line per user feedback. Hover + voice
  // carries the lesson now.
  const lessonCommentDisposables: vscode.Disposable[] = [];

  // ===== Tiered scan pipeline =====
  // LIVE (2s debounce, active file) — already in liveReview.ts
  // SAVE (on save, file + 1-hop neighbors) — saveScan.ts, block + flow scope
  // IDLE (≥30s no activity, workspace cluster) — flowScan.ts, flow scope only
  // The workspace index is the substrate SAVE + IDLE sit on.
  // Diagnostics mirror block/flow findings for native Problems-panel nav.
  const workspaceIndexDisposables = registerWorkspaceIndex(context);
  const saveScanDisposables = registerSaveScan(context);
  const flowScanDisposables = registerFlowScan(context);
  const findingDiagnosticsDisposables = registerFindingDiagnostics(context);

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
    ...whisperDisposables,
    ...ghostDisposables,
    ...teachingThreadDisposables,
    ...smartFixDisposables,
    ...lessonCommentDisposables,
    ...workspaceIndexDisposables,
    ...saveScanDisposables,
    ...flowScanDisposables,
    ...findingDiagnosticsDisposables,
    ...didYouKnowDisposables,
    ...findingHoverDisposables,
    registerInsetWizardCommand(context),
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
    // `protege.teachConcept` is invoked by the Ghost Lens "Explain" button,
    // the Whisper hover "Learn" link, and assorted command-palette flows.
    // It used to live in peekTeach.ts — when we paused that module the
    // command stopped being registered, so every "Explain" click hit a
    // "command not found" error. Handler: open the sidebar and auto-send
    // a teaching question so the user sees a reply in chat.
    vscode.commands.registerCommand(
      "protege.teachConcept",
      async (concept: unknown) => {
        const conceptName =
          typeof concept === "string" && concept.trim() ? concept.trim() : null;
        await openProtegePanel(context);
        if (!conceptName) return;
        // Give the webview a beat to mount before broadcasting.
        setTimeout(() => {
          broadcast({
            type: "chat/autoSend",
            message: `Teach me about \`${conceptName}\` in the context of the file I have open. One paragraph on why it matters, one tiny snippet, and one probing question. Keep it under 150 words.`,
          });
        }, 250);
      }
    ),
    vscode.commands.registerCommand("protege.toggleAutoAcceptEdits", async () => {
      const cfg = vscode.workspace.getConfiguration("protege");
      const current = cfg.get<boolean>("autoAcceptEdits", false);
      await cfg.update(
        "autoAcceptEdits",
        !current,
        vscode.ConfigurationTarget.Global
      );
      vscode.window.showInformationMessage(
        `Protege auto-accept edits: ${!current ? "ON — AI edits apply without asking" : "OFF — every edit shows a preview"}`
      );
    }),
    vscode.commands.registerCommand("protege.showLogs", async () => {
      const { showLogs } = await import("./log.js");
      showLogs();
    }),
    vscode.commands.registerCommand("protege.toggleMaxPlanBackend", async () => {
      // Max Plan quick switch — flips the AI backend between Qwen 7B
      // (on-device) and Haiku cloud. For A/B testing the two engines
      // in the Max tier without leaving the editor.
      const { getAiBackend, setAiBackend } = await import("./aiBackend.js");
      const current = getAiBackend();
      const next = current === "on-device" ? "haiku" : "on-device";
      setAiBackend(next);
      broadcast({ type: "ai/backend", backend: next });
      vscode.window.showInformationMessage(
        next === "on-device"
          ? "Protege: switched to Qwen 7B (on-device)"
          : "Protege: switched to Haiku 4.5 (cloud)"
      );
    }),
    vscode.commands.registerCommand("protege.toggleVoiceExplain", async () => {
      const cfg = vscode.workspace.getConfiguration("protege");
      const order = ["text", "voice", "both"] as const;
      const current = (cfg.get<string>("explainMode", "text") as typeof order[number]) ?? "text";
      const nextIdx = (order.indexOf(current) + 1) % order.length;
      const next = order[nextIdx];
      await cfg.update("explainMode", next, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(
        `Protege Explain mode: ${next.toUpperCase()} — click the Ghost Lens "Explain" to try it.`
      );
    }),
    vscode.commands.registerCommand("protege.toggleFlowScan", async () => {
      const cfg = vscode.workspace.getConfiguration("protege");
      const current = cfg.get<boolean>("flowScanEnabled", false);
      await cfg.update(
        "flowScanEnabled",
        !current,
        vscode.ConfigurationTarget.Global
      );
      vscode.window
        .showInformationMessage(
          `Protege flow scan: ${!current ? "ON — cross-file insights while you idle. Reload to activate." : "OFF. Reload to fully disable."}`,
          "Reload window"
        )
        .then((pick) => {
          if (pick === "Reload window") {
            vscode.commands.executeCommand("workbench.action.reloadWindow");
          }
        });
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
    }),
    vscode.commands.registerCommand("protege.calibrateWakeWord", async () => {
      try {
        await runWakeCalibration(context);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === "cancelled") return;
        vscode.window.showErrorMessage(`Wake word calibration failed: ${msg}`);
      }
    }),
    vscode.commands.registerCommand("protege.restartWakeListener", async () => {
      const wasActive = isWakeWordListening();
      if (wasActive) stopWakeWordListener();
      if (wasActive) {
        // Webviews listen for `wake/toggle`; easiest way to restart with the
        // new threshold is to let the user click the mic again. Surface a
        // hint rather than re-plumbing the toggle from here.
        vscode.window.showInformationMessage(
          "Wake listener stopped. Click the mic in the Protege panel to restart with your new threshold."
        );
      } else {
        vscode.window.showInformationMessage(
          "Wake listener wasn't running — next time you start it, the new threshold will apply."
        );
      }
    })
  );

  // First-run wake-word calibration prompt. Only shown once per user, and only
  // if they haven't calibrated. Non-blocking — user can dismiss and calibrate
  // later via the command palette.
  if (!hasCompletedWakeCalibration(context)) {
    setTimeout(async () => {
      const choice = await vscode.window.showInformationMessage(
        "Protege can calibrate its wake word to your voice — 30 seconds, improves detection accuracy. Want to do it now?",
        "Calibrate",
        "Later"
      );
      if (choice === "Calibrate") {
        await vscode.commands.executeCommand("protege.calibrateWakeWord");
      }
    }, 3000);
  }

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
