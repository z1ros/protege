import * as vscode from "vscode";
import { aiQuery } from "../ai/aiBackend.js";
import { detectConcepts } from "../concepts/detector.js";
import { log } from "../log.js";
import { getOwnership } from "../user/ownership.js";

/**
 * File-Open Greeter — OPT-IN voice overview when the user switches files.
 *
 * Previous behavior auto-played TTS 1.5s after opening a file. That's a
 * hard interrupt — voice starts with no user consent, can't be silenced.
 *
 * New behavior (Move 3 / Flavor A of ~/.claude/plans/learn-in-flow-audit.md):
 * fires on active-editor change (debounced 1.5s), fetches the 2-sentence
 * overview in the background, then offers it via a status-bar item:
 *
 *     ◎ Overview this file?
 *
 * Clicking the item plays the voice overview. Ignoring it costs nothing.
 * The item auto-expires after OFFER_TTL_MS so stale offers don't linger.
 *
 * Deduped per-URI (persisted in globalState) — a file's overview is
 * offered at most once per install. Dismissed overviews count as "seen"
 * so we don't re-offer them.
 *
 * Skips:
 *  - trivial files (< 20 non-blank lines, only imports, `.d.ts`)
 *  - test / spec / fixture files
 *  - non-source languages
 *  - files the user has already been greeted on
 *  - model returning literal "SKIP"
 */

const DEBOUNCE_MS = 1500;
const MAX_OVERVIEW_TOKENS = 140; // "under 35 words" lives in ~80 tokens; headroom
const OFFER_TTL_MS = 5 * 60_000; // status-bar offer lifespan
const STORAGE_KEY = "protege.greetedFiles";
/** Per-file cooldown for the ownership-based re-greeting — one unowned
 *  offer per file per day. Without this, opening a red file twice in a
 *  row would fire the greeting twice. */
const UNOWNED_COOLDOWN_MS = 24 * 60 * 60_000;
const UNOWNED_SEEN_KEY = "protege.unownedGreetedAt";
/** Below this ownership ratio a file is "unknown" enough to warrant the
 *  dedicated UNOWNED_FILE_GREETING even if the normal greeter already
 *  fired on this URI once. */
const UNOWNED_THRESHOLD = 0.3;

const SUPPORTED_LANGS = new Set([
  "typescript",
  "typescriptreact",
  "javascript",
  "javascriptreact",
  "python",
  "go",
  "rust",
  "java",
  "csharp",
  "cpp",
  "c",
  "ruby",
  "php",
  "swift",
  "kotlin",
  "scala",
  "vue",
  "svelte",
]);

let greetedFiles = new Set<string>();
/** Per-URI ms epoch of the last unowned-file greeting shown. Separate
 *  from `greetedFiles` because this dedup is cooldown-based, not
 *  lifetime. */
let unownedGreetedAt = new Map<string, number>();
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight = false;

// Pending overviews keyed by URI. Each entry carries the overview text
// and an expiry timer. A single status-bar item reads from this map
// based on the currently-active editor.
interface PendingOverview {
  text: string;
  expireTimer: ReturnType<typeof setTimeout>;
  /** Which prompt generated this — drives the status-bar label so the
   *  "review unowned code" case reads differently from the first-open
   *  overview. */
  variant: "overview" | "unowned";
}
const pending = new Map<string, PendingOverview>();
let statusBarItem: vscode.StatusBarItem | null = null;

