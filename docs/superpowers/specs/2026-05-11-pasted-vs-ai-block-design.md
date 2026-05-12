# Pasted-block vs AI-block classification + visible Dismiss

**Date:** 2026-05-11
**Branch:** code-iq-research
**Author:** Bohdan + Claude

## Problem

Two issues with the current AI-block surface in `apps/extension/src/hints/aiBlocks.ts`:

1. **No source distinction.** The change-origin detector buckets every burst (>=20 lines or >=400 chars) into `auto-inserted`. Both AI-tool insertions (Cursor Tab, Copilot, Claude Code apply) AND user clipboard pastes render as `◎ AI block · N lines · ✿ Teach me this block`. A user pasting a Stack Overflow snippet sees a label that implies the AI wrote it.

2. **No visible Dismiss.** The file's header comment promises three hover actions (`✓ Got it`, `↗ Tell me more`, `✕ Dismiss`), but `provideCodeLenses` only renders the teach lens. Commands `protege.aiBlocks.dismiss` / `gotIt` / `tellMore` exist (lines 169–211) but have no clickable surface. Only escape hatch is the command-palette `dismissAllInFile`.

## Goals

- Distinguish user-pasted regions from AI-tool-inserted regions in the data model AND in the rendered label.
- Add a visible "✕ Dismiss" CodeLens beside the primary teach lens for both block types.
- Preserve all existing behavior: TTL pruning, MIN_AUTO_LINES gate, format-on-save guard, comment-toggle guard, Protege-self-edit guard, ownership math.

## Non-goals

- Reclassifying past `auto-inserted` regions on disk. Existing records stay labeled "AI block"; only new bursts can earn the "Pasted" label.
- Distinct teach-prompt content for pasted vs AI (the message body sent to chat). Keep the current teach prompt; only the lens title and microcopy differ. Can be revisited later.
- Re-enabling the hover-with-briefing flow.

## Approach

### 1. Extend the OwnershipRegion type

`packages/types/src/index.ts:1718-1735` — widen `origin` to include `"pasted"`:

```ts
origin: "typed" | "auto-inserted" | "pasted";
```

Both `"auto-inserted"` and `"pasted"` count as unowned-until-explained for `getOwnership` math (they go through the same `r.origin === "typed" || r.explainedAt !== null` predicate). The widening is additive — existing serialized records remain valid.

`canMerge` in `ownership.ts:482` continues to require same origin, so a paste and an AI insert that land adjacent will NOT merge into one combined block. Correct: they have different teach prompts.

### 2. Detect user paste via clipboard match

`apps/extension/src/detection/changeOriginDetector.ts`:

Within `handleDocChange`, perform an async clipboard comparison whenever the change is single-content-change AND would otherwise be classified as `"auto-inserted"` OR routed through grey-zone classification. Run BEFORE the burst / pace / grey-zone branching so a paste short-circuits the LLM call AND reroutes from `"auto-inserted"` to `"pasted"`:

```ts
async function isLikelyPaste(
  newText: string,
  prevSnapshot: string | undefined,
  changeOffset: number,
  changeLen: number
): Promise<boolean> {
  try {
    if (newText.length < MIN_AUTO_LINES_CHARS_APPROX) return false;
    const clip = await vscode.env.clipboard.readText();
    if (!clip) return false;
    const norm = (s: string) => s.replace(/\r\n/g, "\n").trim();
    return norm(clip) === norm(newText);
  } catch {
    return false;
  }
}
```

Apply early in `handleDocChange` for single-change events with `totalCharsAdded >= GREY_MIN_CHARS` OR `totalLinesAdded >= GREY_MIN_LINES`. If true → emit `origin: "pasted"` directly, skip burst/pace/grey-zone branches. Else → fall through to existing classifier.

**Why trim-and-CRLF-normalize:** VS Code's paste action inserts clipboard content verbatim, but Windows clipboard often has `\r\n` while editor files use `\n`. AI tools write programmatically, never matching clipboard byte-for-byte.

**Why short-circuit BEFORE grey-zone:** the existing grey-zone path spends a Haiku-tier LLM call to classify ambiguous changes. A clipboard-match positive is free and definitive — no reason to spend the API call.

**Async cost:** clipboard read is a single IPC, sub-ms in practice. The deferred-emit pattern is already in use for grey-zone (`changeOriginDetector.ts:545-602`); the paste check follows the same shape. Multi-change events skip the check (paste is single-change by construction).

**Multi-cursor paste:** stays `"mixed"` → `"auto-inserted"` per existing `extension.ts:577-580` mapping. Acceptable: multi-cursor paste is rare and the existing labeling holds.

### 3. Plumb origin through ChangeOriginEvent → recordChange → OwnershipRegion

