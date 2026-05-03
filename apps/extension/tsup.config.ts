import { defineConfig } from "tsup";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const isDevBuild = process.env.NODE_ENV === "development";

// ─── TEAM_OVERRIDE injection ──────────────────────────────────────────
// Read the engineer's gitignored team-switch override file (if any) and
// inline its value as a build-time constant. Engineers edit
// `teamOverride.local.ts` to flip the extension's backend without
// touching tracked source — protegeClient.ts reads the injected
// constant via `__TEAM_OVERRIDE__`.
//
// History: 0.1.4 was published to the marketplace with `TEAM_OVERRIDE
// = "local"` left in tracked source. Every install hit a non-existent
// localhost backend. Refusing to ship a non-dev bundle while an
// override is set is the defense-in-depth that catches that mistake.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_OVERRIDE_PATH = path.resolve(
  __dirname,
  "src/user/teamOverride.local.ts"
);

function readLocalTeamOverride(): "local" | "prod" | null {
  if (!existsSync(LOCAL_OVERRIDE_PATH)) return null;
  const src = readFileSync(LOCAL_OVERRIDE_PATH, "utf8");
  const match = src.match(
    /export\s+const\s+TEAM_OVERRIDE\s*(?::[^=]+)?=\s*"(local|prod)"/
  );
  return match ? (match[1] as "local" | "prod") : null;
}

const teamOverride = readLocalTeamOverride();

// Defense-in-depth: refuse to produce a release-flavored bundle while
// the override is set. The `.vsix` would force every marketplace user
// onto the override's backend — exactly the foot-gun that broke 0.1.4.
if (!isDevBuild && teamOverride !== null) {
  throw new Error(
    `[tsup] Refusing to build a production bundle while teamOverride.local.ts has TEAM_OVERRIDE = "${teamOverride}". ` +
      `Reset it to null (or delete the file) before running pnpm build.`
  );
}

if (teamOverride !== null) {
  // Loud warning during dev so an engineer running the dev host can't
  // miss that they're hardcoded to a non-default backend.
  console.warn(
    `[tsup] TEAM_OVERRIDE = "${teamOverride}" (from teamOverride.local.ts) — DEV ONLY, do NOT publish.`
  );
}

export default defineConfig({
  entry: ["src/extension.ts"],
  outDir: "dist",
  format: ["cjs"],
  platform: "node",
  target: "node18",
  external: ["vscode"],
  sourcemap: true,
  clean: false,
  // Workspace `@protege/types` is ESM + `"main": "./src/index.ts"`. If tsup
  // leaves it external, the Cursor/VS Code extension host tries to load the
  // raw TS file at runtime and chokes on `import "./concepts.js"`.
  // Forcing noExternal makes tsup inline the types into the CJS bundle.
  noExternal: [/^@protege\//],
  // Build-time constants. Read by protegeClient.ts to flip the default
  // backend URL between local (dev builds) and prod (release .vsix).
  // `pnpm dev` sets NODE_ENV=development → __PROTEGE_DEV_BUILD__ = true.
  // `pnpm build` (used by `vsce package`) leaves NODE_ENV unset → false.
  define: {
    __PROTEGE_DEV_BUILD__: JSON.stringify(isDevBuild),
    __TEAM_OVERRIDE__: JSON.stringify(teamOverride),
  },
});