export function registerFileOpenGreeter(
  context: vscode.ExtensionContext
): vscode.Disposable[] {
  // Hydrate from disk so the dedup survives reloads.
  const stored = context.globalState.get<string[]>(STORAGE_KEY) ?? [];
  greetedFiles = new Set(stored);
  const unownedStored =
    context.globalState.get<Record<string, number>>(UNOWNED_SEEN_KEY) ?? {};
  unownedGreetedAt = new Map(Object.entries(unownedStored));

  const disposables: vscode.Disposable[] = [];

  // Single reusable status-bar item — shown only when the active file
  // has a pending overview; hidden otherwise. Priority sits above the
  // default cluster so the offer is easy to spot without being loud.
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    120
  );
  statusBarItem.command = "protege.playCurrentFileOverview";
  statusBarItem.tooltip =
    "Protege: play a ~5-second voice overview of this file";
  disposables.push(statusBarItem);

  disposables.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (debounceTimer) clearTimeout(debounceTimer);
      updateStatusBar();
      if (!editor) return;
      debounceTimer = setTimeout(() => {
        void maybeGreet(editor, context);
      }, DEBOUNCE_MS);
    })
  );

  // Greet the initial file too (user may open the editor on a file directly).
  const initial = vscode.window.activeTextEditor;
  if (initial) {
    debounceTimer = setTimeout(() => {
      void maybeGreet(initial, context);
    }, DEBOUNCE_MS);
  }

  disposables.push({
    dispose() {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      for (const p of pending.values()) clearTimeout(p.expireTimer);
      pending.clear();
      statusBarItem = null;
    },
  });

  disposables.push(
    vscode.commands.registerCommand("protege.greetCurrentFile", async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed) return;
      // Manual trigger: bypass the seen-set so the user can replay a greeting.
      greetedFiles.delete(ed.document.uri.toString());
      await maybeGreet(ed, context, { force: true });
    })
  );

  // Click handler for the status-bar item — plays the pending overview
  // for the active file via the existing TTS pipeline. This is the ONLY
  // path from file-open to voice; no auto-play anywhere.
  disposables.push(
    vscode.commands.registerCommand(
      "protege.playCurrentFileOverview",
      async () => {
        const ed = vscode.window.activeTextEditor;
        if (!ed) return;
        const uriKey = ed.document.uri.toString();
        const entry = pending.get(uriKey);
        if (!entry) return;

        const { broadcast, mountedWebviewCount } = await import(
          "../chat/webviewHost.js"
        );
        // If no webview is mounted, open the panel then play after a
        // short beat so the audio pipeline has time to come up.
        if (mountedWebviewCount() === 0) {
          const { openProtegePanel } = await import("../panel.js");
          openProtegePanel(context);
          await new Promise((r) => setTimeout(r, 350));
        }
        broadcast({ type: "voice/playExplain", text: entry.text });

        const playedVariant = entry.variant;
        clearPending(uriKey);
        if (playedVariant === "overview") {
          greetedFiles.add(uriKey);
        } else {
          unownedGreetedAt.set(uriKey, Date.now());
        }
        await persist(context);
        log(
          "fileOpenGreeter",
          `user played ${playedVariant} for ${shortName(ed.document.uri)}`
        );
      }
    )
  );

  return disposables;
}

function updateStatusBar(): void {
  if (!statusBarItem) return;
  const ed = vscode.window.activeTextEditor;
  const entry = ed ? pending.get(ed.document.uri.toString()) : undefined;
  if (!entry) {
    statusBarItem.hide();
    return;
  }
  statusBarItem.text =
    entry.variant === "unowned"
      ? "$(circle-large-outline) Review unowned code?"
      : "$(circle-large-outline) Overview this file?";
  statusBarItem.show();
}

function clearPending(uriKey: string): void {
  const entry = pending.get(uriKey);
  if (!entry) return;
  clearTimeout(entry.expireTimer);
  pending.delete(uriKey);
  updateStatusBar();
}

interface GreetOpts {
  force?: boolean;
}

