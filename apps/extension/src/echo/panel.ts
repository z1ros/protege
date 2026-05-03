import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type {
  DashboardResponse,
  EchoHostToWebview,
  EchoUserPreferences,
  EchoWebviewToHost,
  EchoWindow,
} from "@protege/types";
import { authHeaders, isSignedIn, getGitHubUser, onAuthChange } from "../user/auth.js";
import { BACKEND_URL, currentUserIdOrNull } from "../user/protegeClient.js";
import { devPortMapping, isDevMode, renderDevHtml } from "../devMode.js";
import { getBatcher } from "./batcher.js";
import { isEchoMessage, postToEchoPanel, type EchoPoster } from "./rpc.js";
import {
  clearScannedWorkspace,
  currentWorkspaceRoot,
  isWorkspaceScanned,
  scanWorkspace,
} from "./workspaceConceptScanner.js";

let current: vscode.WebviewPanel | undefined;

/** Additional broadcast targets (e.g. the main Protege sidebar webview when
 *  Echo is mounted as an inline tab). The separate Echo panel is always
 *  included via `current`; these are extra fan-out sinks. */
const broadcastTargets = new Set<EchoPoster>();

/**
 * Register a post callback that will receive every `broadcastToEcho` fan-out
 * in addition to the standalone panel. Returns a disposer.
 */
export function registerEchoBroadcastTarget(post: EchoPoster): () => void {
  broadcastTargets.add(post);
  return () => {
    broadcastTargets.delete(post);
  };
}

/**
 * Opens (or reveals) the Echo webview panel in the active editor column.
 * The panel hosts the Echo React root — Dashboard by default, Story Mode
 * toggled via top-right button. State lives in React, not in the URL.
 */
export function openEchoPanel(context: vscode.ExtensionContext): vscode.WebviewPanel {
  if (current) {
    current.reveal(vscode.ViewColumn.Active, false);
    return current;
  }

  const panel = vscode.window.createWebviewPanel(
    "protege.echo",
    "Protege — Echo",
    { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.joinPath(context.extensionUri, "dist", "webview"),
      ],
      ...(isDevMode(context.extensionMode) ? { portMapping: devPortMapping() } : {}),
    }
  );

  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "icon.svg");
  panel.webview.html = renderEchoHtml(panel.webview, context.extensionUri, context.extensionMode);

  // The host-side currentWindow mirror lets concept-status / filter RPCs
  // refetch the dashboard for the window the user is actually looking at
  // instead of always snapping back to "today".
  const state: PanelState = { currentWindow: "today", context };

  const post: EchoPoster = (msg) => postToEchoPanel(panel, msg);

  const sub = panel.webview.onDidReceiveMessage(async (raw) => {
    if (!isEchoMessage(raw)) return;
    // Sign-in escape hatch: the gate UI posts this when the user clicks
    // the OAuth button. Pop the native dialog; on success the auth-state
    // listener below replays `echo_ready` so the dashboard fetches.
    if (raw.type === "echo_signIn") {
      const u = await getGitHubUser({ createIfNone: true });
      if (!u) post({ type: "echo_authRequired" });
      return;
    }
    // Resolve the userId per-message so a sign-in mid-session starts
    // serving real data on the next webview RPC.
    const userId = currentUserIdOrNull();
    if (!userId || !isSignedIn()) {
      post({ type: "echo_authRequired" });
      return;
    }
    await handleEchoRpc(post, userId, raw, state, context);
  });

  // When auth lands while the panel is open, re-seed the dashboard so the
  // user doesn't have to manually re-trigger.
  const offAuth = onAuthChange((snap) => {
    if (snap.state !== "signed-in" || !snap.user) return;
    void handleEchoRpc(post, snap.user.githubId, { type: "echo_ready" }, state, context);
  });

  panel.onDidDispose(() => {
    sub.dispose();
    offAuth();
    current = undefined;
  });

  current = panel;

  // Rv5.B: workspace scan is kicked inside the `echo_ready` RPC handler,
  // which fires the first time the webview mounts. That keeps parity with
  // the sidebar-hosted Echo tab (no duplicate kicks, one code path).

  return panel;
}

