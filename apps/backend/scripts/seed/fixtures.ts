/**
 * Static catalogs used by every generator. Keeping them in one place means
 * extending the seed (new language, new concept) is a one-file change.
 */

export type Language = "typescript" | "python" | "rust";

export const LANGUAGES: readonly Language[] = [
  "typescript",
  "python",
  "rust",
] as const;

export const EXT_BY_LANGUAGE: Record<Language, string> = {
  typescript: "ts",
  python: "py",
  rust: "rs",
};

export const CONCEPTS_BY_LANGUAGE: Record<Language, readonly string[]> = {
  typescript: [
    "Promise.all",
    "async/await",
    "useState",
    "useEffect",
    "Generic<T>",
    "interface",
    "discriminated union",
    "Mapped Type",
    "Array.prototype.reduce",
    "Promise.race",
    "Optional chaining",
    "Nullish coalescing",
  ],
  python: [
    "list comprehension",
    "generator",
    "context manager",
    "dataclass",
    "asyncio",
    "decorator",
    "type hint",
    "match statement",
    "f-string",
    "pathlib.Path",
  ],
  rust: [
    "Result<T,E>",
    "Option<T>",
    "match",
    "Trait",
    "lifetime annotation",
    "Box<T>",
    "Iterator::collect",
    "impl block",
    "derive macro",
    "borrow checker",
  ],
};

export const FILES_BY_LANGUAGE: Record<Language, readonly string[]> = {
  typescript: [
    "src/components/Button.tsx",
    "src/components/Modal.tsx",
    "src/lib/api.ts",
    "src/lib/store.ts",
    "src/hooks/useAuth.ts",
    "src/routes/dashboard.tsx",
    "src/utils/format.ts",
  ],
  python: [
    "backend/main.py",
    "backend/services/auth.py",
    "backend/models/user.py",
    "backend/utils/logger.py",
    "scripts/ingest.py",
  ],
  rust: [
    "src/lib.rs",
    "src/bin/server.rs",
    "src/parser/tokens.rs",
    "src/engine/runtime.rs",
  ],
};

export const COMMIT_MESSAGES: readonly string[] = [
  "fix: handle empty workspace state",
  "refactor: extract session boundary logic",
  "feat: add concept momentum bar chart",
  "chore: bump ripgrep + tree-sitter",
  "fix: preserve hero tile null state",
  "refactor: collapse polar arc math into one helper",
  "feat: coastline event mapper handles file_saved",
  "fix: drop legacy echoConceptFilters on load",
  "test: cover 30-day rollup window edges",
  "docs: note v5 W17 eviction semantics",
] as const;
