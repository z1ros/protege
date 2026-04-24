import * as vscode from "vscode";
import * as path from "node:path";
import type { EchoEvent } from "@protege/types";
import { getBatcher } from "./batcher.js";

/**
 * Diagnostic live tail of every EchoEvent the batcher observes. Formats
 * each event onto a single line in a dedicated OutputChannel so the user
 * can type code and watch the extension → batcher → backend pipeline fire
 * in real time.
 *
 * Start AFTER startBatcher() so getBatcher() is non-null.
 */

let channel: vscode.OutputChannel | null = null;

export function getEventStreamChannel(): vscode.OutputChannel | null {
  return channel;
}

export function startEventStream(
  _context: vscode.ExtensionContext
): vscode.Disposable {
  channel = vscode.window.createOutputChannel("Protege Echo Events");
  const batcher = getBatcher();
  let unsubscribe: (() => void) | null = null;
  if (batcher) {
    unsubscribe = batcher.onPush((e) => {
      try {
        channel?.appendLine(formatEvent(e));
      } catch {
        // A broken formatter shouldn't crash the batcher subscription.
      }
    });
  }

  return new vscode.Disposable(() => {
    if (unsubscribe) unsubscribe();
    channel?.dispose();
    channel = null;
  });
}

function formatEvent(e: EchoEvent): string {
  const ts = formatTime(e.ts);
  const type = e.type.padEnd(24, " ");
  const fields = fieldsForEvent(e);
  return `[${ts}] ${type} ${fields}`;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function basename(file: string): string {
  if (!file.includes("/") && !file.includes("\\")) return file;
  return path.basename(file);
}

function kv(pairs: Array<[string, unknown]>): string {
  const out: string[] = [];
  for (const [k, v] of pairs) {
    if (v === undefined || v === null) continue;
    out.push(`${k}=${String(v)}`);
  }
  return out.join(" ");
}

function fieldsForEvent(e: EchoEvent): string {
  switch (e.type) {
    case "keystroke_batch":
      return kv([
        ["file", basename(e.file)],
        ["charsTyped", e.charsTyped],
        ["lang", e.language],
      ]);
    case "line_diff":
      return `${kv([["file", basename(e.file)]])} +${e.linesAdded} -${e.linesRemoved} rewrites=${Array.isArray(e.rewrittenFingerprints) ? e.rewrittenFingerprints.length : 0}`;
    case "concept_encountered":
      return kv([
        ["file", basename(e.file)],
        ["concept", e.concept],
        ["lang", e.language ?? undefined],
      ]);
    case "ai_suggestion_accepted":
      return kv([
        ["file", basename(e.file)],
        ["charsAccepted", e.charsAccepted ?? e.chars],
      ]);
    case "paste_classified":
      return kv([
        ["file", basename(e.file)],
        ["kind", e.source],
        ["chars", e.chars],
      ]);
    case "session_tick":
      return `${kv([["file", e.file ? basename(e.file) : undefined], ["kind", "tick"]])} stretch=${e.focusStretchMs}`;
    case "session_boundary":
      return `${kv([["kind", e.kind]])} stretch=${e.activeMs ?? 0}`;
    case "commit_detected":
      return kv([
        ["sha", e.sha],
        ["message", truncate(e.message, 60)],
        ["files", Array.isArray(e.filesTouched) ? e.filesTouched.length : 0],
      ]);
    default: {
      // Unknown — dump the full event minus ts/type, truncated.
      const rest = { ...(e as Record<string, unknown>) };
      delete rest.ts;
      delete rest.type;
      let str: string;
      try {
        str = JSON.stringify(rest);
      } catch {
        str = "[unserializable]";
      }
      return truncate(str, 200);
    }
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
