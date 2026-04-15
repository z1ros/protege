import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/extension.ts"],
  outDir: "dist",
  format: ["cjs"],
  platform: "node",
  target: "node18",
  external: ["vscode"],
  sourcemap: true,
  clean: true,
});
