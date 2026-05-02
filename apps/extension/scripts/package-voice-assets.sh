#!/usr/bin/env bash
# Bundle the locally-installed voice-engine artifacts into the tarball
# format that fetchAssets.ts expects on the GitHub Release.
#
# Reads:
#   apps/extension/bin/protege-mic-<platform>-<arch>[.exe]
#   apps/extension/models/{protege-oww,embedding_model,melspectrogram}.onnx
#
# Writes:
#   apps/extension/release-artifacts/protege-voice-<version>-<platform>-<arch>.tar.gz
#
# After running this, upload the tarball as a release asset on GitHub:
#   1. Go to https://github.com/z1ros/protege/releases
#   2. Draft a new release, tag it `v0.0.1` (or whatever ASSET_VERSION is)
#   3. Drag the .tar.gz file into the assets area
#   4. Publish
# That's it — fetchAssets.ts will find it on the next user's first voice-mode click.
#
# Pass `--platform <p>` and `--arch <a>` to package for a non-host target
# (useful once you have cross-compiled binaries for other platforms).

set -euo pipefail

# Stay version-locked with `ASSET_VERSION` in fetchAssets.ts. Bump both
# in the same commit when you change either the binary or the models —
# the fetcher uses the version stamp to decide whether to re-fetch.
VERSION="v0.0.1"

PLATFORM="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$PLATFORM" in
  darwin) PLATFORM="darwin" ;;
  linux)  PLATFORM="linux" ;;
  *)      echo "ERROR: unsupported host platform: $(uname -s)"; exit 1 ;;
esac

ARCH="$(uname -m)"
case "$ARCH" in
  arm64|aarch64) ARCH="arm64" ;;
  x86_64)        ARCH="x64" ;;
  *)             echo "ERROR: unsupported host arch: $(uname -m)"; exit 1 ;;
esac

# Allow overriding for cross-platform packaging (you build the binary
# elsewhere and drop it into bin/ with the right name).
while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform) PLATFORM="$2"; shift 2 ;;
    --arch)     ARCH="$2";     shift 2 ;;
    *)          echo "Unknown flag: $1"; exit 1 ;;
  esac
done

EXT_BIN_EXT=""
if [[ "$PLATFORM" == "win32" ]]; then EXT_BIN_EXT=".exe"; fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_ROOT="$(dirname "$SCRIPT_DIR")"
BIN_NAME="protege-mic-${PLATFORM}-${ARCH}${EXT_BIN_EXT}"
SRC_BIN="${EXT_ROOT}/bin/${BIN_NAME}"
SRC_MODELS_DIR="${EXT_ROOT}/models"
REQUIRED_MODELS=(protege-oww.onnx embedding_model.onnx melspectrogram.onnx)

# Verify inputs.
if [[ ! -f "$SRC_BIN" ]]; then
  echo "ERROR: binary not found: $SRC_BIN"
  echo "       For cross-platform packaging, build the binary elsewhere"
  echo "       and copy it to apps/extension/bin/ with the exact name above."
  exit 1
fi
for m in "${REQUIRED_MODELS[@]}"; do
  if [[ ! -f "${SRC_MODELS_DIR}/${m}" ]]; then
    echo "ERROR: model not found: ${SRC_MODELS_DIR}/${m}"
    exit 1
  fi
done

# Stage layout that matches what fetchAssets.ts extracts.
STAGE_DIR="$(mktemp -d -t protege-voice-pkg.XXXXXX)"
trap 'rm -rf "$STAGE_DIR"' EXIT
mkdir -p "${STAGE_DIR}/bin" "${STAGE_DIR}/models"

cp "$SRC_BIN" "${STAGE_DIR}/bin/${BIN_NAME}"
chmod +x "${STAGE_DIR}/bin/${BIN_NAME}"
for m in "${REQUIRED_MODELS[@]}"; do
  cp "${SRC_MODELS_DIR}/${m}" "${STAGE_DIR}/models/${m}"
done

OUT_DIR="${EXT_ROOT}/release-artifacts"
mkdir -p "$OUT_DIR"
OUT_NAME="protege-voice-${VERSION}-${PLATFORM}-${ARCH}.tar.gz"
OUT_PATH="${OUT_DIR}/${OUT_NAME}"

# Use COPYFILE_DISABLE=1 on macOS so the tar doesn't pick up ._* AppleDouble
# resource forks. They're harmless but clutter the archive listing.
COPYFILE_DISABLE=1 tar -C "$STAGE_DIR" -czf "$OUT_PATH" bin models

SIZE=$(du -h "$OUT_PATH" | cut -f1)
echo "Built: $OUT_PATH  ($SIZE)"
echo ""
echo "Next steps:"
echo "  1. Tag a release on GitHub (z1ros/protege) with tag '${VERSION}'"
echo "  2. Upload ${OUT_NAME} as a release asset"
echo "  3. Bump ASSET_VERSION in src/voice/fetchAssets.ts when you replace"
echo "     either the binary or the models"
