// unplugin-icons virtual module — Vite resolves `~icons/<set>/<name>` into
// a tiny React component at build time. This shim tells TypeScript that
// any `~icons/*` import exports a default React component accepting SVG
// props, so the editor/CI typechecks even though the files don't exist
// on disk.
declare module "~icons/*" {
  import type * as React from "react";
  const component: React.ComponentType<React.SVGProps<SVGSVGElement>>;
  export default component;
}
