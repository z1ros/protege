import * as vscode from "vscode";
import type { Iq3TestRunResultEvent } from "@protege/types";
import { getBatcher } from "../../echo/batcher.js";

/**
 * Subscribe to VS Code's Test API. The `vscode.tests.onDidChangeTestResults`
 * event is part of the `testObserver` proposed API — only available when
 * the extension declares it in package.json#enabledApiProposals AND is
 * launched with --enable-proposed-api. Production marketplace builds
 * cannot use proposed APIs.
 *
 * To stay production-safe, this producer:
 *   - Feature-detects vscode.tests at runtime
 *   - Wraps the subscription in try/catch
 *   - Silently no-ops if the proposed API is unavailable
 *
 * Result: in production, no test_run_result events fire (acceptable —
 * Phase A has 2 other producers carrying signal). In dev host with the
 * proposal flag, full functionality.
 */
let _warned = false;
function warnUnavailable(reason: string) {
  if (_warned) return;
  _warned = true;
  console.warn(
    `[iq3.testRunResult] disabled (${reason}). ` +
    `To enable in dev: add "testObserver" to package.json#enabledApiProposals ` +
    `and launch with --enable-proposed-api protege-ai.protege.`,
  );
}

export function startTestRunProducer(ctx: vscode.ExtensionContext) {
  const testsApi = (vscode as any).tests;

  if (!testsApi || typeof testsApi.onDidChangeTestResults !== "function") {
    warnUnavailable("vscode.tests proposed API not available");
    return;
  }

  let sub: vscode.Disposable | null = null;
  try {
    sub = testsApi.onDidChangeTestResults(() => {
      try {
        const results = testsApi.testResults;
        if (!results || results.length === 0) return;
        const latest = results[0] as any;
        let tests = 0;
        let passed = 0;
        let durationMs = 0;
        let file = "<unknown>";
        walk(latest.results ?? [], (item: any) => {
          tests++;
          const states = item.taskStates as Array<{ state?: number }> | undefined;
          if (states && states.some((s) => s.state === 3 /* Passed */)) passed++;
          if (typeof item.duration === "number") durationMs += item.duration;
          if (item.uri) file = vscode.workspace.asRelativePath(item.uri);
        });
        const event: Iq3TestRunResultEvent = {
          type: "test_run_result",
          ts: Date.now(),
          file,
          tests,
          passed,
          durationMs,
          trigger: "manual",
        };
        getBatcher()?.push(event);
      } catch (innerErr) {
        // Swallow — broken test snapshot shouldn't crash anything.
        console.warn("[iq3.testRunResult] error reading test results:", innerErr);
      }
    });
  } catch (subErr) {
    warnUnavailable(`subscription rejected: ${(subErr as Error)?.message ?? String(subErr)}`);
    return;
  }

  if (sub) {
    ctx.subscriptions.push(sub);
  }
}

function walk(items: any[], fn: (i: any) => void) {
  for (const i of items) {
    fn(i);
    if (Array.isArray(i.children)) walk(i.children, fn);
  }
}
