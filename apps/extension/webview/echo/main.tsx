import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  ConceptKnownStatus,
  DashboardResponse,
  EchoHostToWebview,
  EchoUserPreferences,
  EchoWebviewToHost,
  EchoWindow,
} from "@protege/types";
import { DashboardView } from "../../src/echo/dashboardView.js";
import type { LiveScanState } from "../../src/echo/widgets/RepoConcepts.js";
import { StoryModeView } from "../../src/echo/storyModeView.js";
import "./echo.css";

interface VsCodeApi {
  postMessage(msg: EchoWebviewToHost): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode: VsCodeApi = acquireVsCodeApi();

function EchoApp(): JSX.Element {
  const [activeSubPage, setActiveSubPage] = useState<"dashboard" | "story">(
    "dashboard"
  );
  const [window, setWindow] = useState<EchoWindow>("today");
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Login-first: when the host can't fulfill an RPC because the user is
  // signed-out, it posts `echo_authRequired`. We render a sign-in gate
  // instead of the dashboard; clicking the button posts `echo_signIn`,
  // the host pops OAuth, and on success the host replays echo_ready.
  const [authBlocked, setAuthBlocked] = useState(false);
  const [preferences, setPreferences] = useState<EchoUserPreferences>({
    storyModeNotify: false,
  });
  // Rv5.C: live scan state overrides payload.scanState while a scan is in
  // flight. We reset back to null once the scan finishes so W17 can fall
  // back to the fresh `lastScannedAt` reported by the refetched dashboard.
  const [liveScan, setLiveScan] = useState<LiveScanState | null>(null);

  useEffect(() => {
    const listener = (event: MessageEvent<EchoHostToWebview>) => {
      const msg = event.data;
      switch (msg.type) {
        case "echo_authRequired":
          setAuthBlocked(true);
          setLoading(false);
          setError(null);
          break;
        case "echo_dashboard":
          setAuthBlocked(false);
          setData(msg.data);
          setLoading(false);
          setError(null);
          break;
        case "echo_dashboardLoading":
          setAuthBlocked(false);
          setLoading(true);
          setError(null);
          break;
        case "echo_dashboardError":
          setError(msg.error);
          setLoading(false);
          break;
        case "echo_preferences":
          setPreferences(msg.preferences);
          break;
        case "echo_commit_enriched":
          // Commit stream — hot refresh the dashboard on next tick so the
          // commits widget reflects the fresh card.
          vscode.postMessage({ type: "echo_request", window });
          break;
        case "repo_scan_status": {
          setLiveScan({
            state: msg.state,
            scannedFiles: msg.scannedFiles,
            totalCandidates: msg.totalCandidates,
            finishedAt: msg.finishedAt,
          });
          // On terminal states refetch so the freshly-indexed concepts
          // populate. Clear liveScan on "idle" so we stop overriding the
          // payload's state once the scan settled.
          if (msg.state === "done" || msg.state === "truncated") {
            vscode.postMessage({ type: "echo_request", window });
          }
          if (msg.state === "idle") {
            setLiveScan(null);
          }
          break;
        }
        default:
          break;
      }
    };
    globalThis.addEventListener("message", listener);
    vscode.postMessage({ type: "echo_ready" });
    return () => globalThis.removeEventListener("message", listener);
  }, [window]);

  const requestWindow = (w: EchoWindow) => {
    setWindow(w);
    vscode.postMessage({ type: "echo_request", window: w });
  };

  const openStory = () => {
    setActiveSubPage("story");
    vscode.postMessage({ type: "echo_setSubPage", subPage: "story" });
  };

  const backToDashboard = () => {
    setActiveSubPage("dashboard");
    vscode.postMessage({ type: "echo_setSubPage", subPage: "dashboard" });
  };

  const toggleNotify = (enabled: boolean) => {
    setPreferences((p) => ({ ...p, storyModeNotify: enabled }));
    vscode.postMessage({ type: "echo_notifyStoryMode", enabled });
  };

  const openMoment = (file: string, line?: number, ts?: number) => {
    vscode.postMessage({ type: "echo_openMoment", file, line, ts });
  };

  const setConceptStatus = (concept: string, status: ConceptKnownStatus) => {
    vscode.postMessage({ type: "echo_setConceptStatus", concept, status });
  };

  const setConceptLanguage = (language: string | null) => {
    vscode.postMessage({ type: "echo_setConceptLanguage", language });
  };

  const rescanRepo = () => {
    vscode.postMessage({ type: "echo_rescanRepo" });
  };

  const storyData = data?.storyMode ?? {
    notify: preferences.storyModeNotify,
    nextDrop: null,
  };

  if (authBlocked) {
    return (
      <div className="echo-root">
        <header className="echo-header">
          <div className="echo-brand">Echo</div>
        </header>
        <div className="echo-auth-gate">
          <div className="echo-auth-gate-card">
            <div className="echo-auth-gate-title">Sign in to view Echo</div>
            <div className="echo-auth-gate-body">
              Echo tracks your coding activity against your GitHub account.
              Sign in once and the dashboard hydrates automatically.
            </div>
            <button
              type="button"
              className="echo-auth-gate-button"
              onClick={() => vscode.postMessage({ type: "echo_signIn" })}
            >
              Sign in with GitHub
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="echo-root">
      <header className="echo-header">
        <div className="echo-brand">Echo</div>
        <div className="echo-subpage-toggle">
          {activeSubPage === "dashboard" ? (
            <button type="button" onClick={openStory}>
              Story Mode &rarr;
            </button>
          ) : (
            <button type="button" onClick={backToDashboard}>
              &larr; Dashboard
            </button>
          )}
        </div>
      </header>
      {activeSubPage === "dashboard" ? (
        <DashboardView
          window={window}
          data={data}
          loading={loading}
          error={error}
          liveScan={liveScan}
          onWindowChange={requestWindow}
          onOpenStory={openStory}
          onToggleNotify={toggleNotify}
          onOpenMoment={openMoment}
          onSetConceptStatus={setConceptStatus}
          onSetConceptLanguage={setConceptLanguage}
          onRescanRepo={rescanRepo}
        />
      ) : (
        <StoryModeView
          data={storyData}
          onBack={backToDashboard}
          onToggleNotify={toggleNotify}
        />
      )}
    </div>
  );
}

const root = document.getElementById("echo-root");
if (root) {
  createRoot(root).render(<EchoApp />);
}
