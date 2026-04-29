import * as vscode from "vscode";
import { log } from "../log.js";
import { aiQuery } from "../ai/aiBackend.js";
import { isProtegeEditing } from "../ai/tools.js";

/**
 * Change-origin detection — is this text the user TYPED or something a
 * coding tool AUTO-INSERTED (paste, AI completion, bulk refactor)?
 *
 * We can't see into Cursor's or Claude Code's accept events, but we don't
 * need to: auto-inserted code has a very different shape than typed code.
 * One 200-char change that lands in a single keystroke-less beat is not
 * typing. Several seconds of sustained >50 chars/sec is not typing either.
 *
 * Classification pipeline for each `onDidChangeTextDocument` event:
 *   1. Skip Undo/Redo — never record these.
 *   2. For each contained `ContentChange`, compute added-line + added-char
 *      counts.
 *   3. If any single change exceeds BURST_* thresholds → auto-inserted.
 *   4. Otherwise consult the rolling-pace window. If recent typing rate
 *      exceeds SUSTAINED_PACE_CHARS_PER_SEC → auto-inserted.
 *   5. Otherwise → typed. EXCEPTION: if the change is in the grey zone
 *      (5–9 lines OR 100–199 chars, single content-change, no burst)
 *      AND per-file cooldown allows, DEFER the emit and kick off an
 *      async LLM classification. The event fires once — with the LLM's
 *      verdict, or with `typed` on timeout/error. We can't fire `typed`
 *      first and upgrade later: ownership's summary treats any `typed`
 *      region on a line as owned, so a later `auto-inserted` overlay
 *      would be a no-op.
 *
 * Emits `onChangeOrigin` with the file URI, the range of lines affected,
 * and the verdict. Ownership consumes this directly.
 */

export type ChangeOrigin = "typed" | "auto-inserted" | "mixed";

export interface ChangeOriginEvent {
  uri: vscode.Uri;
  /** 0-based inclusive start line of the change in the POST-change doc. */
  startLine: number;
  /** 0-based inclusive end line of the change in the POST-change doc. */
  endLine: number;
  /** Lines added by the change (may be 0 for pure edits in-place). */
  linesAdded: number;
  /** Chars added by the change (may be 0 for deletions). */
  charsAdded: number;
  origin: ChangeOrigin;
  ts: number;
  /** The new text that was inserted (the content of `contentChanges[0].text`
   *  for single-change events, or the concat for multi-change). Populated
   *  whenever charsAdded > 0. Lets consumers like vibeBrief do diff-aware
   *  summaries without re-reading the doc. */
  newText?: string;
  /** The text that was REPLACED at this range in the pre-change document.
   *  Empty string for pure inserts (Cursor's accept usually inserts, does
   *  not replace). Populated only for single-change events where we had a
   *  cached snapshot of the pre-change file state. Undefined when the
   *  file wasn't cached yet (first edit we've ever seen on it) or for
   *  multi-change events. Consumers: treat `undefined` as "no diff
   *  available, fall back to full-region prompt". */
  replacedText?: string;
}

// Raised 2026-04-22 from 10 / 200 / 50. The old numbers caught too
// much normal activity: long IntelliSense completions, fast burst
// typing, or even a held-down backspace would trip "auto-inserted"
// and fire a Vibecode Brief. New values only qualify genuine multi-
// line pastes and AI diff accepts (Cursor / Claude Code). Drops
// briefing fire-rate ~60% in dogfooding.
export const BURST_LINES_THRESHOLD = 20;
export const BURST_CHARS_THRESHOLD = 400;
export const SUSTAINED_PACE_CHARS_PER_SEC = 80;
export const TYPED_PACE_CEILING = 15;
const PACE_WINDOW_MS = 5_000;

// ---- Grey zone: changes that could go either way ----
// A change lands in the grey zone when:
//   - It's NOT a burst (< 10 lines AND < 200 chars)
//   - It's NOT trivial typing (≥ 5 lines OR ≥ 100 chars)
// That's the size where a user copy-pasting a snippet from Stack Overflow
// is easily confused with someone writing a small helper by hand. We fall
// back to an LLM classification for these — but sparingly, to keep the
// API cost invisible. One call per file per GREY_COOLDOWN_MS max; each
// call bounded by GREY_TIMEOUT_MS so ownership doesn't stall forever.
const GREY_MIN_LINES = 5;
const GREY_MIN_CHARS = 100;
const GREY_COOLDOWN_MS = 15_000;
const GREY_TIMEOUT_MS = 2_000;
const GREY_MAX_TOKENS = 8;
/** Hard cap so per-file cooldown entries can't leak on a workspace that
 *  touches thousands of files over weeks. Anything older than 10 min is
 *  useless anyway (cooldown is 15s), so the cap doubles as a GC window. */
