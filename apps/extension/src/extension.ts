import * as vscode from "vscode";
import { exec } from "node:child_process";
import type { MeResponse, HostToWebview } from "@protege/types";
import { openProtegePanel } from "./panel.js";
import { LauncherProvider, updateLauncherStats, updateLauncherAuth } from "./launcher.js";
import { getAuthSnapshot } from "./user/authState.js";
import { registerAnalyzer } from "./review/analyzer.js";
import { FindingCodeLensProvider } from "./review/codeLens.js";
import { broadcast, pushTeachFinding, toggleGlobalWake } from "./chat/webviewHost.js";
import { isSignedIn, getCachedGitHubUser, installAuthSessionListener, onAuthChange, getGitHubUser, bindAuthOptOutContext, isOptedOut } from "./user/auth.js";
import { registerHighlightCodeLens } from "./ai/tools.js";
import { registerDidYouKnowCodeLens, registerDidYouKnow } from "./hints/didYouKnow.js";
import { setTipCachePersistence } from "./ai/aiExplain.js";
import { gated } from "./settings/featureFlags.js";
import { fetchMe, currentUserIdOrNull } from "./user/protegeClient.js";
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
import { registerStruggleChip, showStruggleChip } from "./hints/struggleChip.js";
import { registerSaveRecap } from "./detection/saveRecap.js";
import { registerConceptTrail } from "./concepts/conceptTrail.js";
import { dispatchTeachConcept } from "./teaching/teachConceptDispatch.js";
import { registerInsetExperiment } from "./hints/insetExperiment.js";
import { registerFindingGate } from "./review/findingGate.js";
// Project Map tab retired 2026-04-23 — Map removed from the header
// nav. Module kept on disk; not imported.
// import { registerProjectMap } from "./workspace/projectMap.js";
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
import { initAiBackend, onBackendCall } from "./ai/aiBackend.js";
import { registerExerciseEngine } from "./teaching/exerciseEngine.js";
import { initChatHistory, disposeChatHistory } from "./chat/chatHistory.js";
import { initNotesStore } from "./notes/notesStore.js";
import { runWakeCalibration, shouldShowCalibrationPrompt, recordCalibrationPromptDeferred, getWakeEnabled as getWakeEnabledFor } from "./voice/wakeWordCalibration.js";
import { stopWakeWordListener, isWakeWordListening } from "./voice/voiceCapture.js";
import { registerVoiceStatusBar, setVoiceState } from "./voice/voiceStatusBar.js";
import { registerHostAudioCleanup } from "./voice/hostAudio.js";
import { initEcho, openEchoPanel, getEventStreamChannel } from "./echo/index.js";
// File Walk retired 2026-04-28 — sticky sidebar view + status-bar
// shortcut + webview provider all removed. Module kept on disk;
// re-enable by restoring this import, the registerFileWalk() call,
// the WalkViewProvider import + registerWebviewViewProvider, the
// fileWalkDisposables push, and the package.json view registration.
// import { registerFileWalk } from "./walk/fileWalk.js";
// import { WalkViewProvider } from "./walk/walkView.js";

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

  // Persist the opt-out flag against this extension's globalState so the
  // signOut helper can survive restarts. MUST happen before the warmup
  // probe so the probe respects the flag.
  bindAuthOptOutContext(context);

  // Warm up the GitHub session cache BEFORE anything else runs. VS Code
  // returns the existing signed-in session silently with
  // createIfNone: false; no OAuth dialog. Login-first: when the warmup
  // returns null we stay in the signed-out state and every backend-touching
  // surface short-circuits until the user signs in via the webview gate.
  //
  // If the user explicitly signed out earlier, skip the silent warmup
  // entirely — otherwise VS Code's still-cached GitHub session would
  // re-hydrate Protege right back to signed-in on every reload.
  if (!isOptedOut()) {
    try {
      await getGitHubUser(false);
    } catch {
      // Non-fatal — user will sign in later via the webview prompt.
    }
  }

  // Wire VS Code's session-change event so an external sign-out (from the
  // accounts UI) propagates to our auth state and the gate re-renders.
  installAuthSessionListener(context);

  // One-time chore: drop the abandoned per-machine UUID from globalState.
  // It's never reused; lingering writes are confusing during debugging.
  void context.globalState.update("protege.userId", undefined);

  const initialUser = getCachedGitHubUser();
  logLine(
    "extension",
    initialUser
      ? `activated — user ${initialUser.githubId} (${initialUser.login})`
      : `activated — signed out (login-first gate active)`
  );

  // ===== Chat history persistence =====
  initChatHistory(context);

  // ===== Notes tab persistence =====
  initNotesStore(context);

  // ===== Echo — behavior observation dashboard (infrastructure layer) =====
  // Starts the batcher, session tracker, line differ, paste classifier, and
  // git commit watcher. Widget agents will fill in visualizations against
  // the data these subsystems produce.
  //
  // Login-first: pass null when signed-out — every subsystem buffers locally
  // and only posts when the user signs in (see batcher.ts auth gate).
  initEcho(context, currentUserIdOrNull(), output);

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
    }),
    // Mirror the Live Review master-switch to all mounted webviews so
    // the Live tab can bop a red attention dot when it's OFF. Toggling
    // the setting (Settings UI or palette) updates the dot in real time.
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("protege.codeReview.liveReview")) return;
      const enabled =
        vscode.workspace
          .getConfiguration("protege")
          .get<boolean>("codeReview.liveReview", true) !== false;
      broadcast({ type: "liveReview/enabled", enabled });
    })
  );

  // ===== Status bar (context-aware, JARVIS Layer 4) =====
  const statusBarDisposables = [
    gated("codeReview.statusBar", () => registerStatusBarLive(context)),
  ];

  // Voice state chip in the status bar — visible even when the sidebar
  // is closed, so the user always knows whether Protege is listening /
  // thinking / speaking. State is driven by webviewHost when wake events
  // or TTS playback events fire.
  const voiceStatusDisposables = registerVoiceStatusBar(context);
  registerHostAudioCleanup(context);
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
  // Hard-coupled to the highlight system: whenever a highlight paints, the
  // lens must show — otherwise the user has no clickable affordance for the
  // fix/teach actions.
  context.subscriptions.push(registerHighlightCodeLens());
  // Did-You-Know tip row above the line — replaces the old right-side
  // `💡 tip` after-decoration so the Learn more / Dismiss actions are
  // always visible, not buried behind a mouseover.
  // Did You Know? — the lens renderer + the idle/file-switch/save
  // triggers are gated together. Without registerDidYouKnow the lens
  // is a dead shell; without registerDidYouKnowCodeLens the triggers
  // produce activeTip state but nothing renders. Bind them as a unit.
  context.subscriptions.push(
    gated("teaching.didYouKnow", () => [
      registerDidYouKnowCodeLens(),
      ...registerDidYouKnow(context),
    ])
  );
  // Hydrate the tip-text cache from globalState so a fresh session
  // starts warm. The cache itself lives in ai/aiExplain.ts.
  setTipCachePersistence(context);

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

  // Feed the launcher current + future auth state so the sidebar swaps
  // between the normal entry point and a "Sign in with GitHub" CTA.
  // Without this the launcher silently shows the stats card even after
  // the user denies the OAuth dialog, leaving them with no obvious way
  // to retry. Seeding with the current snapshot covers the case where
  // the silent session probe has already resolved before activate()
  // got here.
  updateLauncherAuth(getAuthSnapshot());
  context.subscriptions.push(
    new vscode.Disposable(onAuthChange((snap) => updateLauncherAuth(snap)))
  );

  // Re-hydrate notes + chat history from Supabase on sign-in. The
  // initial activation hydrate fires whether or not the user is signed
  // in; if they sign in MID-SESSION (clicking the gate), we want their
  // cloud-stored notes/chat to load right then, not at next reload.
  context.subscriptions.push(
    new vscode.Disposable(
      onAuthChange((snap) => {
        if (snap.state !== "signed-in" || !snap.user) return;
        void (async () => {
          const notes = await import("./notes/notesStore.js");
          notes.rehydrateNotes();
          const chat = await import("./chat/chatHistory.js");
          chat.rehydrateChatHistory();
        })();
      })
    )
  );

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
  const liveReviewDisposables = [
    gated("codeReview.liveReview", () => registerLiveReview(context)),
  ];

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
  const whisperDisposables = [
    gated("codeReview.underlineWhispers", () => registerUnderlineWhisper(context)),
  ];
  const ghostDisposables = [
    gated("teaching.ghostMentor", () => registerGhostMentor(context)),
  ];
  // File-Open Greeter retired 2026-04-26. The voice-intro surface fired
  // a 700-1200 token LLM call on every tab switch to play a generic
  // 2-sentence file synopsis through TTS. Cost was disproportionate to
  // the value — narration is not mentor guidance. The file-open moment
  // is still served by the cross-user concept-tips path (didYouKnow.ts)
  // and Live Review's per-line findings. Module file kept on disk in
  // case we revive any of its sub-features (ownership-aware nudge, voice
  // overview command) under a redesign.
  // Pattern Spotter retired 2026-04-30 — the proactive idle-time
  // notification ("Teach me / Not now" popup) was nag-equivalent and the
  // user explicitly asked never to surface dialogs that fire without a
  // direct action. Module file kept on disk in case we revive it as a
  // non-popup surface (gutter dot, status-bar chip) later.
  const patternSpotterDisposables: vscode.Disposable[] = [];
  // Struggle Chip — watcher nudges now render as a CodeLens row above
  // the friction line instead of force-opening the sidebar. The
  // registered command fetches a 2-sentence hint; "Learn more" is the
  // ONLY path to the sidebar. See ~/.claude/plans/learn-in-flow-audit.md.
  const struggleChipDisposables = [
    gated("teaching.struggleChip", () =>
      registerStruggleChip(context, () => {
        openProtegePanel(context);
      })
    ),
  ];
  // Save-time retrospective recap — on each save, render a 4s status-bar
  // toast summarizing concepts newly appearing since last save. Positive
  // reinforcement at a natural break, no interrupt. Move 2 of
  // ~/.claude/plans/learn-in-flow-audit.md.
  const saveRecapDisposables = [
    gated("recap.saveRecap", () => registerSaveRecap(context)),
  ];
  // Concept Trail — subtle blue gutter dot on the first line where a
  // new-this-session concept appears. Purely peripheral, no voice, no
  // popup. Hover → a small Markdown card with a "Teach me" link.
  // Move 4 of ~/.claude/plans/learn-in-flow-audit.md.
  const conceptTrailDisposables = [
    gated("recap.conceptTrail", () => registerConceptTrail(context)),
  ];
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
  const smartFixDisposables = [
    gated("codeReview.smartFix", () => registerSmartFix(context)),
  ];
  // Error-line highlight — subtle white wash on every line with an error
  // diagnostic (TS/ESLint/Protege). Ambient; no AI calls, no commands.
  const errorLineHighlightDisposables = [
    gated("codeReview.errorLineHighlight", () => registerErrorLineHighlight()),
  ];
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

  // File Walk retired 2026-04-28 — see top-of-file note.

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
    ...architectureTourDisposables,
    ...explainBackDisposables,
    ...learningModeDisposables,
    changeOriginDisposable,
    changeOriginSub,
    ownershipChangedSub,
    ...ownershipInviterDisposables,
    ...whisperDisposables,
    ...ghostDisposables,
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
    ...registerExerciseEngine(context),
    vscode.window.registerWebviewViewProvider("protege.launcher", launcher),
    vscode.commands.registerCommand("protege.toggle", () =>
      openProtegePanel(context)
    ),
    // Status bar voice chip fires this; webview's "Protege ON" chip also
    // fires this (via wake/toggle message). Both paths update all
    // mounted webviews + the status bar via broadcast + setVoiceState.
    vscode.commands.registerCommand("protege.toggleWake", () => {
      const id = currentUserIdOrNull();
      if (!id) {
        vscode.window.showInformationMessage(
          "Sign in with GitHub to use voice mode."
        );
        return;
      }
      return toggleGlobalWake(context, id);
    }),
    vscode.commands.registerCommand("protege.openInNewTab", () =>
      openProtegePanel(context)
    ),
    vscode.commands.registerCommand("protege.openEcho", () =>
      openEchoPanel(context)
    ),
    vscode.commands.registerCommand("protege.showEchoEventStream", () => {
      const ch = getEventStreamChannel();
      if (ch) {
        ch.show(true);
      } else {
        vscode.window.showInformationMessage(
          "Echo event stream not initialized yet — try again after extension activation completes."
        );
      }
    }),
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
      const id = currentUserIdOrNull();
      if (!id) return;
      try {
        const me = await fetchMe(id);
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
          const { resolveWorkspaceUri } = await import("./ai/workspacePath.js");
          // resolveWorkspaceUri throws if `args.path` lands outside every
          // open workspace folder. Stops a markdown link rendered from a
          // poisoned tool result (or a chat reply that breaks past the
          // C2 fence) from coercing the editor into writing /etc/anything.
          const uri = resolveWorkspaceUri(args.path);
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
      async (args: {
        kind?: string;
        label?: string;
        issue?: string;
        fix?: string;
        explanation?: string;
        path?: string;
        startLine?: number;
        endLine?: number;
      }) => {
        // User clicked "Teach me" above a highlight. The previous version
        // forwarded only `{kind, label}` and let the next turn re-discover
        // what the highlight meant — which produced generic answers that
        // didn't actually teach the issue. Now we pass the full payload
        // (issue, fix, explanation) AND quote the real code from the
        // anchor-corrected line range, so the model teaches THIS specific
        // thing as a back-and-forth instead of starting over.
        openProtegePanel(context);
        const kind = args?.kind ?? "focus";
        const label = args?.label?.trim() ?? "";
        const issue = args?.issue?.trim() ?? "";
        const fix = args?.fix?.trim() ?? "";
        const explanation = args?.explanation?.trim() ?? "";
        const filePath = args?.path ?? "";
        const startLine = args?.startLine ?? 0;
        const endLine = args?.endLine ?? startLine;

        // Pull the actual lines from disk so the model is teaching the
        // current code, not what it imagined when the highlight was
        // created. If the file moved or got cleared, fall back to the
        // remembered metadata.
        let codeQuote = "";
        if (filePath && startLine > 0) {
          try {
            const uri = filePath.startsWith("/")
              ? vscode.Uri.file(filePath)
              : vscode.workspace.workspaceFolders?.[0]
              ? vscode.Uri.joinPath(
                  vscode.workspace.workspaceFolders[0].uri,
                  filePath
                )
              : null;
            if (uri) {
              const doc = await vscode.workspace.openTextDocument(uri);
              const startIdx = Math.max(0, startLine - 1);
              const endIdx = Math.min(doc.lineCount - 1, endLine - 1);
              const lines: string[] = [];
              for (let i = startIdx; i <= endIdx; i++) {
                lines.push(doc.lineAt(i).text);
              }
              codeQuote = lines.join("\n");
            }
          } catch {
            // non-fatal — model still gets the structured payload
          }
        }

        // Build a teach-this-specific prompt. The contract: the model
        // already identified the issue + drafted the explanation, so it
        // should TEACH that — not re-think from scratch. Two-way learning
        // means it asks a checkpoint question after the explanation so
        // the user actually engages instead of nodding past the answer.
        const parts: string[] = [];
        parts.push(
          `I clicked "Teach me" on a ${kind} you highlighted${
            label ? ` (“${label}”)` : ""
          }.`
        );
        const FENCE = "```";
        if (filePath && codeQuote) {
          const range =
            endLine !== startLine ? `${startLine}-${endLine}` : `${startLine}`;
          parts.push(
            `\nThe highlighted code at \`${filePath}:${range}\`:\n` +
              `${FENCE}\n${codeQuote}\n${FENCE}`
          );
        }
        if (issue) parts.push(`\nYou flagged: ${issue}`);
        if (explanation) parts.push(`Your reasoning: ${explanation}`);
        if (fix) {
          parts.push(`Your proposed fix:\n${FENCE}\n${fix}\n${FENCE}`);
        }
        parts.push(
          `\nTeach this to me as a two-way exchange — not a lecture:\n` +
            `1. State the underlying concept in one sentence (no jargon).\n` +
            `2. Show why the current code triggers it, pointing at the exact tokens.\n` +
            `3. Ask me ONE checkpoint question that proves I get it before moving on.\n` +
            `Stay focused on this specific issue. Don't re-explain everything you've already said in this thread.`
        );

        const prompt = parts.join("\n");
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
      // Developer-mode gate. `tccutil reset Microphone` wipes mic access
      // for EVERY app on the Mac, not just this one. End users who think
      // "reset Protege's mic permission" should never trigger it. Funnel
      // them to the safe per-app Settings deeplink instead. Internal
      // testers who genuinely need the nuclear option flip
      // `protege.developerMode: true` in user settings (or set
      // PROTEGE_DEV=1 in the environment) — same pattern as the backend
      // switcher.
      const isDev =
        process.env.PROTEGE_DEV === "1" ||
        process.env.PROTEGE_DEV === "true" ||
        vscode.workspace
          .getConfiguration("protege")
          .get<boolean>("developerMode") === true;
      if (!isDev) {
        await vscode.commands.executeCommand("protege.openMicSettings");
        vscode.window.showInformationMessage(
          "Toggle Cursor's mic access off then on in System Settings → Privacy → Microphone. (System-wide reset is restricted to developer mode.)"
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

  // First-run wake-word calibration prompt. Shown once on initial install
  // and again at most once per week if the user hits "Later" — no
  // reload-loop nag. Always reachable manually via the
  // `Protege: Calibrate wake word` command palette entry.
  if (shouldShowCalibrationPrompt(context)) {
    setTimeout(async () => {
      const choice = await vscode.window.showInformationMessage(
        "Protege can calibrate its wake word to your voice — 30 seconds, improves detection accuracy. Want to do it now?",
        "Calibrate",
        "Later"
      );
      if (choice === "Calibrate") {
        await vscode.commands.executeCommand("protege.calibrateWakeWord");
      } else {
        // "Later" or dismiss → snooze the prompt for a week so we don't
        // re-ask on every Cursor restart.
        await recordCalibrationPromptDeferred(context);
      }
    }, 3000);
  }

  // Login-first: only poll IQ once we're signed in. Pre-auth would 401.
  if (isSignedIn()) {
    setTimeout(() => {
      vscode.commands.executeCommand("protege.refreshIQ");
    }, 500);
  }
  // Re-fire after a successful sign-in so the status bar/launcher hydrate
  // without requiring the user to manually invoke `Refresh IQ`.
  context.subscriptions.push(
    new vscode.Disposable(
      onAuthChange((snap) => {
        if (snap.state !== "signed-in") return;
        void vscode.commands.executeCommand("protege.refreshIQ");
      })
    )
  );

  setTimeout(() => {
    try {
      openProtegePanel(context);
    } catch (e) {
      output.appendLine(`[protege] auto-open failed: ${String(e)}`);
    }
  }, 400);

  // Start the wake-word listener on activate — not just when a webview
  // mounts. Login-first: only fire when signed in. The wake handler also
  // re-checks `currentUserIdOrNull` at trigger time so a sign-out
  // mid-session can't dispatch chat under a stale id.
  if (getWakeEnabledFor(context) && isSignedIn()) {
    const wakeId = currentUserIdOrNull();
    if (wakeId) {
      setTimeout(() => {
        import("./chat/webviewHost.js").then((mod) => {
          void mod.startGlobalWakeListener(context, wakeId);
        });
      }, 800);
    }
  }

  // Sign-in command: single canonical entry point invoked by the gate
  // button, status bar, or any future surface.
  context.subscriptions.push(
    vscode.commands.registerCommand("protege.signIn", async () => {
      await getGitHubUser({ createIfNone: true });
    })
  );
}

// Old updateStatusBar removed — replaced by statusBarLive.ts

export function deactivate() {}
