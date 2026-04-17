import * as vscode from "vscode";
import { generateLocal, isOnDeviceReady } from "./onDeviceModel.js";
import { runSingleQuery } from "./chatRunner.js";

/**
 * AI Backend Selector — routes queries to the right model.
 *
 * The user chooses their preferred backend in the Live tab:
 *   - "on-device" → Qwen 1.5B via llama.cpp (free, instant, offline)
 *   - "haiku"     → Claude Haiku 4.5 via API (fast, cheap, cloud)
 *   - "sonnet"    → Claude Sonnet 4.5 via API (best quality, cloud)
 *   - "auto"      → on-device if ready, fall back to haiku
 *
 * All JARVIS features call `aiQuery()` instead of directly calling
 * Claude or the local model. This single function handles the routing.
 */

export type AiBackend = "on-device" | "haiku" | "sonnet" | "auto";

let currentBackend: AiBackend = "auto";

export function setAiBackend(backend: AiBackend): void {
  currentBackend = backend;
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("protege:ai-backend", backend);
    }
  } catch {}
}

export function getAiBackend(): AiBackend {
  return currentBackend;
}

/**
 * Send a query to the AI — routed based on user preference.
 *
 * @param prompt — the prompt to send
 * @param maxTokens — max response length (only used for on-device)
 * @returns the response text, or null if all backends failed
 */
export async function aiQuery(
  prompt: string,
  maxTokens = 256
): Promise<string | null> {
  const backend = currentBackend;

  // On-device path
  if (backend === "on-device" || backend === "auto") {
    if (isOnDeviceReady()) {
      const result = await generateLocal(prompt, maxTokens);
      if (result) return result;
      // If on-device failed and we're "auto", fall through to cloud
      if (backend === "on-device") return null;
    } else if (backend === "on-device") {
      // User explicitly chose on-device but it's not ready
      return null;
    }
    // "auto" mode: on-device not ready, fall through to cloud
  }

  // Cloud path
  try {
    return await runSingleQuery(prompt);
  } catch (err) {
    console.error("[protege] Cloud AI query failed:", err);
    return null;
  }
}

/**
 * Get the name of the backend that would handle the next query.
 * Useful for showing "Powered by: Qwen 1.5B" or "Powered by: Haiku" in UI.
 */
export function getActiveBackendName(): string {
  if (currentBackend === "on-device") return "Qwen 1.5B (on-device)";
  if (currentBackend === "haiku") return "Claude Haiku 4.5";
  if (currentBackend === "sonnet") return "Claude Sonnet 4.5";
  // auto
  if (isOnDeviceReady()) return "Qwen 1.5B (on-device)";
  return "Claude Haiku 4.5 (fallback)";
}