async function maybeKickWorkspaceScan(
  context: vscode.ExtensionContext,
  post: EchoPoster,
  userId: string,
  force = false
): Promise<void> {
  const root = currentWorkspaceRoot();
  if (!root) return;
  if (!force && isWorkspaceScanned(context, root)) {
    // Already scanned — let W17 know it can rely on whatever's in the DB.
    post({ type: "repo_scan_status", state: "idle" });
    return;
  }
  try {
    await scanWorkspace(context, {
      force,
      userId,
      onStatus: (info) => {
        post({
          type: "repo_scan_status",
          state: info.state,
          scannedFiles: info.scannedFiles,
          totalCandidates: info.totalCandidates,
          finishedAt: info.finishedAt,
        });
      },
    });
  } catch (err) {
    console.warn("[protege] workspace scan failed:", err);
    post({ type: "repo_scan_status", state: "idle" });
  }
}

export interface PanelState {
  currentWindow: EchoWindow;
  context: vscode.ExtensionContext;
}

export function isEchoPanelOpen(): boolean {
  return current !== undefined;
}

export function broadcastToEcho(msg: EchoHostToWebview): void {
  if (current) postToEchoPanel(current, msg);
  for (const post of broadcastTargets) {
    try {
      post(msg);
    } catch {
      // Target is best-effort; a failed post should never break the caller.
    }
  }
}

/** Public entry point for modules (e.g. the main sidebar webview host) that
 *  need to process Echo RPC without owning a WebviewPanel. Handler writes
 *  outgoing messages via `post`; scan state uses the supplied `context`. */
