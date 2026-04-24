import * as vscode from "vscode";

/**
 * Voice state chip in VS Code's status bar — always visible, even when
 * the Protege sidebar is closed. Mirrors the colored state chip from
 * VoiceMode so the user can glance-read what the system is doing without
 * opening the panel. Click → reveal the Protege launcher.
 */

export type VoiceState =
  | "off" // wake listener disabled
  | "idle" // wake listener on, nothing happening
  | "listening" // user is speaking / mic is capturing
  | "thinking" // STT running or Claude generating
  | "speaking" // bot TTS playing
  | "error"; // recent failure

let item: vscode.StatusBarItem | null = null;
let currentState: VoiceState = "off";

const ICON: Record<VoiceState, string> = {
  off: "mic-filled",
  idle: "mic",
  listening: "pulse",
  thinking: "sync~spin",
  speaking: "unmute",
  error: "warning",
};

const LABEL: Record<VoiceState, string> = {
  off: "Protege · Wake OFF",
  idle: "Protege · Wake ON",
  listening: "Protege · Listening",
  thinking: "Protege · Thinking",
  speaking: "Protege · Speaking",
  error: "Protege · Voice error",
};

/** Map each state to a VS Code theme color. Uses terminal ANSI colors
 *  so the chip reads well on both light + dark themes without us
 *  hard-coding hex. */
const COLOR_ID: Record<VoiceState, string | undefined> = {
  off: undefined, // default foreground — muted
  idle: "statusBar.foreground",
  listening: "terminal.ansiBlue",
  thinking: "terminal.ansiYellow",
  speaking: "terminal.ansiGreen",
  error: "errorForeground",
};

export function registerVoiceStatusBar(
  context: vscode.ExtensionContext
): vscode.Disposable[] {
  item = vscode.window.createStatusBarItem(
    "protege.voiceState",
    vscode.StatusBarAlignment.Right,
    // Priority 99 — sits left of most built-in items but right of other
    // Protege status entries so voice is prominent.
    99
  );
  item.name = "Protege Voice";
  // Click toggles wake on/off. Sidebar/launcher open stays on the
  // protege.toggle command, accessible from Cmd+Shift+P.
  item.command = "protege.toggleWake";
  render(currentState);
  item.show();

  context.subscriptions.push(item);
  return [item];
}

export function setVoiceState(state: VoiceState): void {
  if (!item) return;
  if (state === currentState) return;
  currentState = state;
  render(state);
}

function render(state: VoiceState): void {
  if (!item) return;
  item.text = `$(${ICON[state]}) ${LABEL[state]}`;
  const colorId = COLOR_ID[state];
  item.color = colorId ? new vscode.ThemeColor(colorId) : undefined;
  item.tooltip =
    state === "off"
      ? 'Wake word is off. Click to turn on — then say "Protege".'
      : state === "error"
      ? "Voice engine hit an error. Click to toggle wake off/on."
      : `Protege voice · ${LABEL[state].toLowerCase()}. Click to turn wake off.`;
}

/** Call when wake-word `error` fires. Auto-recovers to idle after 4s so
 *  the chip doesn't stay red forever. */
export function flashVoiceError(): void {
  setVoiceState("error");
  setTimeout(() => {
    if (currentState === "error") setVoiceState("idle");
  }, 4000);
}
