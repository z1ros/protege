import { defineConfig } from "tsup";

const isDevBuild = process.env.NODE_ENV === "development";

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
  },
});