async function maybeGreet(
  editor: vscode.TextEditor,
  context: vscode.ExtensionContext,
  opts: GreetOpts = {}
): Promise<void> {
  if (inFlight) return; // serialize — avoid stacking overlapping fetches

  const doc = editor.document;
  const uriKey = doc.uri.toString();

  if (pending.has(uriKey)) return; // offer already live for this file
  if (!isEligible(doc)) return;

  // Pick the branch. The unowned re-greeting fires EVEN if the normal
  // first-open greeter already ran — that's the whole point of the
  // ownership-aware path: a file you skimmed a month ago and then
  // vibecoded into deserves a fresh "you don't own most of this"
  // prompt. Gated by a 24h per-file cooldown to avoid re-nagging.
  const ownership = getOwnership(doc.uri);
  const isUnowned =
    ownership.state === "unknown" &&
    ownership.ownedPct < UNOWNED_THRESHOLD &&
    ownership.totalLines >= 30; // trivial files don't need the nudge
  const lastUnowned = unownedGreetedAt.get(uriKey) ?? 0;
  const canFireUnowned =
    isUnowned && Date.now() - lastUnowned >= UNOWNED_COOLDOWN_MS;

  // Force path: manual replay. Use the overview variant (richer text).
  // Normal path: overview wins on first open; unowned wins when seen
  // but low-ownership AND cooldown elapsed.
  const variant: "overview" | "unowned" =
    !opts.force && greetedFiles.has(uriKey) && canFireUnowned
      ? "unowned"
      : "overview";

  if (variant === "overview") {
    if (!opts.force && greetedFiles.has(uriKey)) return;
  } else if (!canFireUnowned) {
    return;
  }

  inFlight = true;
  try {
    const reply =
      variant === "unowned"
        ? await runUnownedGreeting(doc, ownership)
        : await runOverview(doc);
    if (!reply) return;

    const trimmed = cleanReply(reply);
    if (!trimmed || isSkipSentinel(trimmed)) {
      log(
        "fileOpenGreeter",
        `model returned SKIP · ${variant} · ${shortName(doc.uri)}`
      );
      if (variant === "overview") {
        greetedFiles.add(uriKey);
      } else {
        unownedGreetedAt.set(uriKey, Date.now());
      }
      await persist(context);
      return;
    }

    // Stash the offer keyed by variant. Expiry-without-click counts as
    // "silence was an answer" for both variants, but they record into
    // different dedup stores so re-greeting rules stay straight.
    const expireTimer = setTimeout(() => {
      if (pending.has(uriKey)) {
        log(
          "fileOpenGreeter",
          `offer expired unclaimed · ${variant} · ${shortName(doc.uri)}`
        );
        clearPending(uriKey);
        if (variant === "overview") {
          greetedFiles.add(uriKey);
        } else {
          unownedGreetedAt.set(uriKey, Date.now());
        }
        void persist(context);
      }
    }, OFFER_TTL_MS);

    pending.set(uriKey, { text: trimmed, expireTimer, variant });
    log(
      "fileOpenGreeter",
      `offer ready · ${variant} · ${shortName(doc.uri)} · ${trimmed.length}ch`
    );
    updateStatusBar();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("fileOpenGreeter", `greet FAIL ${shortName(doc.uri)} — ${msg}`);
  } finally {
    inFlight = false;
  }
}

async function runUnownedGreeting(
  doc: vscode.TextDocument,
  ownership: ReturnType<typeof getOwnership>
): Promise<string | null> {
  const lang = doc.languageId;
  const fileName = doc.fileName.split(/[\\/]/).pop() ?? "file";
  const lines = doc.getText().split("\n");
  const preview = lines.slice(0, 150).join("\n");
  const totalLines = ownership.totalLines;
  const ownedLines = Math.round(ownership.ownedPct * totalLines);
  const ownedPct = Math.round(ownership.ownedPct * 100);

  const prompt = `The user just opened ${fileName}. Their ownership is ${ownedPct}% (they typed or explained ${ownedLines} of ${totalLines} lines).

File preview (first 150 lines):
\`\`\`${lang}
${preview}
\`\`\`

Write a 2-sentence greeting, voice-ready style:

Sentence 1: What the file does, concretely (reference actual functions / imports you see).
Sentence 2: Specifically call out that most of it isn't yet explained — offer ONE of:
  - "Walk me through the key parts? 3 min"
  - "Drill you on a few pieces? 2 min"
  - "Open the most unclear part together?"

Pick the offer that matches the file's size + complexity. Short file = drill. Big file with clear entry point = walk-through. Messy file with unclear structure = open the most important function together.

Under 35 words total. Contractions. No preamble. Return only the 2 sentences.`;

  return aiQuery(prompt, MAX_OVERVIEW_TOKENS, { kind: "teach" });
}

