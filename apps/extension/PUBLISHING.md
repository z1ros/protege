# Publishing the Protege extension

How to ship a new version of the VS Code / Cursor extension to the Open
VSX Registry (the marketplace Cursor reads from).

## Pre-flight (always check)

1. `apps/extension/src/user/teamOverride.local.ts` does **not** exist —
   only `teamOverride.local.ts.example` should be tracked.
   ```bash
   ls apps/extension/src/user/teamOverride*
   # expect: only the .example file
   ```
   If a `.local.ts` exists, delete it before building. The tsup config
   refuses to build a non-dev bundle while it's set, but double-check
   anyway — this is exactly the foot-gun that broke 0.1.4 in the wild.

2. Bump the version in [apps/extension/package.json](package.json).
   Keep it in sync with whatever you tell the user the new build is.

3. Branch state: typically publish from `main`. If you're publishing
   from a feature branch (e.g. `fixing-stuff`), confirm with the user.

## Build

```bash
# 1. Re-install + sync git hooks + verify kokoro cache.
pnpm install

# 2. Build the extension bundle + webview.
#    NOTE: pnpm --filter doesn't work here because the package is named
#    "protege" (not "@protege/extension"). cd into the dir instead.
cd apps/extension
pnpm build
```

## Package the .vsix

```bash
# Still inside apps/extension/
rm -f protege-*.vsix
vsce package --no-dependencies
```

`--no-dependencies` is required because we're a pnpm monorepo. Without
it `vsce` tries to walk a flat `node_modules` and crashes.

Output: `apps/extension/protege-<version>.vsix`. Sanity-check what got
baked in:

```bash
grep -o 'TEAM_OVERRIDE[^,;]*\|isDevBuild[^,;]*' dist/extension.js | head -5
# expect:  TEAM_OVERRIDE = true ? null : null
#          isDevBuild    = true ? false : false
```

If `TEAM_OVERRIDE` shows anything other than `null` or `isDevBuild` is
`true`, **stop** — the build is contaminated. Delete the .vsix and
investigate before publishing.

## Publish to Open VSX (Cursor's marketplace)

The token lives in **`apps/extension/.env`** (gitignored). The template
is `apps/extension/.env.example` — copy and fill it in if the file
doesn't exist on a fresh clone:

```bash
cp apps/extension/.env.example apps/extension/.env
# then edit apps/extension/.env and paste the OVSX_PAT value
```

Get a fresh token at <https://open-vsx.org/user-settings/tokens> if the
existing one is missing or revoked. The account must own the `protege`
namespace.

Run the publish:

```bash
# Load the token, then publish.
set -a && source apps/extension/.env && set +a
npx ovsx publish apps/extension/protege-<version>.vsix
```

A successful run prints:

```
[INFO]  Published protege.protege v<version>
```

A successful run prints:

```
[INFO]  Published protege.protege v<version>
```

## Install locally to verify

```bash
"/Applications/Cursor.app/Contents/Resources/app/bin/cursor" \
  --install-extension /Users/Yura/Documents/GitHub/protege/apps/extension/protege-<version>.vsix \
  --force
```

Then `Cmd+Shift+P → Developer: Reload Window` in Cursor. Check the
status bar — it should read `Server: Prod` (talking to Railway, not
localhost).

## Publishing to the VS Code marketplace (separate registry)

VS Code (not Cursor) reads from the Microsoft marketplace, which uses
`vsce` and a different token. We currently publish only to Open VSX.
If/when we publish to the MS marketplace too:

```bash
vsce publish -p <VSCE_TOKEN>
# or: vsce publish --packagePath protege-<version>.vsix -p <VSCE_TOKEN>
```

Tokens come from <https://dev.azure.com/> → User Settings → Personal
Access Tokens, scoped to "Marketplace (manage)".

## Common failures

- **"Make sure to edit the README.md..."** — vsce nag, ignore.
- **"Extension is missing repository field"** — package.json has a
  `repository` block; if vsce still complains, re-check the URL is a
  full `git+https://…` form.
- **`ovsx: 401 Unauthorized`** — token wrong or revoked. Regenerate
  in Open VSX user settings.
- **`ovsx: namespace not owned`** — the access token belongs to a user
  who doesn't own the `protege` namespace. Use the right account.
- **kokoro errors during `pnpm install`** — non-fatal for publishing;
  it's only used at backend runtime. Continue.

## Quick rollback

If a bad version ships, you can't *unpublish* a specific Open VSX
version, but you can publish a fixed `+1` version that overrides it.
Bump the patch (`0.1.5` → `0.1.6`), re-run the flow above. Cursor
auto-updates pick it up within a few minutes.