export async function handleEchoRpc(
  post: EchoPoster,
  userId: string,
  msg: EchoWebviewToHost,
  state: PanelState,
  context: vscode.ExtensionContext
): Promise<void> {
  switch (msg.type) {
    case "echo_ready": {
      // Seed with today's dashboard + preferences on first mount.
      state.currentWindow = "today";
      await sendDashboard(post, userId, "today");
      await sendPreferences(post, userId);
      // Kick the workspace concept scan once per mount. The helper is a
      // no-op when the workspace is already scanned.
      void maybeKickWorkspaceScan(context, post, userId);
      return;
    }
    case "echo_request": {
      state.currentWindow = msg.window;
      await sendDashboard(post, userId, msg.window);
      return;
    }
    case "echo_setSubPage": {
      // Webview-owned state — nothing to persist host-side today. Kept in
      // the RPC so a future "last-selected" preference can slot in.
      return;
    }
    case "echo_openMoment": {
      try {
        if (typeof msg.file !== "string" || msg.file.length === 0) return;
        // Security: never open a file that isn't under an active workspace
        // folder. path.resolve normalizes but does NOT dereference symlinks,
        // so we fs.realpathSync both sides (target + roots) before the
        // containment check — otherwise a symlink inside the workspace
        // pointing outside (e.g. at /etc/passwd) slips past. realpath
        // throws on missing paths, which doubles as our stale-path check.
        const requested = path.resolve(msg.file);
        let resolved: string;
        try {
          resolved = fs.realpathSync(requested);
        } catch {
          console.warn("[protege] echo_openMoment stale or unreadable path:", requested);
          return;
        }
        const folders = vscode.workspace.workspaceFolders ?? [];
        const inWorkspace = folders.some((f) => {
          let root: string;
          try {
            root = fs.realpathSync(path.resolve(f.uri.fsPath));
          } catch {
            return false;
          }
          const rel = path.relative(root, resolved);
          return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
        });
        if (!inWorkspace) {
          console.warn("[protege] echo_openMoment refused — not in workspace:", resolved);
          return;
        }
        const uri = vscode.Uri.file(resolved);
        const doc = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(doc, {
          viewColumn: vscode.ViewColumn.Beside,
          preserveFocus: false,
        });
        if (typeof msg.line === "number") {
          const line = Math.max(0, msg.line - 1);
          const pos = new vscode.Position(line, 0);
          editor.selection = new vscode.Selection(pos, pos);
          editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
        }
      } catch (err) {
        console.warn("[protege] echo_openMoment failed:", err);
      }
      return;
    }
    case "echo_notifyStoryMode": {
      try {
        await fetch(`${BACKEND_URL}/echo/preferences?userId=${encodeURIComponent(userId)}`, {
          method: "POST",
          headers: { ...authHeaders() },
          body: JSON.stringify({ storyModeNotify: msg.enabled }),
        });
      } catch {
        // Offline — preference updates will retry next time the panel opens.
      }
      await sendPreferences(post, userId);
      return;
    }
    case "echo_refreshPreferences": {
      await sendPreferences(post, userId);
      return;
    }
    case "echo_setConceptStatus": {
      // Validate client-side so an errant payload never reaches the
      // network — the backend validates too, this is just defence in depth.
      if (
        typeof msg.concept !== "string" ||
        msg.concept.length === 0 ||
        msg.concept.length > 200
      ) {
        return;
      }
      if (
        msg.status !== "unset" &&
        msg.status !== "known" &&
        msg.status !== "not_known"
      ) {
        return;
      }
      try {
        await fetch(
          `${BACKEND_URL}/echo/concepts/status?userId=${encodeURIComponent(userId)}`,
          {
            method: "POST",
            headers: { "content-type": "application/json", ...authHeaders() },
            body: JSON.stringify({ concept: msg.concept, status: msg.status }),
          }
        );
      } catch {
        // Offline — swallow. The tile stays in its current visual state
        // until the next successful round-trip.
      }
      await sendDashboard(post, userId, state.currentWindow);
      return;
    }
    case "echo_saveConceptStatuses": {
      // Bulk commit from the "Save changes" button. POST each validated
      // change sequentially, then refetch the dashboard ONCE so tiles
      // reshuffle in a single repaint instead of per-click.
      const changes = Array.isArray(msg.changes) ? msg.changes : [];
      for (const change of changes) {
        if (
          !change ||
          typeof change.concept !== "string" ||
          change.concept.length === 0 ||
          change.concept.length > 200
        ) {
          continue;
        }
        if (
          change.status !== "unset" &&
          change.status !== "known" &&
          change.status !== "not_known"
        ) {
          continue;
        }
        try {
          await fetch(
            `${BACKEND_URL}/echo/concepts/status?userId=${encodeURIComponent(userId)}`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                ...authHeaders(),
              },
              body: JSON.stringify({
                concept: change.concept,
                status: change.status,
              }),
            }
          );
        } catch {
          // Offline — skip this one; the Save button's optimistic state
          // persists in memory until the next successful round-trip.
        }
      }
      await sendDashboard(post, userId, state.currentWindow);
      return;
    }
    case "echo_setConceptLanguage": {
      // Rv5.C: null => "All languages". Otherwise require the short
      // allow-list pattern; unknown values fall through as null so a
      // rogue payload can't write junk into the preferences row.
      const raw = msg.language;
      let next: string | null = null;
      if (raw === null) {
        next = null;
      } else if (
        typeof raw === "string" &&
        /^[a-z][a-z0-9\-]{0,31}$/.test(raw)
      ) {
        next = raw;
      } else {
        return;
      }
      try {
        await fetch(
          `${BACKEND_URL}/echo/preferences?userId=${encodeURIComponent(userId)}`,
          {
            method: "POST",
            headers: { "content-type": "application/json", ...authHeaders() },
            body: JSON.stringify({ echoConceptLanguage: next }),
          }
        );
      } catch {
        // Offline — the picker will show the old value; the user can
        // retry when the network comes back.
      }
      await sendDashboard(post, userId, state.currentWindow);
      return;
    }
    case "echo_rescanRepo": {
      const root = currentWorkspaceRoot();
      if (!root) return;
      try {
        await clearScannedWorkspace(context, root);
      } catch {
        // Non-fatal — if the globalState write fails, the forced scan
        // below still overrides the cached flag in memory.
      }
      void maybeKickWorkspaceScan(context, post, userId, true);
      return;
    }
    default:
      return;
  }
}

const DASHBOARD_FLUSH_TIMEOUT_MS = 5_000;
const DASHBOARD_FETCH_TIMEOUT_MS = 15_000;

