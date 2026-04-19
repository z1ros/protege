import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { recordSingleUtterance, scoreWavAgainstWakeModel } from "./voiceCapture.js";

const STATE_KEY_THRESHOLD = "protege.wakeWordThreshold";
const STATE_KEY_CALIBRATED = "protege.wakeWordCalibrated";

/** Threshold used when the user has not calibrated yet. Tuned for the
 *  LiveKit-trained model (2026-04-18): real-voice peaks 0.22–0.28,
 *  background noise tops ~0.18. See main.rs. */
export const DEFAULT_WAKE_THRESHOLD = 0.18;

const MIN_THRESHOLD = 0.12;
const MAX_THRESHOLD = 0.35;
const SAMPLES_REQUIRED = 3;

export function getStoredWakeThreshold(context: vscode.ExtensionContext): number {
  const v = context.globalState.get<number>(STATE_KEY_THRESHOLD);
  if (typeof v === "number" && Number.isFinite(v) && v >= MIN_THRESHOLD && v <= MAX_THRESHOLD) {
    return v;
  }
  return DEFAULT_WAKE_THRESHOLD;
}

export function hasCompletedWakeCalibration(context: vscode.ExtensionContext): boolean {
  return context.globalState.get<boolean>(STATE_KEY_CALIBRATED) === true;
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
