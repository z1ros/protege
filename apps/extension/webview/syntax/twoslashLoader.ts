import type { ShikiTransformer } from "shiki";

/**
 * Lazy loader for the Shiki Twoslash transformer — gives TS/TSX/JS/JSX
 * code blocks *editor-level* intelligence: hover tooltips with real
 * inferred types, inline error squiggles from the TypeScript compiler,
 * signature help — the same info you get in VS Code itself.
 *
 * Why lazy: the transformer depends on the full TypeScript compiler
 * (~3 MB gzipped). Bundling that on boot would more than double the
 * webview's initial payload. Instead, we kick off the import on first
 * sight of a TS/JS block and fall back to plain Shiki until it lands.
 * Subsequent blocks get the enriched render synchronously.
 *
 * Why graceful: Twoslash compiles the snippet. Any undefined reference
 * or missing import throws. The highlightToHtml caller wraps the whole
 * thing in try/catch and retries without Twoslash so those blocks still
 * render — just without the hover magic. A completely standalone
 * snippet (the kind you'd paste into a playground) lights up fully.
 */

let loadPromise: Promise<ShikiTransformer | null> | null = null;
let cachedTransformer: ShikiTransformer | null = null;

export function getTwoslashTransformerOrNull(): ShikiTransformer | null {
  return cachedTransformer;
}

export async function ensureTwoslash(): Promise<ShikiTransformer | null> {
  if (cachedTransformer) return cachedTransformer;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const [{ transformerTwoslash }, { createTwoslasher }, ts, vfs] =
        await Promise.all([
          import("@shikijs/twoslash"),
          import("twoslash"),
          import("typescript"),
          import("@typescript/vfs"),
        ]);

      // VFS needs a map of lib.*.d.ts files so the TS compiler can
      // resolve types. `createDefaultMapFromNodeModules` requires the
      // Node filesystem (not available in the webview).
      // `createDefaultMapFromCDN` fetches from the TS team's CDN at
      // runtime. Wrapped in try/catch because the webview CSP may
      // block the fetch — if so, we fall back to an empty map and
      // Twoslash only works on self-contained snippets (anything
      // needing DOM/React types throws → caller falls back to plain
      // Shiki automatically).
      let fsMap: Map<string, string>;
      try {
        fsMap = await vfs.createDefaultMapFromCDN(
          { target: ts.default.ScriptTarget.ES2022 },
          ts.default.version,
          false,
          ts.default
        );
      } catch {
        fsMap = new Map<string, string>();
      }

      const twoslasher = createTwoslasher({
        compilerOptions: {
          target: ts.default.ScriptTarget.ES2022,
          module: ts.default.ModuleKind.ESNext,
          jsx: ts.default.JsxEmit.Preserve,
          strict: false,
          esModuleInterop: true,
          skipLibCheck: true,
          allowJs: true,
          noEmit: true,
        },
        fsMap,
        tsModule: ts.default,
      });

      cachedTransformer = transformerTwoslash({
        twoslasher,
        // Render tooltips as popover `<span>`s inside the code block.
        // We style them via chat.css — see `.twoslash-popup-container`.
        explicitTrigger: false,
        // `onTwoslashError` lets us swallow compile errors silently;
        // the outer try/catch in highlightToHtml still retries w/o
        // twoslash, so the block renders either way.
        onTwoslashError: () => "",
        onShikiError: () => "",
      });
      return cachedTransformer;
    } catch (err) {
      // Network/bundle load failure — never retry, never crash the UI.
      // The block just stays with plain Shiki forever. Cheap to check
      // again on the next block.
      // eslint-disable-next-line no-console
      console.warn("[twoslash] init failed, falling back to plain Shiki:", err);
      cachedTransformer = null;
      loadPromise = null;
      return null;
    }
  })();
  return loadPromise;
}
