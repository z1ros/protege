import * as vscode from "vscode";
import type { Iq3TestRunResultEvent } from "@protege/types";
import { getBatcher } from "../../echo/batcher.js";

/**
 * Subscribe to VS Code's Test API. The `vscode.tests.onDidChangeTestResults`
 * event fires when any test extension publishes results. We aggregate
 * pass/fail counts and total duration from the latest snapshot.
 *
 * VS Code's TestResultSnapshot type is partially documented; defensive
 * casts handle the parts that vary by VS Code version.
 */
export function startTestRunProducer(ctx: vscode.ExtensionContext) {
  // Cast to any: `onDidChangeTestResults` + `testResults` are part of the
  // proposed Test Observer API and aren't yet in @types/vscode's stable
  // surface for our pinned engine. The runtime (VS Code 1.59+) ships them.
  const testsApi = vscode.tests as any;
  if (typeof testsApi?.onDidChangeTestResults !== "function") {
    // Older runtime — bail silently rather than throw on activation.
    return;
  }
  const sub: vscode.Disposable = testsApi.onDidChangeTestResults(() => {
    const results = testsApi.testResults as any[] | undefined;
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
  });
  ctx.subscriptions.push(sub);
}

function walk(items: any[], fn: (i: any) => void) {
  for (const i of items) {
    fn(i);
    if (Array.isArray(i.children)) walk(i.children, fn);
  }
}