- `ChangeOrigin` type: add `"pasted"` to the union.
- `ChangeOriginEvent.origin` becomes `"typed" | "auto-inserted" | "pasted" | "mixed"`.
- `extension.ts:572-581` — extend the dispatcher: `"pasted"` flows straight to `recordOwnershipChange(..., "pasted")`. `"mixed"` continues to map to `"auto-inserted"`.
- `ownership.ts:181-221` `recordChange` — accept `"pasted"` and pass through. The MIN_AUTO_LINES gate already applies to "auto-inserted" only; **also apply it to "pasted"** (a 2-line paste is noise).
- `pruneStale` (`ownership.ts:81-113`) — TTL also applies to unreviewed pasted regions. Update the `r.origin === "typed"` keeper check to keep typed AND explained-anything; everything else (auto-inserted unreviewed, pasted unreviewed) goes through the TTL gate.

### 4. Update the AI-block surface to render two lenses per block

`apps/extension/src/hints/aiBlocks.ts`:

- `AiBlockLensProvider.provideCodeLenses` filter widens to:
  ```ts
  (r) => (r.origin === "auto-inserted" || r.origin === "pasted") && r.explainedAt === null
  ```
- For each region, push TWO CodeLens objects on the same `range`:

  **Lens 1 (teach):**
  - If `r.origin === "auto-inserted"`: title = `◎ AI block · N lines · ✿ Teach me this block`
  - If `r.origin === "pasted"`: title = `◎ Pasted block · N lines · ✿ You sure you know this?`
  - Both wired to `command: "protege.aiBlocks.teach"` (existing).

  **Lens 2 (dismiss):**
  - Title = `✕ Dismiss`
  - `command: "protege.aiBlocks.dismiss"` (already registered, line 189-201).
  - Same `arguments` payload (`AiBlockArgs`).

VS Code renders multiple lenses on the same line side-by-side, separated by `|`. No additional plumbing.

- Optional: extend `AiBlockArgs` with `origin: "auto-inserted" | "pasted"` so the teach handler can vary the chat prompt later. Pass through but don't branch on it yet.

### 5. Decoration tint (optional, low risk)

`paintBlocksFor` currently paints both unreviewed auto-inserted regions in blue. Either:

- (a) Leave the wash identical — both block types share the "ambient informational" tint.
- (b) Tint pasted regions slightly different (e.g., warmer hue) to telegraph the source visually.

**Recommendation: (a)** — single decoration type, less code churn, label disambiguates. Revisit if dogfooding shows users miss the source.

### 6. Backwards compat

- Stored `OwnershipRegion` records with `origin: "auto-inserted"` continue to render as "AI block." No migration; the type widening is additive.
- Webview ownership-changed messages (`extension.ts:584-596`) carry the rolled-up `OwnershipSummary`, not raw regions, so no webview/protocol change required.

## Files touched

| File | Change |
|------|--------|
| `packages/types/src/index.ts` | Widen `OwnershipRegion.origin` to include `"pasted"`. |
| `apps/extension/src/detection/changeOriginDetector.ts` | Add `"pasted"` to `ChangeOrigin`. Add `isLikelyPaste()` async check on burst/pace verdicts. Defer auto-inserted emission until clipboard check resolves. |
| `apps/extension/src/extension.ts` | Dispatch `"pasted"` to `recordOwnershipChange`. |
| `apps/extension/src/user/ownership.ts` | Accept `"pasted"` in `recordChange`. Apply MIN_AUTO_LINES gate to pasted too. Apply TTL prune to pasted in `pruneStale`. Keep `canMerge` strict on origin. |
| `apps/extension/src/hints/aiBlocks.ts` | Filter to both origins. Two lenses per block (teach + dismiss). Per-origin title text. Optionally extend `AiBlockArgs` with `origin`. |

## Testing

- **Unit:** add a test that `isLikelyPaste` returns true for trim-equal clipboard, false for mismatch. Add a `recordChange("pasted", ...)` round-trip test.
- **Manual integration:**
  - cmd+V a 10-line snippet from outside the editor → expect "◎ Pasted block · 10 lines · ✿ You sure you know this?" + "✕ Dismiss" lens beside it.
  - Cursor Tab accept of a 15-line completion → expect "◎ AI block · 15 lines · ✿ Teach me this block" + "✕ Dismiss".
  - Click Dismiss on each → lens disappears, region marked explained, decoration clears.
  - Click teach lens on each → chat opens with the existing teach prompt.
  - Format-on-save large file → no block appears (existing format guard still applies).

## Risks

- **Clipboard race:** if the user pastes then almost immediately copies something else before the burst handler runs, `clipboard.readText()` returns the new value and the paste gets misclassified as AI. Acceptable — sub-100ms window, falls back to existing "AI block" label, not silently wrong.
- **Async-emit ordering:** deferring auto-inserted emission means the very rare case of "two bursts within 5ms in the same file" could fire out of order. Existing grey-zone path already does deferred emission; same risk profile.
- **Trim-equal false negative:** if VS Code's paste handler does any normalization (line-ending conversion on Windows), the trim-equal check fails and the paste gets labeled AI. Cross-platform consideration; can relax to a stronger normalize (`\r\n` → `\n`) if it shows up.
