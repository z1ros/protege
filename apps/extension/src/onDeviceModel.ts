import * as vscode from "vscode";
import path from "node:path";
import fs from "node:fs";
import { log, logBlock } from "./log.js";

/**
 * On-Device Model Manager — runs Qwen2.5-Coder-7B locally via llama.cpp.
 *
 * Upgraded from 1.5B → 7B (2026-04-18). The 1.5B model was genuinely
 * limited — missed subtle React / async / state-flow issues, struggled
 * with multi-field JSON output, and produced shallow teaching prose. 7B
 * is the first on-device size that approaches usable review quality:
 * catches index-as-key, prefer-const, missing-await etc. reliably and
 * keeps JSON discipline under a larger prompt.
 *
 * Tradeoff: download is ~4.7 GB instead of ~1.1 GB, and scans take
 * ~5-10s on M1/M2 instead of ~1-2s. For users who want instant, switch
 * to Haiku (cloud) — the AI Engine picker in the Live tab handles it.
 *
 * No cloud, no API key, no cost. The model downloads on first use and
 * loads from disk cache on subsequent activations (~5-8s warm-up).
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

// Model config — Qwen2.5-Coder-7B-Instruct, Q4_K_M quantization.
// Q4_K_M is the sweet spot for 7B: ~4.7 GB, negligible quality loss vs
// Q5/Q8, runs comfortably on 16 GB RAM machines. If you want higher
// quality at the cost of ~700 MB more disk + slightly slower inference,
// switch to Q5_K_M.
const MODEL_REPO = "Qwen/Qwen2.5-Coder-7B-Instruct-GGUF";
const MODEL_FILE = "qwen2.5-coder-7b-instruct-q4_k_m.gguf";
const MODEL_SIZE_MB = 4680;

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
    // Bumped from 4096 → 8192. Our review prompts are ~800-1200ch of input
    // code plus ~512 output tokens; even with per-call `resetChatHistory`
    // (see generateLocal below), 4096 was uncomfortably tight for larger
    // files or the SAVE-tier prompt that stuffs 5 neighbor snippets.
    context = await (model as { createContext: (opts: { contextSize: number }) => Promise<unknown> })
      .createContext({ contextSize: 8192 });
    // node-llama-cpp's getSequence() returns a LlamaContextSequence at
    // runtime. Rest of the file treats llama types structurally via
    // narrow casts; we do the same here and pass through as any so the
    // constructor's exact type parameter doesn't need to be imported.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const seq = (context as { getSequence: () => unknown }).getSequence() as any;
    session = new LlamaChatSession({ contextSequence: seq });

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
/**
 * Hard upper bound on a single generation. Qwen 1.5B occasionally stalls
 * under memory pressure — without this the LIVE scan promise would hang
 * forever and the UI would look frozen.
 */
const GENERATE_TIMEOUT_MS = 30_000;

export async function generateLocal(
  prompt: string,
  maxTokens = 256
): Promise<string | null> {
  if (!ready || !session) {
    log(
      "onDevice",
      `generateLocal refused — ready=${ready} session=${!!session} loading=${loading}`
    );
    return null;
  }

  const promptPreview = prompt.length > 160 ? prompt.slice(0, 160) + "…" : prompt;
  log(
    "onDevice",
    `generate start · prompt ${prompt.length}ch · maxTokens ${maxTokens} · preview: ${promptPreview.replace(/\n/g, " ↵ ")}`
  );
  const started = Date.now();

  try {
    // Reset the chat history BEFORE each call. `LlamaChatSession.prompt()`
    // appends user+assistant turns to an internal history so each call
    // sees the previous one's full context. Fine for an actual chat —
    // catastrophic for our "here's a file, return JSON" pattern: by scan
    // 10 the session is carrying 9 prior files' worth of text, blowing
    // context and polluting the response with references to old code.
    const s = session as {
      resetChatHistory: () => void | Promise<void>;
      prompt: (text: string, opts?: { maxTokens: number }) => Promise<string>;
    };
    try {
      const r = s.resetChatHistory();
      if (r && typeof (r as Promise<void>).then === "function") await r;
    } catch (err) {
      // Older / different versions of node-llama-cpp may not have reset.
      log("onDevice", `resetChatHistory unavailable — ${(err as Error).message}`);
    }

    const response = await Promise.race<string>([
      s.prompt(prompt, { maxTokens }),
      new Promise<string>((_, reject) =>
        setTimeout(
          () => reject(new Error(`generate timeout after ${GENERATE_TIMEOUT_MS}ms`)),
          GENERATE_TIMEOUT_MS
        )
      ),
    ]);

    const elapsed = Date.now() - started;
    const len = response?.length ?? 0;
    log("onDevice", `generate done · ${elapsed}ms · output ${len}ch`);

    // Dump the raw response (first ~400 chars) so you can see exactly
    // what Qwen returned — helpful when JSON parsing later fails.
    if (response) {
      logBlock(
        "onDevice",
        `raw output (first 400ch)`,
        response.slice(0, 400)
      );
    }

    return response;
  } catch (err) {
    const elapsed = Date.now() - started;
    const msg = err instanceof Error ? err.message : String(err);
    log("onDevice", `generate FAIL after ${elapsed}ms — ${msg}`);
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
    // Smoke test — a one-shot "does the local model answer?" probe the
    // user can run from the palette to verify the pipeline end-to-end.
    // Shows status, ensures the model is loaded, fires a trivial prompt,
    // and reports latency + the actual reply in a notification.
    vscode.commands.registerCommand("protege.testOnDevice", async () => {
      const out = vscode.window.createOutputChannel("Protege · On-Device Test");
      out.show(true);
      out.appendLine(`[${new Date().toISOString()}] Starting on-device smoke test…`);

      if (!ready) {
        out.appendLine("Model not loaded yet — initializing…");
        try {
          await initOnDeviceModel(context.extensionPath);
        } catch (err) {
          out.appendLine(`FAIL init: ${err instanceof Error ? err.message : String(err)}`);
          vscode.window.showErrorMessage(
            `Protege on-device: init failed — see "Protege · On-Device Test" output for details`
          );
          return;
        }
      }

      if (!ready) {
        const reason = error ?? "unknown";
        out.appendLine(`FAIL still not ready: ${reason}`);
        vscode.window.showErrorMessage(
          `Protege on-device: not ready — ${reason}`
        );
        return;
      }

      out.appendLine(`Model ready. Running trivial prompt…`);
      const started = Date.now();
      const prompt = `Reply with exactly one word: ok`;
      let reply: string | null = null;
      try {
        reply = await generateLocal(prompt, 16);
      } catch (err) {
        out.appendLine(`FAIL generate: ${err instanceof Error ? err.message : String(err)}`);
        vscode.window.showErrorMessage(
          `Protege on-device: generation threw — see output`
        );
        return;
      }
      const duration = Date.now() - started;

      if (!reply) {
        out.appendLine(`FAIL generate returned null`);
        vscode.window.showErrorMessage(
          `Protege on-device: returned null — model load may be broken`
        );
        return;
      }

      out.appendLine(`OK ${duration}ms`);
      out.appendLine(`Prompt:  ${prompt}`);
      out.appendLine(`Reply:   ${reply.trim()}`);
      vscode.window.showInformationMessage(
        `Protege on-device OK · ${duration}ms · "${reply.trim().slice(0, 40)}"`
      );
    }),
    new vscode.Disposable(() => {
      disposeOnDeviceModel();
    }),
  ];
}
