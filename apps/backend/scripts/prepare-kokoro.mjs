#!/usr/bin/env node
// Pre-downloads the Kokoro ONNX model into transformers.js file cache.
// Workaround for a bug in @huggingface/transformers@3.x where the HF CAS/Xet
// CDN redirect returns chunked transfers without Content-Length, causing
// `Unable to get model file path or buffer.` during first warmup.
//
// Idempotent: skips files already present. Safe to re-run.

import { createRequire } from "node:module";
import { mkdir, stat, rename, unlink } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const require = createRequire(import.meta.url);

const MODEL_ID = process.env.KOKORO_MODEL_ID ?? "onnx-community/Kokoro-82M-v1.0-ONNX";
const DTYPE = process.env.KOKORO_DTYPE ?? "fp16";
const DTYPE_TO_FILE = {
  fp32: "model.onnx",
  fp16: "model_fp16.onnx",
  q8: "model_quantized.onnx",
  q4: "model_q4.onnx",
  q4f16: "model_q4f16.onnx",
};
const MODEL_FILE = DTYPE_TO_FILE[DTYPE] ?? "model_fp16.onnx";

const FILES = [
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  `onnx/${MODEL_FILE}`,
];

function resolveCacheDir() {
  // kokoro-js resolves @huggingface/transformers through its own deps.
  // Anchor resolution there so pnpm's hoisting quirks don't confuse us.
  // Neither package exposes package.json via exports, so resolve the
  // main entry and walk up to the package root.
  const kokoroMain = require.resolve("kokoro-js"); // .../kokoro-js/dist/kokoro.cjs
  const kokoroRoot = dirname(dirname(kokoroMain));
  const transformersMain = require.resolve("@huggingface/transformers", {
    paths: [kokoroRoot],
  }); // .../transformers/dist/transformers.node.cjs
  const transformersRoot = dirname(dirname(transformersMain));
  return join(transformersRoot, ".cache");
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function download(url, dest) {
  const tmp = `${dest}.part`;
  await mkdir(dirname(dest), { recursive: true });
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`${res.status} ${res.statusText} for ${url}`);
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  await rename(tmp, dest);
}

async function main() {
  const cacheDir = resolveCacheDir();
  const base = `https://huggingface.co/${MODEL_ID}/resolve/main`;
  const target = join(cacheDir, MODEL_ID);

  let fetched = 0;
  for (const file of FILES) {
    const dest = join(target, file);
    if (await exists(dest)) continue;
    const url = `${base}/${file}`;
    process.stdout.write(`[kokoro-prep] ${file} … `);
    try {
      await download(url, dest);
      console.log("ok");
      fetched++;
    } catch (err) {
      console.log("failed");
      await unlink(`${dest}.part`).catch(() => {});
      throw err;
    }
  }

  if (fetched === 0) {
    console.log(`[kokoro-prep] cache already populated at ${target}`);
  } else {
    console.log(`[kokoro-prep] fetched ${fetched} file(s) → ${target}`);
  }
}

main().catch((err) => {
  console.error(`[kokoro-prep] failed: ${err.message ?? err}`);
  console.error("[kokoro-prep] TTS will be unavailable. Backend still runs; other routes unaffected.");
  process.exit(0); // non-fatal — don't block install
});
