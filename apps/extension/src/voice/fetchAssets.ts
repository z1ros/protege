import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

/**
 * Voice-engine asset bootstrap.
 *
 * The wake-word binary + ONNX models are too platform-specific (and too
 * large to bundle for every target) to ship inside the .vsix. Instead the
 * extension fetches the right tarball for `${process.platform}-${arch}`
 * from a GitHub Release on first voice-mode activation. Downloads from
 * Node's `fetch` are NOT quarantined by macOS Gatekeeper, so the binary
 * runs without the user having to right-click → Open or pay for an Apple
 * Developer Program cert.
 *
 * Tarball layout (created by `apps/extension/scripts/package-voice-assets.sh`):
 *
 *   protege-voice-<version>-<platform>-<arch>.tar.gz
 *     bin/protege-mic-<platform>-<arch>[.exe]
 *     models/protege-oww.onnx
 *     models/embedding_model.onnx
 *     models/melspectrogram.onnx
 *
 * Once extracted we move `bin/*` into `<extensionPath>/bin/` and
 * `models/*` into `<extensionPath>/models/`. A version stamp file at
 * `<extensionPath>/bin/.voice-version` records what we have so the next
 * activation can short-circuit when the cache matches.
 */

const execFileAsync = promisify(execFile);

/** Bumping this triggers a re-fetch on the next activation. Keep in
 *  lockstep with the GitHub Release tag that hosts the matching tarballs. */
export const ASSET_VERSION = "v0.0.1";

const VERSION_STAMP_FILE = ".voice-version";

/** Hardcoded constant — NOT user-overridable. The fetcher unpacks a
 *  Mach-O / ELF / PE binary and chmods it 755, so the host URL is the
 *  trust root for arbitrary native code execution. Letting workspace
 *  settings (`.vscode/settings.json` shipped inside any opened repo)
 *  redirect this would be a one-click RCE primitive. If a self-host
 *  fork ever needs a different host, edit this constant + republish
 *  the extension — that's the right governance boundary.
 *
 *  Re-pointed 2026-05-02 to `BohdanChuprynka/protege-voice-assets`,
 *  a dedicated PUBLIC repo holding only the wake-word binary tarballs
 *  for all 4 platforms (darwin-arm64, darwin-x64, linux-x64, win32-x64).
 *  Source code stays in the private `z1ros/protege` repo; binaries live
 *  here so unauthenticated `fetch()` from end-user machines works.
 *  Standard GitHub-Releases-as-CDN pattern — free, fast, unlimited
 *  bandwidth. The brief intermediate Railway-hosting attempt (route at
 *  apps/backend/src/routes/voiceAssets.ts) was a stopgap; this is the
 *  real answer. */
const RELEASE_BASE = "https://github.com/BohdanChuprynka/protege-voice-assets/releases/download";

interface AssetTarget {
  platform: NodeJS.Platform;
  arch: string;
  binName: string;
  tarball: string;
}

function targetForHost(): AssetTarget {
  const platform = process.platform;
  const arch = process.arch;
  const ext = platform === "win32" ? ".exe" : "";
  const binName = `protege-mic-${platform}-${arch}${ext}`;
  const tarball = `protege-voice-${ASSET_VERSION}-${platform}-${arch}.tar.gz`;
  return { platform, arch, binName, tarball };
}

function releaseUrlFor(target: AssetTarget): string {
  // GitHub release-download URLs use the GIT TAG as the path segment,
  // not just the version number. The CI workflow tags releases with a
  // `voice-` prefix (so they don't collide with extension version tags
  // in the same repo). Final URL pattern:
  //   https://github.com/<owner>/<repo>/releases/download/voice-v0.0.1/protege-voice-v0.0.1-darwin-arm64.tar.gz
  return `${RELEASE_BASE}/voice-${ASSET_VERSION}/${target.tarball}`;
}

