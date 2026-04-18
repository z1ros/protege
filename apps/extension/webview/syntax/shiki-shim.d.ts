// The extension tsconfig uses moduleResolution "Node", which doesn't
// understand the `exports` subpath field in modern packages. Vite resolves
// these subpaths at bundle time — we just need TypeScript to believe they
// exist so editor/CI typechecks pass. Each shim forwards the concrete
// types from the underlying scoped package where they live.

declare module "shiki/core" {
  export {
    HighlighterCore,
    createHighlighterCore,
    HighlighterCoreOptions,
    ThemeRegistration,
    ThemeRegistrationRaw,
    ThemeRegistrationAny,
    LanguageRegistration,
    LanguageInput,
  } from "@shikijs/core";
}

declare module "shiki/engine/javascript" {
  export { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
}

declare module "@shikijs/langs/*" {
  import type { LanguageRegistration } from "@shikijs/types";
  const lang: LanguageRegistration[];
  export default lang;
}
