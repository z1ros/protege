#!/usr/bin/env node
/**
 * Install repo-tracked git hooks into `.git/hooks/`. Runs from the
 * root `package.json` postinstall, so every fresh `pnpm install`
 * ensures the hooks exist on a new clone — git hooks themselves are
 * NOT tracked by git (.git/ is per-checkout), which is how 0.1.4
 * shipped with TEAM_OVERRIDE = "local": CEO's clone had no
 * pre-commit hook to block the staging.
 *
 * No-op when:
 *   - There's no `.git` directory (rare: source untar without git,
 *     CI/CD deploy bundles).
 *   - The hook source file is missing (shouldn't happen, but skip
 *     loudly rather than fail the install).
 *
 * Designed to be idempotent + non-fatal: a permission error here
 * shouldn't break the install for everyone.
 */
import { existsSync, copyFileSync, chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const gitDir = path.join(repoRoot, ".git");

if (!existsSync(gitDir)) {
  // Not in a git checkout. Nothing to install. Silent exit.
  process.exit(0);
}

const hooksDir = path.join(gitDir, "hooks");
try {
  mkdirSync(hooksDir, { recursive: true });
} catch (err) {
  console.warn(`[install-hooks] could not create ${hooksDir}: ${err.message}`);
  process.exit(0);
}

const HOOKS = [
  { src: "scripts/check-team-override.sh", dest: "pre-commit" },
];

for (const h of HOOKS) {
  const srcPath = path.join(repoRoot, h.src);
  const destPath = path.join(hooksDir, h.dest);
  if (!existsSync(srcPath)) {
    console.warn(`[install-hooks] source missing: ${h.src} — skipping ${h.dest}`);
    continue;
  }
  try {
    copyFileSync(srcPath, destPath);
    chmodSync(destPath, 0o755);
    console.log(`[install-hooks] installed ${h.dest} ← ${h.src}`);
  } catch (err) {
    console.warn(`[install-hooks] failed to install ${h.dest}: ${err.message}`);
  }
}
