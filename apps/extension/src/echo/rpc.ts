import * as vscode from "vscode";
import type {
  EchoHostToWebview,
  EchoWebviewToHost,
} from "@protege/types";

/**
 * Typed Echo RPC. Thin wrapper so any module posting messages into the
 * Echo webview goes through the shared union — stray payloads never
 * reach the panel.
 */

export type EchoMessageFromWebview = EchoWebviewToHost;
export type EchoMessageToWebview = EchoHostToWebview;

export function postToEchoPanel(
  panel: vscode.WebviewPanel,
  msg: EchoMessageToWebview
): void {
  try {
    panel.webview.postMessage(msg);
  } catch {
    // Panel may have disposed between flush scheduling and dispatch.
  }
}

export function isEchoMessage(value: unknown): value is EchoWebviewToHost {
  if (!value || typeof value !== "object") return false;
  const t = (value as { type?: unknown }).type;
  if (typeof t !== "string") return false;
  return (
    t === "echo_ready" ||
    t === "echo_request" ||
    t === "echo_setSubPage" ||
    t === "echo_openMoment" ||
    t === "echo_notifyStoryMode" ||
    t === "echo_refreshPreferences" ||
    t === "echo_setConceptStatus" ||
    t === "echo_setConceptLanguage" ||
    t === "echo_rescanRepo"
  );
}