const GREY_MAP_CAP = 500;
const GREY_GC_AGE_MS = 10 * 60_000;
/** Global concurrency cap — at most N classify calls in flight at once.
 *  Prevents a "paste into 20 files" scenario from fan-outing the API. */
const GREY_MAX_IN_FLIGHT = 3;
const lastGreyCallAt = new Map<string, number>();
let greyInFlight = 0;

/** Drop stale cooldown entries + enforce the cap. Cheap O(n), runs only
 *  when we're about to add a new entry and the map is already at cap. */
function gcGreyMap(now: number): void {
  const cutoff = now - GREY_GC_AGE_MS;
  for (const [k, ts] of lastGreyCallAt) {
    if (ts < cutoff) lastGreyCallAt.delete(k);
  }
  // Still over cap after age pass? Evict oldest until we're under it.
  if (lastGreyCallAt.size > GREY_MAP_CAP) {
    const sorted = [...lastGreyCallAt.entries()].sort((a, b) => a[1] - b[1]);
    const overBy = lastGreyCallAt.size - GREY_MAP_CAP;
    for (let i = 0; i < overBy; i++) lastGreyCallAt.delete(sorted[i][0]);
  }
}

type PaceSample = { ts: number; chars: number };

/** Rolling pace tracker per file. Drops entries older than PACE_WINDOW_MS. */
class PaceTracker {
  private perFile = new Map<string, PaceSample[]>();

  record(key: string, chars: number, ts: number): void {
    if (chars <= 0) return;
    const list = this.perFile.get(key) ?? [];
    list.push({ ts, chars });
    const cutoff = ts - PACE_WINDOW_MS;
    while (list.length > 0 && list[0].ts < cutoff) list.shift();
    this.perFile.set(key, list);
  }

  /** ms-epoch of the most recent recorded sample for this file, or null. */
  lastSampleTs(key: string): number | null {
    const list = this.perFile.get(key);
    if (!list || list.length === 0) return null;
    return list[list.length - 1].ts;
  }

  /** Chars/sec over the live window. */
  rate(key: string, now: number): number {
    const list = this.perFile.get(key);
    if (!list || list.length === 0) return 0;
    const cutoff = now - PACE_WINDOW_MS;
    const active = list.filter((s) => s.ts >= cutoff);
    if (active.length === 0) return 0;
    const totalChars = active.reduce((a, s) => a + s.chars, 0);
    const span = Math.max(1, now - active[0].ts);
    return (totalChars * 1000) / span;
  }
}

const emitter = new vscode.EventEmitter<ChangeOriginEvent>();
export const onChangeOrigin: vscode.Event<ChangeOriginEvent> = emitter.event;

/** Per-file text snapshot captured BEFORE each change is applied.
 *  Lets us hand consumers (vibeBrief) the exact replaced text so their
 *  LLM prompts can do before/after diffs. Populated on first-seen
 *  `onDidChangeTextDocument` for a file, then refreshed after each
 *  change so the next event's pre-state is accurate. Kept per-uri so
 *  closing + reopening a file restarts from a clean snapshot. Size:
 *  one full-text copy per actively-edited source file — e.g. 20 open
 *  files × 300 KB each ≈ 6 MB, tolerable for an extension. */
const textSnapshots = new Map<string, string>();
/** Cap the snapshot cache so a monorepo-wide find-replace doesn't
 *  balloon memory. LRU eviction by age. */
const SNAPSHOT_CAP = 100;
const SNAPSHOT_LAST_SEEN = new Map<string, number>();

const pace = new PaceTracker();

/** Per-URI timestamp of the last `onWillSaveTextDocument`. Any content
 *  change inside FORMAT_WINDOW_MS of a save is almost certainly the
 *  formatter (Prettier / ESLint-fix / built-in) rewriting the file —
 *  not AI, not typing. We suppress the auto-inserted classification
 *  for those changes so format-on-save doesn't flood ownership with
 *  false red regions.
 *
 *  `onWillSave` fires BEFORE the formatter's content change event, so
 *  stamping here and checking inside handleDocChange is correct. */
