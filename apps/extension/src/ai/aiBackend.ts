import * as vscode from "vscode";
import type { ChatTier } from "@protege/types";
import { runSingleQuery } from "../chat/chatRunner.js";

/**
 * AI Backend Selector — routes queries to the cloud provider.
 *
 * On-device (Qwen / llama.cpp) was retired 2026-05-01; cloud is the
 * only path. The AiBackend type is kept as a single-member union so
 * callers that read/write the persisted preference compile unchanged.
 */

export type AiBackend = "cloud";
export type ActualBackend = "cloud";

const STATE_KEY = "protege.aiBackend";

/**
 * Per-hour budget for AUTO-FIRED cloud calls (kind === "scan"). User-
 * triggered teach calls bypass this cap entirely. Configurable via the
 * `protege.autoBudgetPerHour` setting.
 */
const AUTO_BUDGET_DEFAULT = 30;
const AUTO_BUDGET_WINDOW_MS = 60 * 60_000;
let autoBudgetWindowStart = Date.now();
let autoBudgetSpent = 0;

function getAutoBudgetPerHour(): number {
  const raw = vscode.workspace
    .getConfiguration("protege")
    .get<number>("autoBudgetPerHour", AUTO_BUDGET_DEFAULT);
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    return AUTO_BUDGET_DEFAULT;
  }
  return Math.floor(raw);
}

function consumeAutoBudget(): { ok: boolean; cap: number; spent: number } {
  const cap = getAutoBudgetPerHour();
  const now = Date.now();
  if (now - autoBudgetWindowStart >= AUTO_BUDGET_WINDOW_MS) {
    autoBudgetWindowStart = now;
    autoBudgetSpent = 0;
  }
  if (autoBudgetSpent >= cap) return { ok: false, cap, spent: autoBudgetSpent };
  autoBudgetSpent++;
  return { ok: true, cap, spent: autoBudgetSpent };
}

const currentBackend: AiBackend = "cloud";
let ctx: vscode.ExtensionContext | null = null;

export interface LastCallInfo {
  backend: ActualBackend;
  atMs: number;
  durationMs: number;
  ok: boolean;
  fallback?: { requested: AiBackend; reason: string };
  feature?: string;
  outcome?: "llm-scan" | "render-only" | "cache-hit" | "static-fallback" | "error";
}
let lastCall: LastCallInfo | null = null;
const callListeners: Array<(info: LastCallInfo) => void> = [];

export function initAiBackend(context: vscode.ExtensionContext): void {
  ctx = context;
  // Migrate any legacy persisted value (haiku/sonnet/on-device/auto) to
  // "cloud" so the Live tab no longer reports a stale preference.
  const raw = context.globalState.get<string>(STATE_KEY);
  if (raw && raw !== "cloud") {
    void context.globalState.update(STATE_KEY, "cloud");
  }
}

export function setAiBackend(_backend: AiBackend): void {
  if (ctx) {
    void ctx.globalState.update(STATE_KEY, "cloud");
  }
  void (async () => {
    try {
      const { broadcast } = await import("../chat/webviewHost.js");
      broadcast({ type: "ai/backend", backend: "cloud" });
    } catch {
      /* webview module not loaded yet */
    }
  })();
}

export function getAiBackend(): AiBackend {
  return currentBackend;
}

export function getLastCall(): LastCallInfo | null {
  return lastCall;
}

export function onBackendCall(cb: (info: LastCallInfo) => void): () => void {
  callListeners.push(cb);
  return () => {
    const i = callListeners.indexOf(cb);
    if (i >= 0) callListeners.splice(i, 1);
  };
}

function recordCall(info: LastCallInfo): void {
  lastCall = info;
  for (const cb of callListeners) {
    try { cb(info); } catch {}
  }
}

export type AiIntent = "scan" | "teach";

/**
 * Send a query to the cloud AI provider.
 *
 * @param prompt — the prompt to send
 * @param maxTokens — legacy; ignored (cloud reply length is server-side).
 * @param opts.kind — "scan" (cheap, budget-gated) or "teach" (premium).
 */
export async function aiQuery(
  prompt: string,
  _maxTokens = 256,
  opts: { kind?: AiIntent; tier?: ChatTier; forceBackend?: AiBackend } = {}
): Promise<string | null> {
  const kind: AiIntent = opts.kind ?? "scan";
  const tier: ChatTier =
    opts.tier ?? (kind === "scan" ? "cheap" : "premium");

  // Budget gate: cap auto-fired cloud scans. Teach calls bypass.
  if (kind === "scan") {
    const budget = consumeAutoBudget();
    if (!budget.ok) {
      recordCall({
        backend: "cloud",
        atMs: Date.now(),
        durationMs: 0,
        ok: false,
        fallback: {
          requested: "cloud",
          reason: `auto-fire budget exhausted (${budget.cap}/h)`,
        },
      });
      console.log(
        `[protege] aiQuery(scan) → skipped · auto-fire budget exhausted (${budget.spent}/${budget.cap} this hour)`
      );
      return null;
    }
  }

  // Caller-trace diagnostic — first stack frame outside aiBackend.ts.
  const callerTrace = (() => {
    const stack = new Error().stack ?? "";
    const lines = stack.split("\n").slice(1);
    for (const line of lines) {
      if (line.includes("aiBackend") || line.includes("chatRunner")) continue;
      const m = line.match(/at (\S+) \(.*?([^/\\]+:\d+):\d+\)/) ??
                line.match(/at .*?([^/\\]+:\d+):\d+/);
      if (m) return m.length === 3 ? `${m[1]} · ${m[2]}` : m[1];
      return line.trim();
    }
    return "unknown caller";
  })();
  const promptPreview = prompt.slice(0, 60).replace(/\s+/g, " ");
  console.log(
    `[protege] aiQuery FIRE · ${kind}/${tier} · caller=${callerTrace} · prompt="${promptPreview}…"`
  );

  const start = Date.now();
  try {
    const result = await runSingleQuery(prompt, { tier });
    const duration = Date.now() - start;
    recordCall({
      backend: "cloud",
      atMs: Date.now(),
      durationMs: duration,
      ok: true,
    });
    console.log(
      `[protege] aiQuery(${kind}, ${tier}) → cloud · ${duration}ms · caller=${callerTrace}`
    );
    return result;
  } catch (err) {
    const duration = Date.now() - start;
    recordCall({
      backend: "cloud",
      atMs: Date.now(),
      durationMs: duration,
      ok: false,
    });
    console.log(
      `[protege] aiQuery FAIL · ${kind}/${tier} · caller=${callerTrace} · ${err instanceof Error ? err.message : String(err)}`
    );
    console.error("[protege] Cloud AI query failed:", err);
    return null;
  }
}

export function getActiveBackendName(): string {
  return "Cloud (provider configured server-side)";
}