export interface AssetCheck {
  binPresent: boolean;
  modelsPresent: boolean;
  versionMatch: boolean;
  /** Files this host needs but doesn't have on disk. Empty array means
   *  everything is in place. */
  missing: string[];
}

/** Inspect what's on disk and decide whether the fetcher needs to run.
 *  Cheap — just stat calls. Safe to call on every activation. */
export function checkAssets(extensionPath: string): AssetCheck {
  const target = targetForHost();
  const binPath = path.join(extensionPath, "bin", target.binName);
  const modelsDir = path.join(extensionPath, "models");
  const requiredModels = [
    "protege-oww.onnx",
    "embedding_model.onnx",
    "melspectrogram.onnx",
  ];

  const missing: string[] = [];
  const binPresent = fs.existsSync(binPath);
  if (!binPresent) missing.push(`bin/${target.binName}`);
  for (const m of requiredModels) {
    if (!fs.existsSync(path.join(modelsDir, m))) missing.push(`models/${m}`);
  }

  const stampPath = path.join(extensionPath, "bin", VERSION_STAMP_FILE);
  let versionMatch = false;
  try {
    const stamp = fs.readFileSync(stampPath, "utf8").trim();
    versionMatch = stamp === ASSET_VERSION;
  } catch {
    versionMatch = false;
  }

  return {
    binPresent,
    modelsPresent: missing.filter((m) => m.startsWith("models/")).length === 0,
    versionMatch,
    missing,
  };
}

export interface DownloadProgress {
  loaded: number;
  total: number;
  /** Phase the UI can render meaningfully:
   *   - "fetching"    → bytes streaming from the network
   *   - "extracting"  → tarball is on disk, running `tar -xzf`
   *   - "installing"  → moving files into final locations
   *   - "done"        → fetcher complete, voice-mode is unblocked
   *   - "error"       → terminal failure, `error` field has the reason */
  phase: "fetching" | "extracting" | "installing" | "done" | "error";
  error?: string;
}

export type ProgressCallback = (p: DownloadProgress) => void;

class FetchError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "FetchError";
  }
}

/**
 * Download + install the voice assets for this platform/arch into
 * `<extensionPath>/bin/` and `<extensionPath>/models/`. Idempotent — if
 * the version stamp already matches `ASSET_VERSION`, returns immediately.
 *
 * Throws on:
 *   - Unsupported platform/arch (no tarball published for it)
 *   - HTTP 404/non-2xx (release not uploaded yet, version mismatch)
 *   - Tar extraction failure (corrupt archive, missing tar.exe on Win)
 *   - File-system errors
 */
export async function fetchVoiceAssets(
  extensionPath: string,
  onProgress?: ProgressCallback
): Promise<void> {
  const target = targetForHost();
  const url = releaseUrlFor(target);

  const binDir = path.join(extensionPath, "bin");
  const modelsDir = path.join(extensionPath, "models");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(modelsDir, { recursive: true });

  // Use a tmp dir alongside `bin/` so the download + extraction stay on
  // the same filesystem (cross-device rename risk on macOS otherwise).
  const tmpDir = path.join(extensionPath, ".voice-tmp");
  if (fs.existsSync(tmpDir)) {
    // Stale tmp from a prior failed attempt — clear before reusing.
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  fs.mkdirSync(tmpDir, { recursive: true });
  const archivePath = path.join(tmpDir, target.tarball);

  try {
    await runFetchPipeline(target, url, archivePath, tmpDir, binDir, modelsDir, onProgress);
  } finally {
    // Always clean up the tmp dir — both on success (no longer needed)
    // and on throw (so a partially-downloaded archive doesn't sit on
    // disk eating space across reloads).
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort; the next call's stale-tmp check will clear it.
    }
  }

  onProgress?.({ loaded: 0, total: 0, phase: "done" });
}