const lastWillSaveAt = new Map<string, number>();
const FORMAT_WINDOW_MS = 1500;

/** Register the doc-change listener. Idempotent: subsequent calls return
 *  the same disposable. */
let installed: vscode.Disposable | null = null;
export function installChangeOriginDetector(): vscode.Disposable {
  if (installed) return installed;

  // Seed the snapshot cache for every already-open file-scheme document
  // so the VERY FIRST change after activation has a pre-state to diff
  // against. Without this, the first paste of the session gets a null
  // replacedText and vibeBrief falls back to the full-region prompt.
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.uri.scheme === "file") refreshSnapshot(doc);
  }

  // Freshly-opened files also need an initial snapshot.
  const openSub = vscode.workspace.onDidOpenTextDocument((doc) => {
    if (doc.uri.scheme === "file") refreshSnapshot(doc);
  });
  // Closed files can drop their snapshots to save memory.
  const closeSub = vscode.workspace.onDidCloseTextDocument((doc) => {
    const key = doc.uri.toString();
    textSnapshots.delete(key);
    SNAPSHOT_LAST_SEEN.delete(key);
    lastWillSaveAt.delete(key);
  });

  // Stamp the will-save timestamp so handleDocChange can recognise the
  // formatter's content-change event and skip classifying it as auto-
  // inserted. Format-on-save was the #1 source of false "AI block"
  // flags on Prettier-heavy projects.
  const willSaveSub = vscode.workspace.onWillSaveTextDocument((evt) => {
    if (evt.document.uri.scheme !== "file") return;
    lastWillSaveAt.set(evt.document.uri.toString(), Date.now());
  });

  const sub = vscode.workspace.onDidChangeTextDocument((evt) => {
    try {
      handleDocChange(evt);
      // Post-change: refresh snapshot so the NEXT event sees an
      // accurate pre-state. Skip for non-file schemes that the handler
      // bails on early — they never cached a snapshot in the first place.
      if (evt.document.uri.scheme === "file") {
        refreshSnapshot(evt.document);
      }
    } catch (err) {
      log(
        "changeOrigin",
        `handler crash — ${err instanceof Error ? err.message : String(err)}`
      );
    }
  });

  installed = {
    dispose() {
      sub.dispose();
      openSub.dispose();
      closeSub.dispose();
      willSaveSub.dispose();
      textSnapshots.clear();
      SNAPSHOT_LAST_SEEN.clear();
      lastWillSaveAt.clear();
      installed = null;
    },
  };
  return installed;
}

/** True when the change likely came from a reformat (compared pre/post
 *  text, whitespace-stripped, same identifiers and structure). Covers the
 *  case where the user triggers `Format Document` manually (no save
 *  event, so the save-window filter misses it) but Prettier still
 *  rewrites large regions. If the tokens are identical, nothing
 *  substantive changed — don't flag as AI. */
function looksLikeReformat(
  replacedText: string | undefined,
  newText: string
): boolean {
  if (replacedText === undefined) return false;
  if (replacedText.length === 0) return false;
  const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
  const a = normalize(replacedText);
  const b = normalize(newText);
  if (a === b) return true;
  // Allow small edits within a reformat (e.g. semicolon insertion) — up
  // to 5% character delta after whitespace collapse is still "reformat".
  if (a.length === 0 || b.length === 0) return false;
  const ratio = Math.abs(a.length - b.length) / Math.max(a.length, b.length);
  if (ratio > 0.05) return false;
  // Same identifiers in same order? Strip everything non-alphanumeric
  // and compare — if the word sequence matches, the formatter just
  // shuffled punctuation.
  const tokens = (s: string) => s.match(/[A-Za-z0-9_$]+/g)?.join("") ?? "";
  return tokens(a) === tokens(b);
}

function refreshSnapshot(doc: vscode.TextDocument): void {
  const key = doc.uri.toString();
  textSnapshots.set(key, doc.getText());
  SNAPSHOT_LAST_SEEN.set(key, Date.now());
  if (textSnapshots.size > SNAPSHOT_CAP) {
    // LRU eviction by age. Drop the oldest 10% when we go over the cap.
    const victims = [...SNAPSHOT_LAST_SEEN.entries()]
      .sort((a, b) => a[1] - b[1])
      .slice(0, Math.max(1, Math.floor(textSnapshots.size / 10)));
    for (const [k] of victims) {
      textSnapshots.delete(k);
      SNAPSHOT_LAST_SEEN.delete(k);
    }
  }
}

