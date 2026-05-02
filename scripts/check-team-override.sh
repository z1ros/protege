#!/usr/bin/env bash
# Block commits that leave TEAM_OVERRIDE set to a non-null value in
# apps/extension/src/user/protegeClient.ts. The override forces the
# extension to talk to a hardcoded backend (local or prod) and would
# break every user if shipped.
set -euo pipefail

FILE="apps/extension/src/user/protegeClient.ts"

if ! git diff --cached --name-only | grep -qx "$FILE"; then
  exit 0
fi

STAGED=$(git show ":$FILE" 2>/dev/null || true)

if printf '%s\n' "$STAGED" | grep -Eq '^[[:space:]]*const[[:space:]]+TEAM_OVERRIDE[^=]*=[[:space:]]*"(local|prod)"'; then
  echo "✗ pre-commit: TEAM_OVERRIDE is set to \"local\" or \"prod\" in $FILE" >&2
  echo "  Reset it to null before committing:" >&2
  echo "    const TEAM_OVERRIDE: \"local\" | \"prod\" | null = null;" >&2
  exit 1
fi

exit 0