/** Race a promise against a wall-clock timeout. Resolves/rejects with
 *  whichever wins. Used so a hung backend can't leave the Echo panel
 *  stuck on its loader skeleton forever. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (err) => {
        clearTimeout(t);
        reject(err);
      }
    );
  });
}

async function sendDashboard(
  post: EchoPoster,
  userId: string,
  window: EchoWindow
): Promise<void> {
  post({ type: "echo_dashboardLoading", window });
  // Flush pending events before asking the backend to aggregate — without
  // this, dashboard queries race the 2-min flush interval and show stale
  // numbers. Bounded so a hung backend can't block the dashboard forever;
  // flush failures are non-fatal either way.
  try {
    const pending = getBatcher()?.flush();
    if (pending) await withTimeout(pending, DASHBOARD_FLUSH_TIMEOUT_MS, "batcher flush");
  } catch {
    // Silently continue — the dashboard still works with whatever events
    // already made it to the backend.
  }
  // Rv5.C: pass the current workspace root so W17 can key its
  // RepoConceptIndex lookup. Backend never reads the filesystem with this
  // path — it's a pure index key validated against the safety regex.
  const workspaceRoot = currentWorkspaceRoot();
  const workspaceParam =
    workspaceRoot !== null
      ? `&workspaceRoot=${encodeURIComponent(workspaceRoot)}`
      : "";
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), DASHBOARD_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(
      `${BACKEND_URL}/echo/dashboard?window=${window}&userId=${encodeURIComponent(userId)}${workspaceParam}`,
      { headers: { ...authHeaders() }, signal: ac.signal }
    );
    if (!res.ok) {
      post({
        type: "echo_dashboardError",
        window,
        error: `HTTP ${res.status}`,
      });
      return;
    }
    const data = (await res.json()) as DashboardResponse;
    post({ type: "echo_dashboard", window, data });
  } catch (err) {
    post({
      type: "echo_dashboardError",
      window,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    clearTimeout(timer);
  }
}

async function sendPreferences(
  post: EchoPoster,
  userId: string
): Promise<void> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), DASHBOARD_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(
      `${BACKEND_URL}/echo/preferences?userId=${encodeURIComponent(userId)}`,
      { headers: { ...authHeaders() }, signal: ac.signal }
    );
    if (!res.ok) {
      post({
        type: "echo_preferences",
        preferences: { storyModeNotify: false },
      });
      return;
    }
    const body = (await res.json()) as { preferences?: Partial<EchoUserPreferences> };
    post({
      type: "echo_preferences",
      preferences: {
        storyModeNotify: !!body.preferences?.storyModeNotify,
        echoConceptLanguage: body.preferences?.echoConceptLanguage ?? null,
      },
    });
  } catch {
    post({
      type: "echo_preferences",
      preferences: { storyModeNotify: false },
    });
  } finally {
    clearTimeout(timer);
  }
}

function renderEchoHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  mode: vscode.ExtensionMode
): string {
  // In the F5 Extension Development Host the webview loads from the Vite
  // dev server so HMR updates React/CSS changes in ~100ms without a full
  // panel reload. Installed extensions always take the bundled path below.
  if (isDevMode(mode)) return renderDevHtml(webview, "echo");

  const base = vscode.Uri.joinPath(extensionUri, "dist", "webview");
  const baseUri = webview.asWebviewUri(base) + "/";
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(base, "echo", "echo.js")
  );
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(base, "echo", "echo.css")
  );
  const nonce = getNonce();
  // connect-src includes both localhost (dev) and the production backend
  // origin (marketplace builds). Mirrors the rationale at
  // apps/extension/src/chat/webviewHost.ts ~ line 2318.
  const PROD_BACKEND_ORIGIN = "https://protege-backend-production.up.railway.app";
  const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource}; connect-src ${webview.cspSource} http://localhost:8787 http://127.0.0.1:8787 ${PROD_BACKEND_ORIGIN};`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<base href="${baseUri}" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<link rel="stylesheet" href="${styleUri}" />
<title>Protege Echo</title>
</head>
<body>
<div id="echo-root"></div>
<script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
}

function getNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
