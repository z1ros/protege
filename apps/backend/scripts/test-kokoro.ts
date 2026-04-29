import { createRequire } from "module";
const require = createRequire(import.meta.url);
const transformers = require(
  "@huggingface/transformers/dist/transformers.node.cjs"
) as { env: Record<string, unknown> };
const env = transformers.env;
import { KokoroTTS } from "kokoro-js";

// Max-verbose diagnostic for Kokoro warmup failures.
// Run with: pnpm --filter backend exec tsx scripts/test-kokoro.ts

console.log("node", process.version);
console.log("transformers env:", {
  allowLocalModels: (env as unknown as { allowLocalModels: boolean }).allowLocalModels,
  allowRemoteModels: (env as unknown as { allowRemoteModels: boolean }).allowRemoteModels,
  cacheDir: (env as unknown as { cacheDir: string }).cacheDir,
  localModelPath: (env as unknown as { localModelPath: string }).localModelPath,
  remoteHost: (env as unknown as { remoteHost: string }).remoteHost,
  remotePathTemplate: (env as unknown as { remotePathTemplate: string }).remotePathTemplate,
});

// Try a direct fetch first to prove the network path works from this process
const testUrl =
  "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model_fp16.onnx";
console.log("\n[1] direct fetch HEAD:", testUrl);
try {
  const r = await fetch(testUrl, { method: "HEAD", redirect: "follow" });
  console.log("    status:", r.status, "type:", r.headers.get("content-type"));
} catch (err) {
  console.error("    direct fetch failed:", err);
}

console.log("\n[2] KokoroTTS.from_pretrained dtype=fp16…");
try {
  const tts = await KokoroTTS.from_pretrained(
    "onnx-community/Kokoro-82M-v1.0-ONNX",
    { dtype: "fp16" as never }
  );
  console.log("    OK — voices:", Object.keys(tts.voices).length);
} catch (err) {
  console.error("    FAILED:", err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  if (err instanceof Error && (err as { cause?: unknown }).cause) {
    console.error("cause:", (err as { cause?: unknown }).cause);
  }
}
