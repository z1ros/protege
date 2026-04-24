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
import { authHeaders } from "../auth.js";
import { BACKEND_URL, getUserId } from "../protegeClient.js";
import { devPortMapping, isDevMode, renderDevHtml } from "../devMode.js";
import { getBatcher } from "./batcher.js";
import { isEchoMessage, postToEchoPanel } from "./rpc.js";
import {
  clearScannedWorkspace,
  currentWorkspaceRoot,
  isWorkspaceScanned,
  scanWorkspace,
} from "./workspaceConceptScanner.js";

let current: vscode.WebviewPanel | undefined;

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

  const userId = getUserId(context);
  // The host-side currentWindow mirror lets concept-status / filter RPCs
  // refetch the dashboard for the window the user is actually looking at
  // instead of always snapping back to "today".
  const state: PanelState = { currentWindow: "today", context };

  const sub = panel.webview.onDidReceiveMessage(async (raw) => {
    if (!isEchoMessage(raw)) return;
    await handleEchoMessage(panel, userId, raw, state);
  });

  panel.onDidDispose(() => {
    sub.dispose();
    current = undefined;
  });

  current = panel;

  // Rv5.B: kick off a workspace concept scan on first Echo open per
  // workspace. Fire-and-forget; the scanner itself broadcasts status
  // updates back into the panel via `repo_scan_status`.
  void maybeKickWorkspaceScan(context, panel, userId);

  return panel;
}

async function maybeKickWorkspaceScan(
  context: vscode.ExtensionContext,
  panel: vscode.WebviewPanel,
  userId: string,
  force = false
): Promise<void> {
  const root = currentWorkspaceRoot();
  if (!root) return;
  if (!force && isWorkspaceScanned(context, root)) {
    // Already scanned — let W17 know it can rely on whatever's in the DB.
    postToEchoPanel(panel, { type: "repo_scan_status", state: "idle" });
    return;
  }
  try {
    await scanWorkspace(context, {
      force,
      userId,
      onStatus: (info) => {
        postToEchoPanel(panel, {
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
    postToEchoPanel(panel, { type: "repo_scan_status", state: "idle" });
  }
}

interface PanelState {
  currentWindow: EchoWindow;
  context: vscode.ExtensionContext;
}

export function isEchoPanelOpen(): boolean {
  return current !== undefined;
}

export function broadcastToEcho(msg: EchoHostToWebview): void {
  if (!current) return;
  postToEchoPanel(current, msg);
}

async function handleEchoMessage(
  panel: vscode.WebviewPanel,
  userId: string,
  msg: EchoWebviewToHost,
  state: PanelState
): Promise<void> {
  switch (msg.type) {
    case "echo_ready": {
      // Seed with today's dashboard + preferences on first mount.
      state.currentWindow = "today";
      await sendDashboard(panel, userId, "today");
      await sendPreferences(panel, userId);
      return;
    }
    case "echo_request": {
      state.currentWindow = msg.window;
      await sendDashboard(panel, userId, msg.window);
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
          headers: { ...authHeaders(userId) },
          body: JSON.stringify({ storyModeNotify: msg.enabled }),
        });
      } catch {
        // Offline — preference updates will retry next time the panel opens.
      }
      await sendPreferences(panel, userId);
      return;
    }
    case "echo_refreshPreferences": {
      await sendPreferences(panel, userId);
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
            headers: { "content-type": "application/json", ...authHeaders(userId) },
            body: JSON.stringify({ concept: msg.concept, status: msg.status }),
          }
        );
      } catch {
        // Offline — swallow. The tile stays in its current visual state
        // until the next successful round-trip.
      }
      await sendDashboard(panel, userId, state.currentWindow);
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
            headers: { "content-type": "application/json", ...authHeaders(userId) },
            body: JSON.stringify({ echoConceptLanguage: next }),
          }
        );
      } catch {
        // Offline — the picker will show the old value; the user can
        // retry when the network comes back.
      }
      await sendDashboard(panel, userId, state.currentWindow);
      return;
    }
    case "echo_rescanRepo": {
      const root = currentWorkspaceRoot();
      if (!root) return;
      try {
        await clearScannedWorkspace(state.context, root);
      } catch {
        // Non-fatal — if the globalState write fails, the forced scan
        // below still overrides the cached flag in memory.
      }
      void maybeKickWorkspaceScan(state.context, panel, userId, true);
      return;
    }
    default:
      return;
  }
}

async function sendDashboard(
  panel: vscode.WebviewPanel,
  userId: string,
  window: EchoWindow
): Promise<void> {
  postToEchoPanel(panel, { type: "echo_dashboardLoading", window });
  // Flush pending events before asking the backend to aggregate — without
  // this, dashboard queries race the 2-min flush interval and show stale
  // numbers. Flush failures are non-fatal; events stay queued for next try.
  try {
    await getBatcher()?.flush();
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
  try {
    const res = await fetch(
      `${BACKEND_URL}/echo/dashboard?window=${window}&userId=${encodeURIComponent(userId)}${workspaceParam}`,
      { headers: { ...authHeaders(userId) } }
    );
    if (!res.ok) {
      postToEchoPanel(panel, {
        type: "echo_dashboardError",
        window,
        error: `HTTP ${res.status}`,
      });
      return;
    }
    const data = (await res.json()) as DashboardResponse;
    postToEchoPanel(panel, { type: "echo_dashboard", window, data });
  } catch (err) {
    postToEchoPanel(panel, {
      type: "echo_dashboardError",
      window,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function sendPreferences(
  panel: vscode.WebviewPanel,
  userId: string
): Promise<void> {
  try {
    const res = await fetch(
      `${BACKEND_URL}/echo/preferences?userId=${encodeURIComponent(userId)}`,
      { headers: { ...authHeaders(userId) } }
    );
    if (!res.ok) {
      postToEchoPanel(panel, {
        type: "echo_preferences",
        preferences: { storyModeNotify: false },
      });
      return;
    }
    const body = (await res.json()) as { preferences?: Partial<EchoUserPreferences> };
    postToEchoPanel(panel, {
      type: "echo_preferences",
      preferences: {
        storyModeNotify: !!body.preferences?.storyModeNotify,
        echoConceptLanguage: body.preferences?.echoConceptLanguage ?? null,
      },
    });
  } catch {
    postToEchoPanel(panel, {
      type: "echo_preferences",
      preferences: { storyModeNotify: false },
    });
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
  const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource}; connect-src ${webview.cspSource} http://localhost:8787 http://127.0.0.1:8787;`;

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
