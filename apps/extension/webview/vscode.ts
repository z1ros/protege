import type { WebviewToHost, HostToWebview } from "@protege/types";

interface VsCodeApi {
  postMessage(msg: WebviewToHost): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

export const vscode: VsCodeApi = acquireVsCodeApi();

export function onHostMessage(cb: (msg: HostToWebview) => void) {
  const listener = (event: MessageEvent<HostToWebview>) => cb(event.data);
  window.addEventListener("message", listener);
  return () => window.removeEventListener("message", listener);
}
