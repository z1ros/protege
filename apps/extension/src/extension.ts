import * as vscode from "vscode";
import { exec } from "node:child_process";
import type { MeResponse, HostToWebview } from "@protege/types";
import { openProtegePanel } from "./panel.js";
import { LauncherProvider, updateLauncherStats } from "./launcher.js";
import { registerAnalyzer } from "./review/analyzer.js";
import { FindingCodeLensProvider } from "./review/codeLens.js";
import { broadcast, pushTeachFinding, toggleGlobalWake } from "./chat/webviewHost.js";
import { registerHighlightCodeLens } from "./ai/tools.js";
import { registerDidYouKnowCodeLens } from "./hints/didYouKnow.js";
import { getUserId, fetchMe } from "./user/protegeClient.js";
import { initActiveFileTracker } from "./workspace/activeFile.js";
import { startWatcher, type DispatchedNudge } from "./watcher/index.js";
// Editor-surface UI modules paused — imports removed so the bundle doesn't
// carry them while we redesign:
//   inlineErrors, peekTeach, didYouKnow, findingHover
// Live review still loads because its scan pipeline feeds the sidebar data.
import { registerLiveReview } from "./review/liveReview.js";
import { registerStatusBarLive, updateStatusBarData } from "./review/statusBarLive.js";
import { registerUnderlineWhisper } from "./hints/underlineWhisper.js";
import { registerGhostMentor } from "./hints/ghostMentor.js";
import { registerFileOpenGreeter } from "./hints/fileOpenGreeter.js";
import { registerPatternSpotter } from "./detection/patternSpotter.js";
import { registerStruggleChip, showStruggleChip } from "./hints/struggleChip.js";
import { registerSaveRecap } from "./detection/saveRecap.js";
import { registerConceptTrail } from "./concepts/conceptTrail.js";
import { dispatchTeachConcept } from "./teaching/teachConceptDispatch.js";
import { registerInsetExperiment } from "./hints/insetExperiment.js";
import { registerFindingGate } from "./review/findingGate.js";
import { registerProjectMap } from "./workspace/projectMap.js";
import { registerArchitectureTour } from "./teaching/architectureTour.js";
import { registerExplainBack } from "./teaching/explainBack.js";
import { registerLearningMode, getLatestTrace } from "./teaching/learningMode.js";
import { installChangeOriginDetector, onChangeOrigin } from "./detection/changeOriginDetector.js";
import { installOwnership, recordChange as recordOwnershipChange, onOwnershipChanged, getOwnership } from "./user/ownership.js";
import { registerOwnershipInviter } from "./user/ownershipInviter.js";
import { registerTeachingThread } from "./teaching/teachingThread.js";
import { registerSmartFix } from "./review/smartFix.js";
import { registerErrorLineHighlight } from "./review/errorLineHighlight.js";
import { registerSelectionHover } from "./hints/selectionHover.js";
import { registerPredict } from "./detection/predict.js";
import { registerMisconceptions } from "./concepts/misconceptions.js";
// Vibecode Brief comment thread retired 2026-04-22 — replaced by the
// ambient AI-block highlighter (see hints/aiBlocks.ts), which treats
// vibecoded regions as browsable artifacts instead of popping a
// comment thread after every burst. File kept on disk in case we
// want to revive the thread-style surface later.
import { registerVibeBrief } from "./hints/vibeBrief.js";
import { registerAiBlocks } from "./hints/aiBlocks.js";
// Inline lesson comment surface (the big `/* PROTEGE · ... */` block) is
// disabled — too much visual chrome stacked above the finding line.
// Teach now shows the hover popup + plays voice instead. The module
// stays in tree to make re-enabling a one-line change.
// import { registerInlineLessonComment } from "./hints/inlineLessonComment.js";
import { registerWorkspaceIndex } from "./workspace/workspaceIndex.js";
// SAVE and IDLE scan tiers retired 2026-04-23 — kept registerFindingDiagnostics
// so any surviving block/flow findings (from cache) still surface natively.
import { registerFindingDiagnostics } from "./review/findingDiagnostics.js";
import { registerInsetWizardCommand } from "./hints/insetWizard.js";
import { registerCommands } from "./commands/index.js";
import { registerTeachPopup } from "./teaching/teachPopup.js";
import { registerTeachingFlow } from "./teaching/teachingFlow.js";
import { registerOnDeviceModel } from "./ai/onDeviceModel.js";
import { initAiBackend, onBackendCall } from "./ai/aiBackend.js";
import { registerExerciseEngine } from "./teaching/exerciseEngine.js";
import { initChatHistory, disposeChatHistory } from "./chat/chatHistory.js";
import { runWakeCalibration, hasCompletedWakeCalibration, getWakeEnabled as getWakeEnabledFor } from "./voice/wakeWordCalibration.js";
import { stopWakeWordListener, isWakeWordListening } from "./voice/voiceCapture.js";
import { registerVoiceStatusBar, setVoiceState } from "./voice/voiceStatusBar.js";

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

  // Broadcast the current `protege.explainMode` so the Live tab's 3-option
  // toggle (Text / Voice / Both) hydrates with the authoritative value
  // instead of guessing. Re-broadcast on any config change so a tweak in
  // settings.json (or via the toggle itself) reflects across every mounted
  // panel within one keystroke.
  const readExplainMode = () => {
    const v = vscode.workspace
      .getConfiguration("protege")
      .get<string>("explainMode", "text");
    return (v === "voice" || v === "both" ? v : "text") as "text" | "voice" | "both";
  };
  broadcast({ type: "explainMode/state", mode: readExplainMode() });
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("protege.explainMode")) return;
      broadcast({ type: "explainMode/state", mode: readExplainMode() });
    })
  );

  // ===== Status bar (context-aware, JARVIS Layer 4) =====
  const statusBarDisposables = registerStatusBarLive(context);

  // Voice state chip in the status bar — visible even when the sidebar
  // is closed, so the user always knows whether Protege is listening /
  // thinking / speaking. State is driven by webviewHost when wake events
  // or TTS playback events fire.
  const voiceStatusDisposables = registerVoiceStatusBar(context);
  // Initial state: off until we confirm wake is enabled.
  setVoiceState(getWakeEnabledFor(context) ? "idle" : "off");

  // ===== Diagnostics + CodeLens =====
  const diagnostics = vscode.languages.createDiagnosticCollection("protege");
  // FindingCodeLensProvider (the "Ask Protege" CodeLens above finding lines)
  // is paused while we redesign editor-surface UX. Instantiated but never
  // registered — `refresh()` is a safe no-op if anything still calls it.
  const codeLens = new FindingCodeLensProvider();
  const codeLensSub: vscode.Disposable = new vscode.Disposable(() => {});

  // HighlightCodeLensProvider renders the "Apply fix · Teach me · Dismiss"
  // row ABOVE any line Protege has highlighted via the highlight_code tool.
  // Replaces the old right-side italic `← <tag>` inline after-decoration —
  // now the primary action surface is the CodeLens; the hover stays as the
  // deeper-detail tooltip on mouseover.
  const highlightLensSub = registerHighlightCodeLens();
  context.subscriptions.push(highlightLensSub);
  // Did-You-Know tip row above the line — replaces the old right-side
  // `💡 tip` after-decoration so the Learn more / Dismiss actions are
  // always visible, not buried behind a mouseover.
  const dykLensSub = registerDidYouKnowCodeLens();
  context.subscriptions.push(dykLensSub);

  // ===== Analyzer (file save → concepts + bugs + IQ update) =====
  const analyzer = registerAnalyzer(
    context,
    diagnostics,
    (me) => {
      updateStatusBarData({ codeIq: me.codeIq, streakDays: me.streak.current, totalConcepts: me.totalConcepts });
      updateLauncherStats({ codeIq: me.codeIq, maxIq: me.maxIq, streakDays: me.streak.current, totalConcepts: me.totalConcepts });
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
    const shared: import("@protege/types").UnpromptedNudge = {
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
    };

    // In-flow first: if the nudge has a file + line anchor, show the
    // Struggle Chip above that line instead of yanking the user into
    // the sidebar. Sidebar opens ONLY when the user clicks "Learn more"
    // on the chip's hint. This is the #1 learn-in-flow fix — see
    // ~/.claude/plans/learn-in-flow-audit.md Move 1.
    const anchored = showStruggleChip(shared);

    // Broadcast to the webview so the sidebar Live tab / chat history
    // still reflects the nudge if it's open. Crucially we NO LONGER
    // call openProtegePanel() — the sidebar only opens on explicit
    // user action (chip "Learn more" click, or legacy `engage` path).
    broadcast({ type: "watcher/nudge", nudge: shared });

    if (!anchored) {
      // Unanchored nudges (no file+line) can't get a chip. They stay
      // passive in the sidebar state for now — we still don't force it
      // open. If that hurts discoverability for triggers like
      // `late_night` or `flow_state`, we'll revisit with a status-bar
      // surface or ambient chip.
    }
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
  //
  // Register the finding gate FIRST so its listeners (document change,
  // selection change) are wired before the surface providers subscribe
  // to `onGateChanged`. See ~/.claude/plans/finding-gate-a1-b1.md.
  const findingGateDisposables = registerFindingGate(context);
  // Project Map (A1) — binds `context` so the file-summary cache can
  // write to globalState. No listeners/commands; the webview tab
  // requests data on demand via `map/*` messages in webviewHost.ts.
  const projectMapDisposables = registerProjectMap(context);
  // Architecture Tour (A2) — guided walk through 5 key files. We pass
  // `broadcast` through so the orchestrator can push `tour/state` +
  // `tour/narrationReady` messages without taking a dependency on
  // webviewHost (avoids the cycle).
  const architectureTourDisposables = registerArchitectureTour(
    context,
    (msg) => broadcast(msg as Parameters<typeof broadcast>[0])
  );
  // Explain-back (B1) — reverse teaching. User selects code, narrates,
  // Haiku grades. Same broadcaster pattern as the tour.
  const explainBackDisposables = registerExplainBack(context, (msg) =>
    broadcast(msg as Parameters<typeof broadcast>[0])
  );
  // Learning Mode — user types a goal, Protege generates a step-by-step
  // plan, user writes each step, validator LLM checks. Same broadcaster
  // pattern as explainBack. Command: `protege.learning.start` (⌘K L).
  const learningModeDisposables = registerLearningMode(context, (msg) =>
    broadcast(msg as Parameters<typeof broadcast>[0])
  );

  // Export the most recent Learning Mode session trace (raw plan +
  // every validator call + reveal events) to disk, and put the path
  // on the clipboard. Lets you audit Haiku's output without tailing
  // the Output channel. See plans/create-a-plan-how-buzzing-walrus.md.
  context.subscriptions.push(
    vscode.commands.registerCommand("protege.learning.exportSession", async () => {
      const trace = getLatestTrace();
      if (!trace) {
        vscode.window.showInformationMessage(
          "No completed Learning Mode session to export. Finish (or stop) a session first."
        );
        return;
      }
      const os = await import("node:os");
      const fs = await import("node:fs");
      const pathMod = await import("node:path");
      const dir = pathMod.join(os.homedir(), ".protege", "learning-sessions");
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (err) {
        vscode.window.showErrorMessage(
          `Protege: couldn't create ${dir} — ${err instanceof Error ? err.message : String(err)}`
        );
        return;
      }
      const slug = trace.goal
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48) || "session";
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const filePath = pathMod.join(dir, `${ts}-${slug}.json`);
      try {
        fs.writeFileSync(filePath, JSON.stringify(trace, null, 2));
      } catch (err) {
        vscode.window.showErrorMessage(
          `Protege: couldn't write ${filePath} — ${err instanceof Error ? err.message : String(err)}`
        );
        return;
      }
      await vscode.env.clipboard.writeText(filePath);
      vscode.window.showInformationMessage(
        `Trace saved — path on clipboard. ${filePath}`
      );
    })
  );
  // ===== Code Ownership (vibecoding partnership) =====
  // changeOriginDetector  — classifies every text edit as typed /
  //                         auto-inserted / mixed, based on burst + pace.
  // ownership             — persistence + region merging + markExplained.
  // ownershipInviter      — status-bar nudge at natural breaks.
  // The three wire together: detector emits → ownership records →
  // breakDetector fires at idle / save-clean / commit → inviter offers.
  // Explain-back's markExplained integration raises ownership back up.
  installOwnership(context);
  const changeOriginDisposable = installChangeOriginDetector();
  const isAutoTrackingEnabled = () =>
    vscode.workspace
      .getConfiguration("protege")
      .get<boolean>("ownership.autoTrackingEnabled", true);
  const changeOriginSub = onChangeOrigin((evt) => {
    if (!isAutoTrackingEnabled()) return;
    if (evt.origin === "typed" || evt.origin === "auto-inserted") {
      recordOwnershipChange(evt.uri, evt.startLine, evt.endLine, evt.origin);
    } else if (evt.origin === "mixed") {
      // Treat mixed as auto-inserted for tracking — safer to over-prompt
      // than miss a true paste.
      recordOwnershipChange(evt.uri, evt.startLine, evt.endLine, "auto-inserted");
    }
  });
  // Broadcast ownership changes to any mounted webview so the map tab
  // can refresh without a full re-request.
  const ownershipChangedSub = onOwnershipChanged((uriStr) => {
    try {
      const uri = vscode.Uri.parse(uriStr);
      const summary = getOwnership(uri);
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
      const rel = root && uri.fsPath.startsWith(root)
        ? uri.fsPath.slice(root.length + 1).split(/[\\/]/).join("/")
        : uri.fsPath;
      broadcast({ type: "ownership/changed", path: rel, summary });
    } catch {
      /* ignore */
    }
  });
  const ownershipInviterDisposables = registerOwnershipInviter(context);
  const whisperDisposables = registerUnderlineWhisper(context);
  const ghostDisposables = registerGhostMentor(context);
  // File-Open Greeter — fires a 2-sentence voice overview the first time
  // the user opens each file. Silence is fine; `SKIP` is a valid reply.
  // See Architecture plan in ~/.claude/plans/also-chekc-our-wondrous-blum.md.
  const fileOpenGreeterDisposables = registerFileOpenGreeter(context);
  // Proactive Pattern Spotter — after long activity + a pause, surfaces
  // ONE learning-moment pitch as a native notification. Silence-biased;
  // 15min cooldown, 24h per-concept dedup.
  const patternSpotterDisposables = registerPatternSpotter(context);
  // Struggle Chip — watcher nudges now render as a CodeLens row above
  // the friction line instead of force-opening the sidebar. The
  // registered command fetches a 2-sentence hint; "Learn more" is the
  // ONLY path to the sidebar. See ~/.claude/plans/learn-in-flow-audit.md.
  const struggleChipDisposables = registerStruggleChip(context, () => {
    openProtegePanel(context);
  });
  // Save-time retrospective recap — on each save, render a 4s status-bar
  // toast summarizing concepts newly appearing since last save. Positive
  // reinforcement at a natural break, no interrupt. Move 2 of
  // ~/.claude/plans/learn-in-flow-audit.md.
  const saveRecapDisposables = registerSaveRecap(context);
  // Concept Trail — subtle blue gutter dot on the first line where a
  // new-this-session concept appears. Purely peripheral, no voice, no
  // popup. Hover → a small Markdown card with a "Teach me" link.
  // Move 4 of ~/.claude/plans/learn-in-flow-audit.md.
  const conceptTrailDisposables = registerConceptTrail(context);
  // Inset Preview — EXPERIMENTAL alternative to the Ghost Mentor
  // CodeLens. Opt-in via command "Protege: Preview inset-style finding
  // (experimental)". Does NOT replace the CodeLens; both surfaces
  // coexist so the user can A/B them. Uses the `editorInsets` proposed
  // API (already enabled in package.json).
  const insetExperimentDisposables = registerInsetExperiment(context);
  // Teaching Thread — the "full lesson" surface. Renders a multi-line
  // Comment Thread bubble between code lines when the user asks for depth.
  // Wired into the hover's "Teach me more" button and the ⌘. keybinding.
  // See Architecture/unified-teaching-surfaces-plan.md.
  const teachingThreadDisposables = registerTeachingThread(context);
  // Smart Fix — replaces the pre-stored `fix` string with a fresh Haiku
  // round-trip when the user clicks Fix. Better quality, worth the ~1s
  // and ~$0.0001 per click.
  const smartFixDisposables = registerSmartFix(context);
  // Error-line highlight — subtle white wash on every line with an error
  // diagnostic (TS/ESLint/Protege). Ambient; no AI calls, no commands.
  const errorLineHighlightDisposables = registerErrorLineHighlight();
  // Selection Hover — when the user highlights code, auto-open a tiny
  // popup with [◎ Explain · ✿ Teach me · ✿ Explain back]. Matches the
  // vibe of Cursor's floating "Add to Chat" bar but carries Protege's
  // actions. Also summonable via Cmd+K S on the current selection.
  const selectionHoverDisposables = registerSelectionHover(context);
  // Predict-and-Reveal — forced-prediction learning loop. User triggers
  // via Cmd+K P or the selection hover; Protege generates a 4-choice
  // quiz about a non-obvious behavior of the code. Reveal shows the
  // answer + reason. "Got it" raises ownership on the reasoned range.
  // Day 1: scaffold + hardcoded dummy quiz. LLM lands Day 2.
  const predictDisposables = registerPredict(context);
  // Misconception Catcher — scans freshly-inserted vibecoded code
  // against a small library of rules that flag SPECIFIC wrong mental
  // models (await inside map runs parallel, JSON.parse+stringify loses
  // Map/Set, .sort mutates, …). Flagged lines get an amber left-border
  // decoration + a hover with [? Quiz me / ✿ Show fix / ✕ Dismiss].
  // Pull, not push — the decoration is silent, the hover opens only
  // when the user mouses over.
  const misconceptionsDisposables = registerMisconceptions(context);
  // Vibecode briefing retired 2026-04-22 — replaced by aiBlocks below.
  // Keeping the variable as an empty disposable array so existing
  // subscription spreads compile unchanged.
  const vibeBriefDisposables: vscode.Disposable[] = [];
  // AI Block Highlighter — every unreviewed auto-inserted region (from
  // ownership.ts) gets a subtle blue wash + a `◎ <summary> · ✿ Teach
  // me this block` CodeLens at its top line. Click → hover with What /
  // One thing to know / Got it / Tell me more / Dismiss. Replaces the
  // intrusive comment-thread briefing with a browsable ambient artifact.
  const aiBlocksDisposables = registerAiBlocks(context);
  // Inline lesson comment temporarily disabled — too much chrome
  // stacked above the finding line per user feedback. Hover + voice
  // carries the lesson now.
  const lessonCommentDisposables: vscode.Disposable[] = [];

  // ===== Scan pipeline =====
  // LIVE only — fires 3s after typing stops on the active file.
  // SAVE + IDLE tiers retired; they fired too rarely to be worth the code
  // path, and the user wanted LIVE to do the heavy lifting anyway.
  // The workspace index is kept because other features (teachConcept,
  // architectureTour) still consume it.
  const workspaceIndexDisposables = registerWorkspaceIndex(context);
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
    ...findingGateDisposables,
    ...projectMapDisposables,
    ...architectureTourDisposables,
    ...explainBackDisposables,
    ...learningModeDisposables,
    changeOriginDisposable,
    changeOriginSub,
    ownershipChangedSub,
    ...ownershipInviterDisposables,
    ...whisperDisposables,
    ...ghostDisposables,
    ...fileOpenGreeterDisposables,
    ...patternSpotterDisposables,
    ...struggleChipDisposables,
    ...saveRecapDisposables,
    ...conceptTrailDisposables,
    ...insetExperimentDisposables,
    ...teachingThreadDisposables,
    ...smartFixDisposables,
    ...errorLineHighlightDisposables,
    ...selectionHoverDisposables,
    ...predictDisposables,
    ...misconceptionsDisposables,
    ...vibeBriefDisposables,
    ...aiBlocksDisposables,
    ...lessonCommentDisposables,
    ...workspaceIndexDisposables,
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
    // Status bar voice chip fires this; webview's "Protege ON" chip also
    // fires this (via wake/toggle message). Both paths update all
    // mounted webviews + the status bar via broadcast + setVoiceState.
    vscode.commands.registerCommand("protege.toggleWake", () =>
      toggleGlobalWake(context, getUserId(context))
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
      // Route based on `protege.explainMode` — voice plays a short
      // spoken explanation (no big chat reply), text sends a full chat
      // request, "both" does both. See teachConceptDispatch.ts.
      async (concept: unknown) => {
        await dispatchTeachConcept(concept, context);
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
      const { getAiBackend, setAiBackend } = await import("./ai/aiBackend.js");
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
    // toggleFlowScan removed — IDLE scan tier retired 2026-04-23.
    vscode.commands.registerCommand("protege.refreshIQ", async () => {
      try {
        const me = await fetchMe(getUserId(context));
        updateStatusBarData({ codeIq: me.codeIq, streakDays: me.streak.current, totalConcepts: me.totalConcepts });
      updateLauncherStats({ codeIq: me.codeIq, maxIq: me.maxIq, streakDays: me.streak.current, totalConcepts: me.totalConcepts });
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
      const { clearAllHighlights } = await import("./ai/tools.js");
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
          const { clearAllHighlights } = await import("./ai/tools.js");
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

  // Start the wake-word listener on activate — not just when a webview
  // mounts. This lets `Protege` work even if the user closes the sidebar:
  // the Rust binary keeps running in the extension host, and when a wake
  // fires we auto-reveal the panel to play audio. Default threshold is
  // used when the user hasn't calibrated yet — wake still works, just
  // at the generic 0.13 tuning.
  if (getWakeEnabledFor(context)) {
    setTimeout(() => {
      import("./chat/webviewHost.js").then((mod) => {
        void mod.startGlobalWakeListener(context, getUserId(context));
      });
    }, 800);
  }
}

// Old updateStatusBar removed — replaced by statusBarLive.ts

export function deactivate() {}
