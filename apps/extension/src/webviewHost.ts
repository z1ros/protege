import * as vscode from "vscode";
import type {
  WebviewToHost,
  HostToWebview,
  ChatMessage,
  Finding,
} from "@protege/types";
import { getUserId, fetchMe } from "./protegeClient.js";
import { runChat } from "./chatRunner.js";
import { getActiveFileEditor } from "./activeFile.js";

/**
 * Registry so outside code (analyzer, status bar) can broadcast messages
 * (like "iq/update") into every mounted Protege webview.
 */
const mountedWebviews = new Set<vscode.Webview>();

export function broadcast(msg: HostToWebview) {
  for (const w of mountedWebviews) {
    try {
      w.postMessage(msg);
    } catch {}
  }
}

export function pushTeachFinding(finding: Finding) {
  broadcast({ type: "teach/finding", finding });
}

export function mountProtegeWebview(
  webview: vscode.Webview,
  context: vscode.ExtensionContext
) {
  webview.options = {
    enableScripts: true,
    localResourceRoots: [
      vscode.Uri.joinPath(context.extensionUri, "dist", "webview"),
    ],
  };
  webview.html = renderHtml(webview, context.extensionUri);
  mountedWebviews.add(webview);

  const userId = getUserId(context);

  const sub = webview.onDidReceiveMessage(async (msg: WebviewToHost) => {
    if (msg.type === "chat/send") {
      await handleChat(webview, userId, msg.message, msg.mode ?? "text");
    } else if (msg.type === "ready") {
      sendInitialState(webview, userId);
    } else if (msg.type === "watcher/engage") {
      // User clicked "Help me" on a proactive nudge — escalate to Claude
      const synthetic = buildEngagePrompt(msg.triggerId, msg.context);
      await handleChat(webview, userId, synthetic, "text");
    } else if (msg.type === "openExternal") {
      // Webview can't call openExternal itself — bounce through the host.
      // Used for jumping to macOS Settings → Privacy → Microphone.
      try {
        await vscode.env.openExternal(vscode.Uri.parse(msg.url));
      } catch (err) {
        console.warn("[protege] openExternal failed:", err);
      }
    }
  });

  return vscode.Disposable.from(
    sub,
    new vscode.Disposable(() => mountedWebviews.delete(webview))
  );
}

async function sendInitialState(webview: vscode.Webview, userId: string) {
  // Send current active file info (using sticky last-real-editor)
  const editor = getActiveFileEditor();
  webview.postMessage({
    type: "file/active",
    file: editor
      ? { path: editor.document.fileName, language: editor.document.languageId }
      : null,
  } satisfies HostToWebview);

  // Send current Code IQ
  try {
    const me = await fetchMe(userId);
    webview.postMessage({
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
    } satisfies HostToWebview);
  } catch {
    // backend may be offline
  }
}

function post(webview: vscode.Webview, msg: HostToWebview) {
  webview.postMessage(msg);
}

/** Builds a natural-sounding synthetic user prompt that maps a nudge → Claude request. */
function buildEngagePrompt(
  triggerId: string,
  ctx: { filePath?: string; errorMessage?: string; errorLine?: number; concept?: string; note?: string }
): string {
  switch (triggerId) {
    case "error_persists":
      return `I've got this error stuck in ${ctx.filePath ?? "my file"} on line ${ctx.errorLine ?? "?"}: "${ctx.errorMessage ?? ""}". Can you look at it and teach me what's going on?`;
    case "struggle_cluster":
      return `I've been going back and forth on ${ctx.filePath ?? "this file"} — can you read it and tell me what I'm overthinking?`;
    case "stare_pause":
      return `I'm stuck on ${ctx.filePath ?? "this"}. Take a look and help me figure out where to go next.`;
    case "build_fail_loop":
      return `I keep saving ${ctx.filePath ?? "this file"} with errors. Can you trace through what's happening and explain it?`;
    case "commit_risk":
      return `I'm about to commit a bunch of files with no tests touched. Can you suggest a quick test for the main thing that changed?`;
    case "late_night_marathon":
      return `It's late and I've been at this a while. Can you write a quick resume-here summary of what I've been working on so I can pick it back up tomorrow?`;
    case "risky_edit":
      return `I just made a big change across several files. Can you review the diff and flag anything suspicious?`;
    default:
      return `Protege noticed something (${triggerId}) — can you take a look and help me?`;
  }
}

async function handleChat(
  webview: vscode.Webview,
  userId: string,
  message: string,
  mode: "text" | "voice"
) {
  post(webview, { type: "chat/loading", loading: true });

  try {
    const reply = await runChat(
      userId,
      message,
      {
        onTool: (call, status) => {
          post(webview, {
            type: "chat/tool",
            name: call.name,
            args: call.arguments,
            status,
          });
        },
      },
      { mode }
    );
    const assistant: ChatMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: reply,
      createdAt: new Date().toISOString(),
    };
    post(webview, { type: "chat/append", message: assistant });
  } catch (err) {
    post(webview, {
      type: "chat/error",
      error: err instanceof Error ? err.message : "Unknown error",
    });
  } finally {
    post(webview, { type: "chat/loading", loading: false });
  }
}

function renderHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri
): string {
  const base = vscode.Uri.joinPath(extensionUri, "dist", "webview");
  // Webview-safe URI for the dist/webview/ directory. Using this as the
  // <base href> makes every relative asset import inside the bundled JS
  // (e.g. "./assets/cathedral.png") resolve through VS Code's resource
  // protocol, so cinematic photos actually load.
  const baseUri = webview.asWebviewUri(base) + "/";
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(base, "assets", "index.js")
  );
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(base, "assets", "index.css")
  );
  const nonce = getNonce();
  const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline' https://fonts.googleapis.com; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data: blob:; font-src ${webview.cspSource} https://fonts.gstatic.com; connect-src ${webview.cspSource} http://localhost:8787 http://127.0.0.1:8787; media-src ${webview.cspSource} blob: data: http://localhost:8787 http://127.0.0.1:8787;`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<base href="${baseUri}" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<link rel="stylesheet" href="${styleUri}" />
<title>Protege</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
}

function getNonce() {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++)
    out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
