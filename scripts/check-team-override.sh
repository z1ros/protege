#!/usr/bin/env bash
# Block commits that ship a TEAM_OVERRIDE set to "local"/"prod" to the
# marketplace. Two paths protected:
#
#   1. The gitignored override file `teamOverride.local.ts` MUST NOT be
#      staged. It exists so engineers can flip backends locally; if it
#      ever lands in a commit, every marketplace user gets force-pinned
#      to that backend (the bug that broke 0.1.4).
#
#   2. The legacy inline constant in `protegeClient.ts` MUST NOT have
#      a non-null literal. The current build inlines TEAM_OVERRIDE via
#      a tsup `define`; this guard catches anyone reverting to the
#      literal pattern.
#
# Installed automatically by `scripts/install-hooks.mjs` via the root
# `pnpm install` postinstall.
set -euo pipefail

LOCAL_FILE="apps/extension/src/user/teamOverride.local.ts"
LEGACY_FILE="apps/extension/src/user/protegeClient.ts"
STAGED_NAMES="$(git diff --cached --name-only)"

if printf '%s\n' "$STAGED_NAMES" | grep -qx "$LOCAL_FILE"; then
  echo "✗ pre-commit: $LOCAL_FILE is staged but must NOT be committed (it is gitignored on purpose)." >&2
  echo "  Unstage it:  git restore --staged $LOCAL_FILE" >&2
  echo "  Or delete:   git rm --cached $LOCAL_FILE" >&2
  exit 1
fi

if printf '%s\n' "$STAGED_NAMES" | grep -qx "$LEGACY_FILE"; then
  STAGED_BLOB=$(git show ":$LEGACY_FILE" 2>/dev/null || true)
  if printf '%s\n' "$STAGED_BLOB" | grep -Eq '^[[:space:]]*const[[:space:]]+TEAM_OVERRIDE[^=]*=[[:space:]]*"(local|prod)"'; then
    echo "✗ pre-commit: TEAM_OVERRIDE is set to \"local\" or \"prod\" inline in $LEGACY_FILE" >&2
    echo "  The build now inlines this via tsup's __TEAM_OVERRIDE__ define." >&2
    echo "  Move your override to teamOverride.local.ts (gitignored)." >&2
    exit 1
  fi
fi

exit 0
