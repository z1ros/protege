import * as vscode from "vscode";
import path from "node:path";
import fs from "node:fs";

/**
 * On-Device Model Manager — runs Qwen2.5-Coder-1.5B locally via llama.cpp.
 *
 * No cloud, no API key, no cost. The model downloads ~900MB on first use
 * and loads from disk cache on subsequent activations (~2-3s warm-up).
 *
 * Used by:
 *   - Smart hover explanations
 *   - Inline error explanations (complex ones regex can't handle)
 *   - Teaching card generation
 *   - Code review suggestions
 *   - "Fix it" for simple fixes
 *
 * The user can switch between on-device and Haiku in the Live tab.
 * When on-device is selected and not yet downloaded, a download prompt appears.
 */

// Model config
const MODEL_REPO = "Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF";
const MODEL_FILE = "qwen2.5-coder-1.5b-instruct-q5_k_m.gguf";
const MODEL_SIZE_MB = 1100;

// State
let model: unknown = null; // LlamaModel instance
let context: unknown = null; // LlamaContext
let session: unknown = null; // LlamaChatSession
let loading = false;
let ready = false;
let error: string | null = null;
let downloadProgress = 0;

type StatusCallback = (status: OnDeviceStatus) => void;
let statusCallbacks: StatusCallback[] = [];

export interface OnDeviceStatus {
  ready: boolean;
  loading: boolean;
  error: string | null;
  downloadProgress: number; // 0-100
  modelSize: string;
}

export function getOnDeviceStatus(): OnDeviceStatus {
  return {
    ready,
    loading,
    error,
    downloadProgress: Math.round(downloadProgress),
    modelSize: `${MODEL_SIZE_MB}MB`,
  };
}

export function onStatusChange(cb: StatusCallback): vscode.Disposable {
  statusCallbacks.push(cb);
  return new vscode.Disposable(() => {
    statusCallbacks = statusCallbacks.filter((c) => c !== cb);
  });
}

function notifyStatus(): void {
  const status = getOnDeviceStatus();
  for (const cb of statusCallbacks) {
    try { cb(status); } catch {}
  }
}

/**
 * Start downloading + loading the on-device model.
 * Shows progress in the notification area.
 * Safe to call multiple times — no-ops if already loading/loaded.
 */
export async function initOnDeviceModel(
  extensionPath: string
): Promise<void> {
  if (ready || loading) return;
  loading = true;
  error = null;
  downloadProgress = 0;
  notifyStatus();

  try {
    // Dynamic import — node-llama-cpp is heavy, only load when needed
    const {
      getLlama,
      LlamaChatSession,
    } = await import("node-llama-cpp");

    const llama = await getLlama();

    // Cache dir inside the extension's global storage
    const cacheDir = path.join(extensionPath, ".model-cache");
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

    const modelPath = path.join(cacheDir, MODEL_FILE);

    // Check if already downloaded
    if (!fs.existsSync(modelPath)) {
      console.log(`[protege] Downloading on-device model (~${MODEL_SIZE_MB}MB)...`);

      // Download from HuggingFace
      const url = `https://huggingface.co/${MODEL_REPO}/resolve/main/${MODEL_FILE}`;
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);

      const total = Number(res.headers.get("content-length")) || MODEL_SIZE_MB * 1024 * 1024;
      let received = 0;

      const fileStream = fs.createWriteStream(modelPath);
      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        fileStream.write(value);
        received += value.length;
        downloadProgress = (received / total) * 100;
        notifyStatus();
      }

      fileStream.end();
      await new Promise<void>((resolve, reject) => {
        fileStream.on("finish", resolve);
        fileStream.on("error", reject);
      });

      console.log(`[protege] Model downloaded to ${modelPath}`);
    } else {
      downloadProgress = 100;
      notifyStatus();
    }

    // Load the model
    console.log("[protege] Loading on-device model...");
    const startMs = Date.now();

    model = await llama.loadModel({ modelPath });
    context = await (model as { createContext: (opts: { contextSize: number }) => Promise<unknown> })
      .createContext({ contextSize: 4096 });
    session = new LlamaChatSession({
      contextSequence: (context as { getSequence: () => unknown }).getSequence(),
    });

    const elapsed = Date.now() - startMs;
    console.log(`[protege] On-device model ready in ${elapsed}ms`);

    ready = true;
    loading = false;
    error = null;
    notifyStatus();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[protege] On-device model failed: ${msg}`);
    error = msg;
    loading = false;
    ready = false;
    notifyStatus();
  }
}

/**
 * Generate a response from the on-device model.
 * Returns null if the model isn't ready (caller should fall back to cloud).
 */
export async function generateLocal(
  prompt: string,
  maxTokens = 256
): Promise<string | null> {
  if (!ready || !session) return null;

  try {
    const response = await (session as {
      prompt: (text: string, opts?: { maxTokens: number }) => Promise<string>;
    }).prompt(prompt, { maxTokens });

    return response;
  } catch (err) {
    console.error("[protege] On-device generate failed:", err);
    return null;
  }
}

export function isOnDeviceReady(): boolean {
  return ready;
}

export function isOnDeviceLoading(): boolean {
  return loading;
}

/**
 * Unload the model and free memory.
 */
export async function disposeOnDeviceModel(): Promise<void> {
  if (context) {
    try {
      await (context as { dispose: () => Promise<void> }).dispose();
    } catch {}
  }
  if (model) {
    try {
      await (model as { dispose: () => Promise<void> }).dispose();
    } catch {}
  }
  model = null;
  context = null;
  session = null;
  ready = false;
  loading = false;
  notifyStatus();
}

export function registerOnDeviceModel(
  context: vscode.ExtensionContext
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("protege.downloadOnDeviceModel", () => {
      initOnDeviceModel(context.extensionPath);
    }),
    new vscode.Disposable(() => {
      disposeOnDeviceModel();
    }),
  ];
}