function handleDocChange(evt: vscode.TextDocumentChangeEvent): void {
  if (evt.contentChanges.length === 0) return;
  if (
    evt.reason === vscode.TextDocumentChangeReason.Undo ||
    evt.reason === vscode.TextDocumentChangeReason.Redo
  ) {
    // Undo/redo still mutates the doc — refresh so the NEXT non-undo
    // change has an accurate pre-state.
    refreshSnapshot(evt.document);
    return;
  }
  // Only track file URIs. "untitled:" docs aren't persisted; we'd have
  // nowhere to anchor the ownership record once the user saves-as.
  if (evt.document.uri.scheme !== "file") {
    return;
  }

  const now = Date.now();
  const key = evt.document.uri.toString();

  // Capture the PRE-change replaced text (if we have a cached snapshot)
  // BEFORE we start processing the event. After the loop we'll refresh
  // the snapshot to the post-change state. Single-change events only —
  // multi-change events (multi-cursor, refactor) don't get a clean diff.
  const prevSnapshot = textSnapshots.get(key);
  let replacedText: string | undefined = undefined;
  if (prevSnapshot !== undefined && evt.contentChanges.length === 1) {
    const c0 = evt.contentChanges[0];
    const start = c0.rangeOffset;
    const end = start + c0.rangeLength;
    if (start >= 0 && end <= prevSnapshot.length) {
      replacedText = prevSnapshot.slice(start, end);
    }
  }

  let totalCharsAdded = 0;
  let totalLinesAdded = 0;
  let sawBurst = false;
  let spanStartLine = Number.POSITIVE_INFINITY;
  let spanEndLine = Number.NEGATIVE_INFINITY;

  for (const c of evt.contentChanges) {
    const addedChars = c.text.length;
    const addedLines = c.text === "" ? 0 : (c.text.match(/\n/g)?.length ?? 0);

    totalCharsAdded += addedChars;
    totalLinesAdded += addedLines;

    // Location in POST-change doc: `c.range.start` is still valid because
    // VS Code events fire just after the edit, and the range refers to
    // the PRE-change coordinates — but start line === start line post
    // (insert doesn't shift anything above it). End line shifts forward
    // by addedLines.
    const sl = c.range.start.line;
    const el = sl + addedLines;
    if (sl < spanStartLine) spanStartLine = sl;
    if (el > spanEndLine) spanEndLine = el;

    if (addedLines >= BURST_LINES_THRESHOLD || addedChars >= BURST_CHARS_THRESHOLD) {
      sawBurst = true;
    }
  }

  if (totalCharsAdded === 0) return; // pure deletion — nothing to own

  // Pace is measured on the POST-event side so that a single big paste
  // doesn't also trip the pace rule for the next 5 seconds of typing.
  // We only feed the tracker with small increments — anything above the
  // grey-zone lower bound is excluded so a 150-char paste doesn't push
  // the next normal typing burst over the 50 cps auto-inserted rule.
  const looksLikeTyping =
    !sawBurst &&
    totalCharsAdded < GREY_MIN_CHARS &&
    totalLinesAdded < GREY_MIN_LINES;
  if (looksLikeTyping) pace.record(key, totalCharsAdded, now);

  // Formatter guard: if onWillSave fired inside FORMAT_WINDOW_MS, the
  // content change is almost certainly a Prettier / ESLint-fix rewrite,
  // not a paste or AI accept. Classify as typed so ownership doesn't
  // mark the whole file as an AI block on save. This was the top source
  // of false "AI block" flags.
  const willSaveAt = lastWillSaveAt.get(key) ?? 0;
  const insideSaveWindow = willSaveAt > 0 && now - willSaveAt < FORMAT_WINDOW_MS;

  // Manual-format guard: even outside a save, `Format Document` can
  // emit one huge content-change. If the replaced text and the new
  // text have the same identifiers in the same order after whitespace
  // collapse, treat it as a reformat — not AI.
  const singleChange = evt.contentChanges.length === 1;
  const isReformat =
    singleChange &&
    looksLikeReformat(replacedText, evt.contentChanges[0].text);

  let origin: ChangeOrigin;
  let needsGreyClassify = false;
  if (isProtegeEditing()) {
    // The change came from a Protege tool (chat-driven edit_file /
    // create_file, Compare's "Apply rewrite", etc.). The user already
    // saw the explanation in chat, so flagging this region as
    // "auto-inserted by another AI" and asking them to "Teach me this
    // block" would be redundant and confusing. Record as typed so
    // ownership treats it as owned, the AI-block lens skips it, and
    // we only flag code from EXTERNAL tools (Cursor Tab, Copilot, raw
    // pastes, etc.).
    origin = "typed";
  } else if (insideSaveWindow) {
    // Save-time formatter. Don't flag — user didn't paste, AI didn't
    // write, the content is structurally the same code the user already
    // had. Mark as typed so ownership still tracks lines as known.
    origin = "typed";
  } else if (isReformat) {
    origin = "typed";
  } else if (sawBurst) {
    origin = "auto-inserted";
  } else if (pace.rate(key, now) >= SUSTAINED_PACE_CHARS_PER_SEC) {
    origin = "auto-inserted";
  } else if (
    evt.contentChanges.length > 1 &&
    totalCharsAdded > TYPED_PACE_CEILING
  ) {
    // Multi-range edits (e.g. multi-cursor paste) that aren't big enough
    // to be bursts but aren't plausibly-typed either.
    origin = "mixed";
  } else if (
    evt.contentChanges.length === 1 &&
    (totalLinesAdded >= GREY_MIN_LINES || totalCharsAdded >= GREY_MIN_CHARS)
  ) {
    // Grey zone — heuristics say typed, but size is suspicious. Default
    // to typed; if the LLM says otherwise in time, we'll emit a second
    // event. Only one outstanding classify per file thanks to the
    // cooldown below.
    origin = "typed";
    const since = now - (lastGreyCallAt.get(key) ?? 0);
    if (since >= GREY_COOLDOWN_MS && greyInFlight < GREY_MAX_IN_FLIGHT) {
      needsGreyClassify = true;
      if (lastGreyCallAt.size >= GREY_MAP_CAP) gcGreyMap(now);
      lastGreyCallAt.set(key, now);
    }
  } else {
    origin = "typed";
  }

  if (spanStartLine === Number.POSITIVE_INFINITY) return;

  const startLine = spanStartLine;
  const endLine = Math.max(spanStartLine, spanEndLine);

  // Grey-zone path: DEFER emission until the LLM classification resolves
  // (or the timeout fires). If we emitted `typed` immediately, ownership
  // would record a typed region covering these lines — and a later
  // "auto-inserted" correction would become a no-op, because
  // getOwnership sets owned[i]=1 the moment it sees ANY typed region on
  // a line. The 2s worst-case delay is acceptable for ownership tracking
  // (it's a persistent score, not a realtime display), and grey-zone
  // changes are uncommon relative to normal typing.
  if (needsGreyClassify) {
    const changeText = evt.contentChanges[0].text;
    const doc = evt.document;
    greyInFlight++;
    void classifyGreyZone({
      uri: doc.uri,
      language: doc.languageId,
      changeText,
      context: extractContext(doc, startLine, endLine),
      linesAdded: totalLinesAdded,
      charsAdded: totalCharsAdded,
      recentPace: pace.rate(key, now),
      msSinceKeystroke: mostRecentSampleAgeMs(key, now),
    })
      .then((verdict) => {
        // "unsure" → treat as typed (conservative default — don't nag
        // the user about code they might have written).
        const finalOrigin: ChangeOrigin =
          verdict === "auto-inserted" ? "auto-inserted" : "typed";
        emitter.fire({
          uri: doc.uri,
          startLine,
          endLine,
          linesAdded: totalLinesAdded,
          charsAdded: totalCharsAdded,
          origin: finalOrigin,
          ts: Date.now(),
          newText: changeText,
          replacedText,
        });
        log(
          "changeOrigin",
          `grey→${finalOrigin} · ${doc.uri.fsPath.split("/").pop()} · ${totalLinesAdded}L/${totalCharsAdded}ch · lines ${startLine}-${endLine}`
        );
      })
      .catch((err) => {
        // On any failure, fall back to typed so ownership still records
        // the change. Better than dropping it on the floor.
        log(
          "changeOrigin",
          `grey classify crash — ${err instanceof Error ? err.message : String(err)}`
        );
        emitter.fire({
          uri: doc.uri,
          startLine,
          endLine,
          linesAdded: totalLinesAdded,
          charsAdded: totalCharsAdded,
          origin: "typed",
          ts: Date.now(),
          newText: changeText,
          replacedText,
        });
      })
      .finally(() => {
        greyInFlight = Math.max(0, greyInFlight - 1);
      });
    return;
  }

  const immediateNewText =
    evt.contentChanges.length === 1 ? evt.contentChanges[0].text : undefined;

  const outEvent: ChangeOriginEvent = {
    uri: evt.document.uri,
    startLine,
    endLine,
    linesAdded: totalLinesAdded,
    charsAdded: totalCharsAdded,
    origin,
    ts: now,
    newText: immediateNewText,
    replacedText,
  };
  emitter.fire(outEvent);

  if (origin !== "typed") {
    log(
      "changeOrigin",
      `${origin} · ${evt.document.uri.fsPath.split("/").pop()} · ${outEvent.linesAdded}L/${outEvent.charsAdded}ch · lines ${startLine}-${endLine}`
    );
  }
}