async function runOverview(doc: vscode.TextDocument): Promise<string | null> {
  const lang = doc.languageId;
  const fileName = doc.fileName.split(/[\\/]/).pop() ?? "file";
  const lines = doc.getText().split("\n");
  const preview = lines.slice(0, 200).join("\n");

  // Extension-side doesn't have mastery/memory blocks yet (backend-only).
  // Send empty placeholders so the prompt template still resolves; the
  // backend persona adds memory context on the server side for chat calls.
  // Greeter calls aiQuery directly (no persona wrap) so we just note
  // "no mastery data" and let the model fall back to generic framing.
  const masteryBlock = "(mastery data not yet available on extension side)";
  const memoryBlock = "(user memory is injected at backend persona level, not here)";

  const prompt = `The user just opened a file. Give them a 2-sentence overview in voice-ready style:

Sentence 1: What the file does, in concrete terms. Reference real functions / hooks / imports you see — no generic summaries. "Handles todo state with useState and renders a list" — not "This is a React component".

Sentence 2: ONE beat about the user's relationship to it. Options:
 - If user owns this concept (mastery > 0.6): "You're solid here — nothing to flag."
 - If user is learning (0.3–0.6): "You're using X — want me to unpack it?"
 - If user is new to the concept (< 0.3): "New territory — want a 90-second tour?"
 - If file is mixed: pick the highest-value concept and invite.

Style:
- Under 35 words total. Under 18 per sentence.
- Contractions. No markdown. No metaphors. No preamble.
- End with a question OR a short statement — never both.
- Skip this entirely for trivial files (< 20 lines, only imports, test fixtures). Return the literal string SKIP if not worth saying anything.

File: ${fileName}
Language: ${lang}
User mastery on concepts in this file: ${masteryBlock}
User memory (recent struggles, level): ${memoryBlock}

\`\`\`${lang}
${preview}
\`\`\``;

  return aiQuery(prompt, MAX_OVERVIEW_TOKENS, { kind: "teach" });
}

function isEligible(doc: vscode.TextDocument): boolean {
  if (doc.uri.scheme !== "file") return false;
  if (!SUPPORTED_LANGS.has(doc.languageId)) return false;

  const fileName = doc.fileName.toLowerCase();
  if (fileName.endsWith(".d.ts")) return false;
  if (
    fileName.includes(".test.") ||
    fileName.includes(".spec.") ||
    fileName.includes("__fixtures__") ||
    fileName.includes("__mocks__")
  ) {
    return false;
  }

  const text = doc.getText();
  const lines = text.split("\n");
  const nonBlank = lines.filter((l) => l.trim().length > 0);
  if (nonBlank.length < 20) return false;

  // All non-blank lines are imports / re-exports → probably a barrel file.
  const importLike = /^\s*(import\s|export\s|from\s|require\s*\(|#include\b)/;
  if (nonBlank.every((l) => importLike.test(l))) return false;

  // Concept check: if we detect *nothing* of interest, no teaching moment.
  try {
    const concepts = detectConcepts(doc.languageId, text);
    if (concepts.length === 0 && nonBlank.length < 40) return false;
  } catch {
    // Concept detection is best-effort; don't let it block.
  }

  return true;
}

function cleanReply(raw: string): string {
  // The file-open greeter routes through aiQuery → /chat in TEXT_MODE,
  // which instructs Claude to append a `<followups>` XML block with
  // suggested next prompts. Those are meant for a text chat UI — if we
  // don't strip them here, TTS reads the block aloud character by
  // character ("less than followups ..."). Same cleanup also removes
  // markdown fences + wrapping quotes the model occasionally adds.
  return raw
    .trim()
    .replace(/<followups>[\s\S]*?<\/followups>/gi, "")
    .replace(/^```[a-zA-Z]*\n?/g, "")
    .replace(/```$/g, "")
    .replace(/^"(.+)"$/s, "$1")
    .trim();
}

function isSkipSentinel(text: string): boolean {
  const t = text.trim().toUpperCase();
  return t === "SKIP" || t.startsWith("SKIP ") || t.startsWith("SKIP.") || t.startsWith("SKIP:");
}

async function persist(context: vscode.ExtensionContext): Promise<void> {
  // Cap the stored set so globalState doesn't grow forever on huge repos.
  // We keep the most recent 500 — enough to cover a week of active work
  // without replaying greetings on the same file.
  const arr = Array.from(greetedFiles);
  const capped = arr.length > 500 ? arr.slice(arr.length - 500) : arr;
  await context.globalState.update(STORAGE_KEY, capped);

  // Garbage-collect the unowned dedup map: drop entries older than 14
  // days, since anything past that comfortably re-qualifies for a fresh
  // greeting anyway.
  const cutoff = Date.now() - 14 * 24 * 60 * 60_000;
  const pruned: Record<string, number> = {};
  for (const [key, ts] of unownedGreetedAt.entries()) {
    if (ts >= cutoff) pruned[key] = ts;
  }
  unownedGreetedAt = new Map(Object.entries(pruned));
  await context.globalState.update(UNOWNED_SEEN_KEY, pruned);
}

function shortName(uri: vscode.Uri): string {
  return uri.path.split("/").pop() ?? uri.path;
}
