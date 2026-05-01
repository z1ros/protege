import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { recordSingleUtterance, scoreWavAgainstWakeModel } from "./voiceCapture.js";

const STATE_KEY_THRESHOLD = "protege.wakeWordThreshold";
const STATE_KEY_CALIBRATED = "protege.wakeWordCalibrated";
const STATE_KEY_WAKE_ENABLED = "protege.wakeListenerEnabled";
const STATE_KEY_PROMPT_DEFERRED_AT = "protege.wakeWordPromptDeferredAt";

/** Re-prompt cooldown when the user clicks "Later" on the first-run
 *  calibration popup. Without this we'd ask on every single Cursor
 *  restart, which the user explicitly flagged as nag behaviour. */
const PROMPT_DEFER_MS = 7 * 24 * 60 * 60_000;

/** Threshold used when the user has not calibrated yet. Tuned for the
 *  LiveKit-trained model (2026-04-18): real-voice peaks 0.22–0.28,
 *  background noise tops ~0.18. See main.rs.
 *
 *  Bumped 2026-05-01 from 0.135 → 0.18 (the documented noise ceiling).
 *  The old 0.135 floor sat BELOW the noise ceiling, so the wake binary
 *  could fire on background noise alone — which is exactly the
 *  false-positive class users hit. 0.18 is the sweet spot:
 *    - just above noise (no false fires from room tone, fans, music
 *      bleed, or short ambient spikes)
 *    - well below voice floor (real "Protege" still trips at 0.22+)
 *
 *  Cost: a very softly spoken "Protege" might land at 0.18-0.21 and
 *  miss. Users who genuinely speak softly can recalibrate via
 *  "Protege: Calibrate Wake Word" — that command picks an empirical
 *  threshold from their actual voice samples. The 2026-04-22 history
 *  ("okay okay" triggering at 0.178) confirms 0.18 is a safe floor. */
export const DEFAULT_WAKE_THRESHOLD = 0.18;

const MIN_THRESHOLD = 0.18;
const MAX_THRESHOLD = 0.35;
const SAMPLES_REQUIRED = 3;

export function getStoredWakeThreshold(context: vscode.ExtensionContext): number {
  const v = context.globalState.get<number>(STATE_KEY_THRESHOLD);
  if (typeof v === "number" && Number.isFinite(v) && v <= MAX_THRESHOLD) {
    // Clamp low values (from stale calibrations done before the floor was
    // raised) up to MIN_THRESHOLD. Anything above the floor passes through.
    return Math.max(v, MIN_THRESHOLD);
  }
  return DEFAULT_WAKE_THRESHOLD;
}

export function hasCompletedWakeCalibration(context: vscode.ExtensionContext): boolean {
  return context.globalState.get<boolean>(STATE_KEY_CALIBRATED) === true;
}

/** Returns true when the first-run calibration prompt should be shown:
 *  user hasn't completed calibration AND hasn't clicked "Later" within
 *  the last week. Otherwise we stay quiet — the command palette entry
 *  (`Protege: Calibrate wake word`) is always available for manual use. */
export function shouldShowCalibrationPrompt(context: vscode.ExtensionContext): boolean {
  if (hasCompletedWakeCalibration(context)) return false;
  const deferredAt = context.globalState.get<number>(STATE_KEY_PROMPT_DEFERRED_AT);
  if (typeof deferredAt === "number" && Date.now() - deferredAt < PROMPT_DEFER_MS) {
    return false;
  }
  return true;
}

export async function recordCalibrationPromptDeferred(
  context: vscode.ExtensionContext
): Promise<void> {
  await context.globalState.update(STATE_KEY_PROMPT_DEFERRED_AT, Date.now());
}

/** Whether the wake-word listener should be on. Defaults to TRUE for new
 *  users so voice-first is the out-of-box experience. Persists per-user in
 *  globalState so the choice survives window reloads and VS Code restarts. */
export function getWakeEnabled(context: vscode.ExtensionContext): boolean {
  const v = context.globalState.get<boolean>(STATE_KEY_WAKE_ENABLED);
  // undefined (first-ever launch) → true; explicit false stays false.
  return v === undefined ? true : v;
}

export async function setWakeEnabled(
  context: vscode.ExtensionContext,
  enabled: boolean
): Promise<void> {
  await context.globalState.update(STATE_KEY_WAKE_ENABLED, enabled);
}

function samplesDir(): string {
  const dir = path.join(os.homedir(), ".protege", "onboarding");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export async function runWakeCalibration(context: vscode.ExtensionContext): Promise<void> {
  const extensionPath = context.extensionUri.fsPath;

  const start = await vscode.window.showInformationMessage(
    "Calibrate wake word: you'll say 'Protege' 3 times, pausing briefly between each. Ready?",
    { modal: true },
    "Start",
    "Cancel"
  );
  if (start !== "Start") return;

  const peaks: number[] = [];

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Calibrating wake word", cancellable: true },
    async (progress, token) => {
      for (let i = 0; i < SAMPLES_REQUIRED; i++) {
        if (token.isCancellationRequested) throw new Error("cancelled");

        progress.report({
          message: `Say "Protege" — sample ${i + 1} of ${SAMPLES_REQUIRED}`,
          increment: i === 0 ? 0 : 100 / SAMPLES_REQUIRED,
        });

        let wav: Buffer;
        try {
          wav = await recordSingleUtterance(extensionPath, 8000);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`Recording sample ${i + 1} failed: ${msg}`);
        }

        const wavPath = path.join(samplesDir(), `sample-${i + 1}.wav`);
        fs.writeFileSync(wavPath, wav);

        let peak: number;
        try {
          peak = await scoreWavAgainstWakeModel(extensionPath, wavPath);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`Scoring sample ${i + 1} failed: ${msg}`);
        }

        peaks.push(peak);
        progress.report({ message: `Sample ${i + 1}: peak=${peak.toFixed(3)}` });

        if (i < SAMPLES_REQUIRED - 1) {
          await new Promise((r) => setTimeout(r, 600));
        }
      }
    }
  );

  // Empirically, calibration peaks (~0.35-0.40 on clean WAVs) run roughly 1.5x
  // higher than live-stream peaks (~0.22-0.28). Multiplier 0.5 compensates +
  // gives a safety margin below the expected live peak.
  const minPeak = Math.min(...peaks);
  const raw = minPeak * 0.5;
  const threshold = Math.max(MIN_THRESHOLD, Math.min(MAX_THRESHOLD, raw));

  await context.globalState.update(STATE_KEY_THRESHOLD, threshold);
  await context.globalState.update(STATE_KEY_CALIBRATED, true);

  const peakList = peaks.map((p) => p.toFixed(3)).join(", ");
  const clampNote =
    threshold !== raw ? ` (clamped to range ${MIN_THRESHOLD}–${MAX_THRESHOLD})` : "";

  const action = await vscode.window.showInformationMessage(
    `Wake word calibrated. Peaks: [${peakList}]. Threshold set to ${threshold.toFixed(3)}${clampNote}. Restart the listener to apply.`,
    "Restart listener"
  );

  if (action === "Restart listener") {
    await vscode.commands.executeCommand("protege.restartWakeListener");
  }
}