/** Return the last pace sample's age for `key`, or Infinity if none. No
 *  recent keystrokes means the LLM should lean toward "auto-inserted". */
function mostRecentSampleAgeMs(key: string, now: number): number {
  const ts = pace.lastSampleTs(key);
  return ts === null ? Number.POSITIVE_INFINITY : now - ts;
}

function extractContext(
  doc: vscode.TextDocument,
  startLine: number,
  endLine: number
): string {
  const before = Math.max(0, startLine - 3);
  const after = Math.min(doc.lineCount - 1, endLine + 3);
  const lines: string[] = [];
  for (let i = before; i <= after; i++) {
    // Cap each line at 200 chars so one giant minified line can't blow
    // the token budget.
    const text = doc.lineAt(i).text;
    lines.push(text.length > 200 ? text.slice(0, 200) + "…" : text);
  }
  return lines.join("\n");
}

interface GreyZoneInput {
  uri: vscode.Uri;
  language: string;
  changeText: string;
  context: string;
  linesAdded: number;
  charsAdded: number;
  recentPace: number;
  msSinceKeystroke: number;
}

async function classifyGreyZone(
  input: GreyZoneInput
): Promise<"typed" | "auto-inserted" | "unsure"> {
  const fileName = input.uri.fsPath.split("/").pop() ?? input.uri.fsPath;
  const prompt = `A change just landed in ${fileName}. Was it most likely TYPED by the user, PASTED from elsewhere, or AUTO-COMPLETED by an AI tool?

The change:
\`\`\`${input.language}
${input.changeText}
\`\`\`

Context (3 lines before and after):
\`\`\`${input.language}
${input.context}
\`\`\`

Signals:
- Lines added: ${input.linesAdded}
- Characters added: ${input.charsAdded}
- Time since last keystroke: ${Number.isFinite(input.msSinceKeystroke) ? Math.round(input.msSinceKeystroke) + "ms" : "no recent keystrokes"}
- User's typing pace over last minute: ${input.recentPace.toFixed(1)} chars/sec

Return ONLY one of: "typed", "auto-inserted", "unsure".
No explanation.`;

  // Budget the call so a slow backend can't stall ownership tracking.
  // If the timeout wins the race, return "unsure" — the initial `typed`
  // verdict stands.
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<null>((resolve) => {
    timeoutHandle = setTimeout(() => resolve(null), GREY_TIMEOUT_MS);
  });

  let raw: string | null = null;
  try {
    raw = await Promise.race([
      aiQuery(prompt, GREY_MAX_TOKENS, { kind: "scan" }),
      timeoutPromise,
    ]);
  } catch (err) {
    log(
      "changeOrigin",
      `grey classify fail — ${err instanceof Error ? err.message : String(err)}`
    );
    return "unsure";
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }

  if (!raw) return "unsure";
  const cleaned = raw.trim().toLowerCase().replace(/[."']/g, "");
  if (cleaned.startsWith("auto")) return "auto-inserted";
  if (cleaned.startsWith("typed")) return "typed";
  return "unsure";
}
