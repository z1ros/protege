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

// Watchdog: if the chip enters "listening" and nothing else transitions
// it for LISTENING_WATCHDOG_MS, force it back to "idle". The wake binary
// is supposed to pair every WAKE:detected with a RECORDING:stopped, but
// in practice false-positive wakes (bot voice bleed, ambient noise that
// the wake-word ONNX scores low-but-positive) sometimes leave the chip
// dangling. 13s = just past the binary's 12s recording safety cap. Any
// real recording finishes before this fires; a stuck "Listening" gets
// cleared 1s after the binary should have finished. Was 20s — felt too
// long when the chip was wrong, user reported "fake Listening".
const LISTENING_WATCHDOG_MS = 13_000;
let listeningWatchdog: ReturnType<typeof setTimeout> | null = null;

const ICON: Record<VoiceState, string> = {
  off: "mic-filled",
  idle: "mic",
  listening: "pulse",
  thinking: "sync~spin",
  // Speaker volume icon — semantically clear, paired with the
  // warningBackground flip in render() and the SPEAKING ●●● label
  // for unmissable visibility. Was briefly "broadcast~spin" but
  // ~spin only animates on a small whitelist of codicons (sync,
  // loading); broadcast renders static at best. The bg-color flip
  // is the dominant signal — the icon is just decoration.
  speaking: "unmute",
  error: "warning",
};

const LABEL: Record<VoiceState, string> = {
  // Off / idle are both rendered with an explicit ON / OFF tag so the
  // user can glance-read wake-listener state without clicking. Active
  // verbs (Listening, Thinking, Speaking) replace the on/off tag while
  // the system is doing something — those imply "wake is on".
  off: "Protege · OFF",
  idle: "Protege · ON",
  listening: "Protege · Listening",
  thinking: "Protege · Thinking",
  // Three dots + caps for stronger visual signal. Combined with the
  // background-color flip in render(), this makes the chip pop.
  speaking: "Protege · speaking",
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
  // "Listening" should NOT override an active Thinking or Speaking
  // state — those are running real work and a wake-fire mid-reply
  // (echo through speakers) shouldn't downgrade the chip.
  if (state === "listening") {
    if (currentState === "thinking" || currentState === "speaking") {
      return; // don't downgrade busy states
    }
  }
  if (state === currentState) return;
  currentState = state;
  // Cancel any prior watchdog — every state transition resets it.
  if (listeningWatchdog) {
    clearTimeout(listeningWatchdog);
    listeningWatchdog = null;
  }
  // Re-arm watchdog when we ENTER listening. False-positive wakes that
  // don't produce a normal RECORDING:stopped event (bot voice bleed,
  // brief ambient spikes) used to leave the chip stuck on "Listening"
  // until the next wake-firing — visibly broken UX. 20s window is
  // longer than any real recording (binary caps at 12s).
  if (state === "listening") {
    listeningWatchdog = setTimeout(() => {
      listeningWatchdog = null;
      if (currentState === "listening") {
        currentState = "idle";
        render("idle");
      }
    }, LISTENING_WATCHDOG_MS);
  }
  render(state);
}

function render(state: VoiceState): void {
  if (!item) return;
  item.text = `$(${ICON[state]}) ${LABEL[state]}`;
  const colorId = COLOR_ID[state];
  item.color = colorId ? new vscode.ThemeColor(colorId) : undefined;
  // BACKGROUND color flip for the most-attention-grabbing states.
  // VS Code only ships two background tokens for status-bar items
  // (warning + error); we co-opt warning for "speaking" so the chip
  // turns into a yellow/orange block that's impossible to miss while
  // the bot is talking. Listening + thinking stay foreground-only —
  // they're transient and a bg flash for every wake-fire would be
  // annoying. Error stays on errorBackground (most prominent).
  item.backgroundColor =
    state === "speaking"
      ? new vscode.ThemeColor("statusBarItem.warningBackground")
      : state === "error"
      ? new vscode.ThemeColor("statusBarItem.errorBackground")
      : undefined;
  item.tooltip =
    state === "off"
      ? 'Wake word is OFF. Click to turn ON — then say "Protege".'
      : state === "idle"
      ? 'Wake word is ON — say "Protege" to talk. Click to turn OFF.'
      : state === "error"
      ? "Voice engine hit an error. Click to toggle wake off/on."
      : `Protege voice · ${LABEL[state].toLowerCase()}. Click to turn wake OFF.`;
}

/** Call when wake-word `error` fires. Auto-recovers to idle after 4s so
 *  the chip doesn't stay red forever. */
export function flashVoiceError(): void {
  setVoiceState("error");
  setTimeout(() => {
    if (currentState === "error") setVoiceState("idle");
  }, 4000);
}

/** Read the user's preferred TTS voice gender from settings. Defaults to
 *  "female" (af_bella, the warmer voice). All `voice/playExplain`
 *  broadcast sites should pass this so the user's choice applies to
 *  voice mode replies, Ghost Lens explain, teaching narrations, etc. */
export function getVoiceGender(): "female" | "male" {
  const v = vscode.workspace
    .getConfiguration("protege")
    .get<string>("voice.gender", "female");
  return v === "male" ? "male" : "female";
}
