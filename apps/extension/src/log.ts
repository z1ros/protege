import * as vscode from "vscode";

/**
 * Shared output channel for every Protege scan tier. Any module can call
 * `log("reviewEngine", "scan started")` and the line lands in the
 * `Protege` output channel with a consistent timestamp + tag prefix.
 *
 * Why not `console.log`? Extension-host `console` lands in the Extension
 * Host debug console, which requires Developer Tools to open. The
 * `Output` panel is one click for users, so they can see what Protege is
 * thinking while they work. The smoke-test command (`protege.showLogs`)
 * reveals the channel so they don't need to hunt for it.
 */

let channel: vscode.OutputChannel | null = null;

function ensureChannel(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel("Protege");
  }
  return channel;
}

/** One log line with timestamp + module tag. */
export function log(tag: string, message: string): void {
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  ensureChannel().appendLine(`[${ts}] [${tag}] ${message}`);
}

/** Log a multi-line block (e.g. raw LLM output) with a boxed header. */
export function logBlock(tag: string, header: string, body: string): void {
  const ch = ensureChannel();
  const ts = new Date().toISOString().slice(11, 23);
  ch.appendLine(`[${ts}] [${tag}] ───── ${header} ─────`);
  for (const line of body.split("\n")) ch.appendLine(`    ${line}`);
  ch.appendLine(`[${ts}] [${tag}] ───── end ─────`);
}

/** Reveal the output channel (used by `protege.showLogs` command). */
export function showLogs(): void {
  ensureChannel().show(true);
}

/** Expose the channel for module owners that still want `appendLine` directly. */
export function getOutputChannel(): vscode.OutputChannel {
  return ensureChannel();
}
