import React, { useEffect, useRef, useState } from "react";
import type {
  ConceptKnownStatus,
  DashboardResponse,
  EchoHostToWebview,
  EchoWebviewToHost,
  EchoWindow,
} from "@protege/types";
import { DashboardView } from "../src/echo/dashboardView.js";
import type { LiveScanState } from "../src/echo/widgets/RepoConcepts.js";
// Story Mode retired (2026-04-30) — surfaces removed from EchoTab + the
// standalone echo panel. The `storyModeView.tsx` module stays on disk
// in case the surface comes back; it's just unimported here.
import { vscode, onHostMessage } from "./vscode.js";
import "./echo/echo.css";

/**
 * Inline Echo tab for the main Protege sidebar. Mirrors the standalone
 * Echo panel (`apps/extension/webview/echo/main.tsx`) but speaks the
 * shared HostToWebview / WebviewToHost channel instead of its own
 * `acquireVsCodeApi()` bridge. Echo RPCs travel inside `echo/msg`
 * envelopes; the host unwraps them into `handleEchoRpc`.
 */
function sendEcho(payload: EchoWebviewToHost): void {
  vscode.postMessage({ type: "echo/msg", payload });
}

export function EchoTab(): JSX.Element {
  // activeSubPage / story-mode toggle retired with Story Mode itself
  // (2026-04-30). The Echo tab always renders the dashboard now.
  const [window, setWindow] = useState<EchoWindow>("today");
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Echo preferences state retired with Story Mode (2026-04-30). The
  // backend still emits `echo_preferences` messages, but nothing in the
  // tab consumes them right now. We swallow them silently below.
  const [liveScan, setLiveScan] = useState<LiveScanState | null>(null);
  // Buffered concept-status edits. Each click on a mastery pill writes
  // into this map instead of firing an RPC immediately. Applying it
  // immediately would refetch the dashboard, reshuffle tiles (known
  // items get deprioritized/filtered), and the tile the user was aiming
  // for often reorders out from under the cursor — which is why
  // successive clicks "stopped working".
  //
  // The Save button commits the whole map in one RPC, then clears it.
  const [pendingStatus, setPendingStatus] = useState<
    Record<string, ConceptKnownStatus>
  >({});

  // Mirror `window` into a ref so the mount-only message listener can read
  // the current value without depending on `window` itself. A dep on
  // `window` here re-runs the effect — and therefore re-fires echo_ready —
  // every time the user changes the time range, which causes the host to
  // reset its state.currentWindow back to "today" and race the real
  // response with a stale one.
  const windowRef = useRef<EchoWindow>(window);
  useEffect(() => {
    windowRef.current = window;
  }, [window]);

  useEffect(() => {
    // Watchdog: if the host never answers with echo_dashboard/error within
    // 20s we flip the panel into an explicit error state. Beats an
    // indefinite skeleton loader when the extension host is wedged or
    // running a stale build that doesn't know the echo/msg envelope.
    const watchdog = setTimeout(() => {
      setLoading(false);
      setError(
        "Echo host isn't responding. Reload the VS Code window (Cmd/Ctrl+Shift+P → \"Developer: Reload Window\")."
      );
    }, 20_000);
    const clearWatchdog = (): void => clearTimeout(watchdog);
    const off = onHostMessage((msg) => {
      if (msg.type !== "echo/msg") return;
      const inner: EchoHostToWebview = msg.payload;
      switch (inner.type) {
        case "echo_dashboard":
          clearWatchdog();
          setData(inner.data);
          setLoading(false);
          setError(null);
          break;
        case "echo_dashboardLoading":
          setLoading(true);
          setError(null);
          break;
        case "echo_dashboardError":
          clearWatchdog();
          setError(inner.error);
          setLoading(false);
          break;
        case "echo_preferences":
          // No-op — preferences state was retired with Story Mode.
          break;
        case "echo_commit_enriched":
          sendEcho({ type: "echo_request", window: windowRef.current });
          break;
        case "repo_scan_status": {
          setLiveScan({
            state: inner.state,
            scannedFiles: inner.scannedFiles,
            totalCandidates: inner.totalCandidates,
            finishedAt: inner.finishedAt,
          });
          if (inner.state === "done" || inner.state === "truncated") {
            sendEcho({ type: "echo_request", window: windowRef.current });
          }
          if (inner.state === "idle") {
            setLiveScan(null);
          }
          break;
        }
        default:
          break;
      }
    });
    sendEcho({ type: "echo_ready" });
    return () => {
      clearWatchdog();
      off();
    };
    // Mount-only: subscribing the listener and firing echo_ready must
    // happen exactly once per mount. See the ref above for how window
    // changes still propagate into the listener.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const requestWindow = (w: EchoWindow): void => {
    setWindow(w);
    sendEcho({ type: "echo_request", window: w });
  };

  // openStory / backToDashboard / toggleNotify retired with Story Mode
  // (2026-04-30). The DashboardView still accepts `onOpenStory` /
  // `onToggleNotify` props for backward compat with old props shape;
  // we pass no-ops so the dashboard simply doesn't expose the entry.
  const noopStory = (): void => {
    /* story mode retired */
  };
  const noopNotify = (_enabled: boolean): void => {
    /* story mode retired */
  };

  const openMoment = (file: string, line?: number, ts?: number): void => {
    sendEcho({ type: "echo_openMoment", file, line, ts });
  };

  const setConceptStatus = (
    concept: string,
    status: ConceptKnownStatus
  ): void => {
    // Buffer only — commit happens on Save. Mutating the dashboard
    // payload here (instead of queuing for Save) would trigger the same
    // reshuffle problem we're trying to fix.
    setPendingStatus((prev) => ({ ...prev, [concept]: status }));
  };

  const saveConceptStatuses = (): void => {
    const changes = Object.entries(pendingStatus).map(([concept, status]) => ({
      concept,
      status,
    }));
    if (changes.length === 0) return;
    sendEcho({ type: "echo_saveConceptStatuses", changes });
    setPendingStatus({});
  };

  const discardConceptStatuses = (): void => {
    setPendingStatus({});
  };

  const setConceptLanguage = (language: string | null): void => {
    sendEcho({ type: "echo_setConceptLanguage", language });
  };

  const rescanRepo = (): void => {
    sendEcho({ type: "echo_rescanRepo" });
  };

  return (
    <div className="echo-root echo-root--embedded">
      <header className="echo-header">
        <div className="echo-brand">Echo</div>
        {/* Story Mode toggle retired 2026-04-30. */}
      </header>
      <DashboardView
        window={window}
        data={data}
        loading={loading}
        error={error}
        liveScan={liveScan}
        pendingStatus={pendingStatus}
        onWindowChange={requestWindow}
        onOpenStory={noopStory}
        onToggleNotify={noopNotify}
        onOpenMoment={openMoment}
        onSetConceptStatus={setConceptStatus}
        onSaveConceptStatuses={saveConceptStatuses}
        onDiscardConceptStatuses={discardConceptStatuses}
        onSetConceptLanguage={setConceptLanguage}
        onRescanRepo={rescanRepo}
      />
    </div>
  );
}
