import Prism from "prismjs";

// Prism component files (`components/prism-*.js`) are IIFE wrappers of
// the form `(function (Prism) { ... }(Prism))` — they look up `Prism` as
// a free global. In a browser UMD context that's `window.Prism`, set as
// a side-effect when `prismjs` loads. Under Vite's ESM build the main
// `prism.js` still assigns `window.Prism`, but we make it explicit here
// so any bundler that strips the global (strict ESM, SSR, web workers)
// still works. This file MUST be imported *before* any
// `prismjs/components/prism-*` import.
(globalThis as unknown as { Prism: typeof Prism }).Prism = Prism;

export { Prism };
