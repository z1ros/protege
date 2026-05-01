import * as vscode from "vscode";
import { PROD_BACKEND_URL, LOCAL_BACKEND_URL } from "../user/protegeClient.js";

/**
 * Backend URL switcher — quick-pick to flip between production
 * (Railway) and local dev (http://localhost:8787) without editing
 * settings.json by hand.
 *
 * `BACKEND_URL` is read once at module load in protegeClient.ts, so a
 * window reload is required for the change to take effect. The command
 * offers to do the reload automatically.
 */

interface BackendOption {
  label: string;
  description: string;
  detail: string;
  url: string | null; // null = clear setting (use default = prod)
  isCurrent?: boolean;
}

function getCurrentBackendUrl(): string {
  const setting = vscode.workspace
    .getConfiguration("protege")
    .get<string>("backendUrl");
  if (setting && setting.trim()) return setting.trim();
  const envOverride = process.env.PROTEGE_BACKEND_URL;
  if (envOverride && envOverride.trim()) return envOverride.trim();
  return PROD_BACKEND_URL;
}

function describeCurrent(): string {
  const url = getCurrentBackendUrl();
  if (url === PROD_BACKEND_URL) return "Production (Railway)";
  if (url === LOCAL_BACKEND_URL) return "Local (http://localhost:8787)";
  return `Custom: ${url}`;
}

/**
 * Status-bar indicator showing the current backend, clickable to fire
 * the switch command. Lives left-side, low-priority so it doesn't
 * fight the more frequently-used items.
 *
 * Disposed alongside the command registration.
 */
function createBackendStatusBarItem(): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    50
  );
  item.command = "protege.switchBackend";
  item.tooltip = "Click to switch the Protege backend (Production ↔ Local)";
  refreshBackendStatusBarItem(item);
  item.show();
  return item;
}

function refreshBackendStatusBarItem(item: vscode.StatusBarItem): void {
  const url = getCurrentBackendUrl();
  if (url === PROD_BACKEND_URL) {
    item.text = "$(cloud) Protege: Prod";
    item.backgroundColor = undefined;
  } else if (url === LOCAL_BACKEND_URL) {
    item.text = "$(plug) Protege: Local";
    // Highlight when on a non-prod target so it's hard to forget
    // you're not hitting production. Subtle warning bg.
    item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
  } else {
    item.text = "$(question) Protege: Custom";
    item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
  }
}

export function registerSwitchBackendCommand(): vscode.Disposable {
  // Status-bar item lives for the extension lifetime; we wrap it in
  // the command's disposable so deactivate cleans both up.
  const statusBarItem = createBackendStatusBarItem();

  // Keep the status bar in sync if the user edits settings.json by
  // hand instead of using the command. Without this, the indicator
  // would stay stale until next reload.
  const configWatcher = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("protege.backendUrl")) {
      refreshBackendStatusBarItem(statusBarItem);
    }
  });

  const cmd = vscode.commands.registerCommand(
    "protege.switchBackend",
    async () => {
      const current = getCurrentBackendUrl();

      const options: BackendOption[] = [
        {
          label: "Production",
          description: "Railway-hosted backend",
          detail: PROD_BACKEND_URL,
          url: null, // null clears the setting → falls through to default (prod)
          isCurrent: current === PROD_BACKEND_URL,
        },
        {
          label: "Local",
          description: "pnpm dev on port 8787",
          detail: LOCAL_BACKEND_URL,
          url: LOCAL_BACKEND_URL,
          isCurrent: current === LOCAL_BACKEND_URL,
        },
        {
          label: "Custom URL…",
          description: "Enter a different backend URL",
          detail: "Self-hosted, staging, etc.",
          url: "__custom__",
        },
      ];

      const picked = await vscode.window.showQuickPick(
        options.map((o) => ({
          label: o.isCurrent ? `$(check) ${o.label}` : `        ${o.label}`,
          description: o.description,
          detail: o.detail,
          option: o,
        })),
        {
          title: `Protege backend — currently: ${describeCurrent()}`,
          placeHolder: "Pick a backend to point Protege at",
          matchOnDescription: true,
        }
      );

      if (!picked) return;
      const choice = picked.option;

      let newUrl: string | undefined;
      if (choice.url === "__custom__") {
        const input = await vscode.window.showInputBox({
          title: "Custom Protege backend URL",
          prompt: "Full URL including protocol (no trailing slash)",
          placeHolder: "https://staging.protege.example.com",
          validateInput: (v) => {
            if (!v.trim()) return "URL required";
            if (!/^https?:\/\//i.test(v.trim())) return "Must start with http:// or https://";
            return null;
          },
        });
        if (!input) return;
        newUrl = input.trim();
      } else {
        // null URL → clear the setting (so resolveBackendUrl falls back to PROD)
        newUrl = choice.url ?? undefined;
      }

      // Persist at user-global scope so the choice survives across all
      // workspaces. A workspace-scoped override is rarely what users
      // want — it's a "which environment am I testing against" toggle,
      // not a per-project preference.
      const config = vscode.workspace.getConfiguration("protege");
      try {
        await config.update(
          "backendUrl",
          newUrl,
          vscode.ConfigurationTarget.Global
        );
      } catch (err) {
        vscode.window.showErrorMessage(
          `Couldn't update backend URL: ${err instanceof Error ? err.message : String(err)}`
        );
        return;
      }

      const labelNow = newUrl
        ? newUrl === LOCAL_BACKEND_URL
          ? "Local"
          : "Custom"
        : "Production";

      const reload = await vscode.window.showInformationMessage(
        `Protege backend → ${labelNow}. Reload window to apply?`,
        "Reload",
        "Later"
      );
      if (reload === "Reload") {
        await vscode.commands.executeCommand("workbench.action.reloadWindow");
      }
    }
  );

  // Bundle all three so deactivate cleans them up together.
  return vscode.Disposable.from(cmd, statusBarItem, configWatcher);
}