async function runFetchPipeline(
  target: AssetTarget,
  url: string,
  archivePath: string,
  tmpDir: string,
  binDir: string,
  modelsDir: string,
  onProgress?: ProgressCallback
): Promise<void> {
  // ---- Phase 1: download ----
  onProgress?.({ loaded: 0, total: 0, phase: "fetching" });
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new FetchError(
      `Voice assets download failed: HTTP ${res.status} ${res.statusText} from ${url}`,
      res.status
    );
  }
  const total = Number(res.headers.get("content-length") ?? "0");
  let loaded = 0;
  const fileStream = fs.createWriteStream(archivePath);
  // Manual pump rather than pipeline() so we can emit progress events.
  // res.body is a Web ReadableStream; reader.read() yields Uint8Array.
  const reader = res.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // Cast — Node's createWriteStream accepts Uint8Array directly.
      fileStream.write(Buffer.from(value));
      loaded += value.byteLength;
      onProgress?.({ loaded, total, phase: "fetching" });
    }
  } finally {
    fileStream.end();
    await new Promise<void>((resolve, reject) => {
      fileStream.on("finish", () => resolve());
      fileStream.on("error", reject);
    });
  }

  // ---- Phase 2: extract ----
  // tar is present on macOS, Linux, and Windows 10+ (System32\tar.exe).
  // We don't bundle a JS tar lib — keeps the .vsix small and the path
  // simple. If a target platform lacks tar in PATH, this throws and the
  // UI surfaces the error.
  //
  // Use execFile (not exec) so paths with spaces/quotes pass through as
  // an argv array, no shell, no quoting concerns on Windows.
  onProgress?.({ loaded, total, phase: "extracting" });
  try {
    await execFileAsync("tar", ["-xzf", archivePath, "-C", tmpDir]);
  } catch (err) {
    throw new FetchError(
      `Voice assets extraction failed: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  // ---- Phase 3: install ----
  onProgress?.({ loaded, total, phase: "installing" });
  const extractedBin = path.join(tmpDir, "bin", target.binName);
  const extractedModelsDir = path.join(tmpDir, "models");
  if (!fs.existsSync(extractedBin)) {
    throw new FetchError(
      `Voice assets archive missing expected binary: bin/${target.binName}`
    );
  }
  if (!fs.existsSync(extractedModelsDir)) {
    throw new FetchError(
      `Voice assets archive missing expected models/ directory`
    );
  }

  // Defense-in-depth: reject non-regular files. A tarball with symlinks
  // (e.g. `bin/protege-mic-darwin-arm64` → `/etc/passwd`) would otherwise
  // cause `copyFileSync` to follow the link and write the target's
  // contents into the install dir. The release pipeline doesn't produce
  // symlinks, so this purely guards against a tampered archive.
  const binStat = fs.lstatSync(extractedBin);
  if (!binStat.isFile()) {
    throw new FetchError(
      `Voice assets archive contains non-regular file at bin/${target.binName}`
    );
  }
  fs.copyFileSync(extractedBin, path.join(binDir, target.binName));
  if (process.platform !== "win32") {
    fs.chmodSync(path.join(binDir, target.binName), 0o755);
  }
  for (const f of fs.readdirSync(extractedModelsDir)) {
    if (!f.endsWith(".onnx")) continue;
    const src = path.join(extractedModelsDir, f);
    const modelStat = fs.lstatSync(src);
    if (!modelStat.isFile()) {
      throw new FetchError(
        `Voice assets archive contains non-regular file at models/${f}`
      );
    }
    fs.copyFileSync(src, path.join(modelsDir, f));
  }

  // Stamp the install so the next activation skips the fetch.
  fs.writeFileSync(
    path.join(binDir, VERSION_STAMP_FILE),
    ASSET_VERSION,
    "utf8"
  );
  // tmpDir cleanup happens in the outer finally (whether this path
  // returns normally or throws), so partial archives don't linger.
}

// Note: `voiceCapture.ts` exposes its own `ensureVoiceEngine` wrapper
// that drives the VS Code progress notification UI directly. There is
// no need for a separate convenience wrapper here.
