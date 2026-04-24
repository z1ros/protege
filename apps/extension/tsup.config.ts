import { defineConfig } from "tsup";

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
});
