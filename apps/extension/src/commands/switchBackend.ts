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
 * Developer-mode gate. The backend switcher is an internal admin tool —
 * end users should never see it (or have the ability to point Protege at
 * arbitrary backends). To enable, set `protege.developerMode: true` in
 * your user-global settings.json, OR launch Cursor with PROTEGE_DEV=1
 * in the environment.
 */
function isDeveloperMode(): boolean {
  if (process.env.PROTEGE_DEV === "1" || process.env.PROTEGE_DEV === "true") {
    return true;
  }
  try {
    return (
      vscode.workspace
        .getConfiguration("protege")
        .get<boolean>("developerMode") === true
    );
  } catch {
    return false;
  }
}

export function registerSwitchBackendCommand(): vscode.Disposable {
  // Don't even register the command for non-dev users. Without
  // registration, the command palette shows "Command 'protege.
  // switchBackend' not found" if someone discovers the id — exactly
  // the right behaviour: it's not a feature, it's an internal tool.
  if (!isDeveloperMode()) {
    return new vscode.Disposable(() => {});
  }

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

  return cmd;
}
