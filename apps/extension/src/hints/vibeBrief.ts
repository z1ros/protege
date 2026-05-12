import * as vscode from "vscode";
import { aiQuery } from "../ai/aiBackend.js";
import {
  onChangeOrigin,
  type ChangeOriginEvent,
} from "../detection/changeOriginDetector.js";
import { markExplained } from "../user/ownership.js";
import { log } from "../log.js";

/**
 * Vibecode Briefing — the 30-second "you just accepted this code, here's
 * what you need to know" panel.
 *
 * When the user accepts a burst of AI-generated code (Cursor / Claude
 * Code diff, large paste), Protege opens a native VS Code comment
 * thread directly below the pasted range with two fields:
 *
 *   ### What it does
 *     One-sentence plain English summary.
 *
 *   ### One thing to know
 *     The single most likely way this breaks in production.
 *
 * The thread also carries three command links:
 *   ✓ Got it   → marks the range as explained in ownership, collapses
 *   ↗ Tell me more → opens the sidebar with a deeper teach prompt
 *   ✕ Dismiss  → disposes the thread without raising ownership
 *
 * Why a comment thread and not a toast / hover / sidebar:
 *   - Sits INLINE, anchored to the exact range the code landed in.
 *   - STICKY until the user dismisses (hovers vanish on cursor move).
 *   - Native UI — matches GitHub PR review threads the user already
 *     knows. Collapsible via the caret if they want to keep coding.
 *   - Uses the stable `vscode.comments` namespace — works in Cursor
 *     today, no proposed API dependency.
 *
 * One LLM call per burst, 400-token cap. Per-file 15s cooldown plus a
 * global 3-in-flight cap so fan-out pastes can't burn tokens.
 */

// ---- Tuning ----

const BRIEFING_MAX_TOKENS = 400;
const BRIEFING_COOLDOWN_MS = 15_000;
const BRIEFING_MAX_IN_FLIGHT = 3;
/** Independent minimum-change gate — even if the classifier says a
 *  change is auto-inserted (e.g. fast-typing trips the pace rule, or
 *  the grey-zone LLM returns a false positive on a 4-char edit), the
 *  briefing itself refuses to fire on anything smaller than a
 *  meaningful chunk of code. A `let → const` token swap is never a
 *  vibecoding moment worth briefing about, regardless of how the
 *  classifier scored it. Require EITHER ≥10 lines of change OR
 *  ≥150 chars of new content. */
const BRIEFING_MIN_LINES = 10;
const BRIEFING_MIN_CHARS = 150;
const LAST_CALL_CAP = 500;
const LAST_CALL_GC_AGE_MS = 10 * 60_000;
/** Grace window after a file first opens during which we suppress
 *  briefings. Blocks a common false positive: Prettier / ESLint /
 *  import-sorter / EOL-normalizer plugins fire `onDidChangeTextDocument`
 *  right after VS Code opens a file, which the classifier sees as a
 *  huge auto-insert (whole-file replace). 5s chosen over 2s because
 *  TypeScript LSP init + ESLint auto-fix can land 3-5s after open on
 *  large workspaces. Genuine user pastes within the first 5s are rare
 *  — no one opens a file just to immediately paste into it. */
const FIRST_SEEN_GRACE_MS = 5_000;

// ---- Module state ----

let controller: vscode.CommentController | null = null;
/** Active threads keyed by `${uri}:${startLine}` so bursts landing in
 *  the same spot replace the previous briefing instead of stacking. */
const activeThreads = new Map<string, vscode.CommentThread>();
/** Per-file cooldown map. Bounded + GC'd on write. */
const lastBriefingAt = new Map<string, number>();
/** ms epoch of when each file-scheme document was first-seen this
 *  session. Populated at register time for already-open docs + on
 *  `onDidOpenTextDocument`. Cleared on close so reopen stamps again.
 *  Checked in `maybeShowBriefing` to block the first-visit false
 *  positive where a plugin's auto-edit trips the classifier. */
const firstSeenAt = new Map<string, number>();
let inFlight = 0;

// ---- Registration ----

export function registerVibeBrief(
  context: vscode.ExtensionContext
): vscode.Disposable[] {
  controller = vscode.comments.createCommentController(
    "protege.vibeBrief",
    "Protege briefings"
  );
  // We set `canReply = false` per-thread (v1 doesn't route replies),
  // but controller.options still drives the placeholder when v2 turns
  // replies on — harmless to set now.
  controller.options = {
    prompt: "Ask a follow-up about this code…",
    placeHolder: "e.g. what if the user is logged out?",
  };

  const disposables: vscode.Disposable[] = [controller];

  // Seed first-seen timestamps for every file already open when the
  // extension activates. Without this, "first visit to a file after
  // not visiting it" during an in-progress session has no stamp and
  // the grace check would pass through (the default 0 epoch is
  // arbitrarily far in the past).
  const nowAtRegister = Date.now();
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.uri.scheme === "file") {
      firstSeenAt.set(doc.uri.toString(), nowAtRegister);
    }
  }

  // Stamp whenever a new doc opens (or re-opens after being closed).
  disposables.push(
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (doc.uri.scheme !== "file") return;
      firstSeenAt.set(doc.uri.toString(), Date.now());
    })
  );
  disposables.push(
    vscode.workspace.onDidCloseTextDocument((doc) => {
      const uriKey = doc.uri.toString();
      firstSeenAt.delete(uriKey);
      // Dispose any lingering briefing threads for this file. Without
      // this, comment threads persist in VS Code's state — closing a
      // file mid-briefing and reopening it later resurfaces the stale
      // thread even though the user dismissed/ignored it. A fresh
      // burst will create a new thread if warranted.
      // activeThreads keys as `${uri}:${startLine}` so we iterate +
      // match by URI prefix, not a single lookup.
      const prefix = uriKey + ":";
      for (const [key, thread] of [...activeThreads.entries()]) {
        if (!key.startsWith(prefix)) continue;
        try {
          thread.dispose();
        } catch {
          /* already disposed */
        }
        activeThreads.delete(key);
      }
    })
  );

  disposables.push(
    onChangeOrigin((evt) => {
      // Brief on AI inserts AND user pastes — both are "code that landed
      // without keystroke-level authorship," same trust gap.
      if (evt.origin !== "auto-inserted" && evt.origin !== "pasted") return;
      void maybeShowBriefing(evt);
    })
  );

  disposables.push(
    vscode.commands.registerCommand(
      "protege.vibeBrief.gotIt",
      async (args: {
        uri: string;
        startLine: number;
        endLine: number;
      } | undefined) => {
        if (!args) return;
        try {
          markExplained(vscode.Uri.parse(args.uri), args.startLine, args.endLine);
        } catch (err) {
          log(
            "vibeBrief",
            `markExplained failed — ${err instanceof Error ? err.message : String(err)}`
          );
        }
        disposeThread(args.uri, args.startLine);
      }
    )
  );

  disposables.push(
    vscode.commands.registerCommand(
      "protege.vibeBrief.tellMore",
      async (args: {
        uri: string;
        startLine: number;
        endLine: number;
        briefing: string;
      } | undefined) => {
        if (!args) return;
        try {
          const { openProtegePanel } = await import("../panel.js");
          const { broadcast } = await import("../chat/webviewHost.js");
          openProtegePanel(context);
          const fileName = args.uri.split("/").pop() ?? "this file";
          setTimeout(() => {
            broadcast({
              type: "chat/autoSend",
              message:
                `Protege wrote this briefing about code I just accepted in ${fileName} ` +
                `(lines ${args.startLine + 1}–${args.endLine + 1}):\n\n` +
                `"${args.briefing}"\n\n` +
                `Walk me through this in more depth — what else should I know ` +
                `before shipping? Include one concrete scenario where it breaks. ` +
                `Under 200 words.`,
            });
          }, 250);
        } catch (err) {
          log(
            "vibeBrief",
            `tellMore failed — ${err instanceof Error ? err.message : String(err)}`
          );
        }
        // Dismiss the thread — the deeper explanation is now in the
        // sidebar chat. Leaving the comment-thread briefing on screen
        // while the chat also has content about it feels redundant;
        // users reported it as "clicking both Got it and Tell me more
        // should make the thread go away."
        disposeThread(args.uri, args.startLine);
      }
    )
  );

  disposables.push(
    vscode.commands.registerCommand(
      "protege.vibeBrief.dismiss",
      (args: { uri: string; startLine: number } | undefined) => {
        if (!args) return;
        disposeThread(args.uri, args.startLine);
      }
    )
  );

  // Dispose any live threads on deactivate so reloads don't leak them.
  disposables.push({
    dispose() {
      for (const thread of activeThreads.values()) {
        try {
          thread.dispose();
        } catch {
          /* ignore */
        }
      }
      activeThreads.clear();
      firstSeenAt.clear();
      controller = null;
    },
  });

  log("vibeBrief", "installed");
  return disposables;
}

// ---- Burst handler ----

async function maybeShowBriefing(evt: ChangeOriginEvent): Promise<void> {
  if (!controller) return;
  if (evt.uri.scheme !== "file") return;

  // Minimum-size gate — independent of classifier verdict. A small
  // token swap (`let` → `const`, `foo` → `bar`) sometimes gets
  // misclassified as auto-inserted when the user types fast enough
  // to trip the pace rule. Even when the classification is technically
  // correct, a briefing on a 5-char edit is noise. Require EITHER a
  // meaningful line-count OR character-count change.
  const newLen = evt.newText?.length ?? evt.charsAdded;
  if (evt.linesAdded < BRIEFING_MIN_LINES && newLen < BRIEFING_MIN_CHARS) {
    log(
      "vibeBrief",
      `skipped · below min-size · ${evt.linesAdded}L/${newLen}ch`
    );
    return;
  }

  const uriKey = evt.uri.toString();
  const now = Date.now();

  // First-visit grace window. When a user opens a file after not
  // visiting it, VS Code extensions (Prettier / ESLint auto-fix / EOL
  // normalizer / import sorter) commonly fire a large `onDidChange` as
  // soon as the buffer loads. That gets classified as a burst and a
  // briefing used to pop before the user had touched the file. Now we
  // hold the briefing for the first 2s after open — real user edits
  // land after that, plugin edits don't.
  const firstSeen = firstSeenAt.get(uriKey);
  if (firstSeen && now - firstSeen < FIRST_SEEN_GRACE_MS) {
    log(
      "vibeBrief",
      `skipped · first-seen grace · ${evt.uri.fsPath.split("/").pop()}`
    );
    return;
  }

  // Whole-file-replace detector — formatter signature. When Prettier /
  // ESLint fix-all / organize-imports runs, it fires one content change
  // that replaces a huge fraction of the file (the whole reformatted
  // output). We detect that by comparing `replacedText` length against
  // current file length. If > 50% of the file was replaced in a single
  // change, it's a formatter, not a paste. Users don't paste over 50%
  // of a file at once in practice.
  if (
    typeof evt.replacedText === "string" &&
    evt.replacedText.length > 0
  ) {
    try {
      const doc = vscode.workspace.textDocuments.find(
        (d) => d.uri.toString() === uriKey
      );
      if (doc) {
        const currentLen = doc.getText().length;
        if (
          currentLen > 0 &&
          evt.replacedText.length / currentLen > 0.5
        ) {
          log(
            "vibeBrief",
            `skipped · looks like a formatter rewrite (${evt.replacedText.length}/${currentLen} chars replaced)`
          );
          return;
        }
      }
    } catch {
      /* if we can't read the doc, don't block on this check */
    }
  }

  // Per-file cooldown: one briefing per file per 15s. A single big
  // Cursor diff often lands as several adjacent contentChange events
  // from the extension host's POV — without this cooldown we'd fire
  // two LLM calls back-to-back on the same paste.
  const since = now - (lastBriefingAt.get(uriKey) ?? 0);
  if (since < BRIEFING_COOLDOWN_MS) return;

  // Global concurrency cap: a batch-paste across 20 files shouldn't
  // fan out 20 concurrent LLM calls. Third call in wins, rest skip.
  if (inFlight >= BRIEFING_MAX_IN_FLIGHT) return;

  if (lastBriefingAt.size >= LAST_CALL_CAP) gcLastCallMap(now);
  lastBriefingAt.set(uriKey, now);

  let doc: vscode.TextDocument;
  try {
    doc = await vscode.workspace.openTextDocument(evt.uri);
  } catch {
    return;
  }

  inFlight++;
  try {
    const briefing = await generateBriefing(
      doc,
      evt.startLine,
      evt.endLine,
      evt.replacedText,
      evt.newText
    );
    if (!briefing) return;
    showThread(evt.uri, evt.startLine, evt.endLine, briefing);
  } catch (err) {
    log(
      "vibeBrief",
      `generate failed — ${err instanceof Error ? err.message : String(err)}`
    );
  } finally {
    inFlight = Math.max(0, inFlight - 1);
  }
}

// ---- Prompt + parse ----

interface Briefing {
  what_it_does: string;
  gotcha: string;
}

async function generateBriefing(
  doc: vscode.TextDocument,
  startLine: number,
  endLine: number,
  replacedText: string | undefined,
  newText: string | undefined
): Promise<Briefing | null> {
  const lang = doc.languageId;
  const totalLines = doc.lineCount;
  const safeStart = Math.max(0, Math.min(totalLines - 1, startLine));
  const safeEnd = Math.max(safeStart, Math.min(totalLines - 1, endLine));
  const contextStart = Math.max(0, safeStart - 10);
  const contextEnd = Math.min(totalLines - 1, safeEnd + 10);

  const pasted: string[] = [];
  for (let i = safeStart; i <= safeEnd; i++) {
    pasted.push(doc.lineAt(i).text);
  }
  const context: string[] = [];
  for (let i = contextStart; i <= contextEnd; i++) {
    const marker = i >= safeStart && i <= safeEnd ? "> " : "  ";
    context.push(`${marker}${doc.lineAt(i).text}`);
  }

  const fileName = doc.uri.fsPath.split("/").pop() ?? "file";
  const lineCount = safeEnd - safeStart + 1;

  // Delta-aware branch — when the change DetailRouter gave us pre-change
  // text AND it's non-trivial (at least one of before/after is substantial
  // AND they actually differ), frame the briefing as "what CHANGED" rather
  // than "what this code is". That way a paste into an existing component
  // produces a delta briefing ("added loading + error states") instead of
  // re-summarizing the whole region ("fetches todos" — which the user
  // already knew from last week's identical paste).
  const hasMeaningfulDelta =
    typeof replacedText === "string" &&
    typeof newText === "string" &&
    replacedText.trim().length > 0 &&
    newText.trim() !== replacedText.trim();

  const prompt = hasMeaningfulDelta
    ? buildDeltaPrompt({
        fileName,
        lang,
        safeStart,
        safeEnd,
        before: replacedText as string,
        after: newText as string,
        contextBlock: context.join("\n"),
      })
    : buildFullPrompt({
        fileName,
        lang,
        safeStart,
        safeEnd,
        lineCount,
        pastedBlock: pasted.join("\n"),
        contextBlock: context.join("\n"),
      });

  const raw = await aiQuery(prompt, BRIEFING_MAX_TOKENS, { kind: "scan" });
  if (!raw) return null;
  return parseBriefing(raw);
}

/** The original "summarize what's here" prompt — used when we don't
 *  have a pre-change snapshot to diff against. */
function buildFullPrompt(p: {
  fileName: string;
  lang: string;
  safeStart: number;
  safeEnd: number;
  lineCount: number;
  pastedBlock: string;
  contextBlock: string;
}): string {
  return `The user just accepted ${p.lineCount} lines of AI-generated code in ${p.fileName}. They did not type it — they accepted a suggestion from Cursor or Claude Code. They want a 30-second briefing so they know what they just shipped.

Accepted code (lines ${p.safeStart + 1}–${p.safeEnd + 1}):
\`\`\`${p.lang}
${p.pastedBlock}
\`\`\`

Context (accepted lines prefixed with >):
\`\`\`${p.lang}
${p.contextBlock}
\`\`\`

Return ONLY a JSON object, no prose, no markdown fences:
{
  "what_it_does": "one or two sentences in plain English, read-aloud style. What this code DOES in the system. Reference real identifiers you see. No preamble, no 'this code…'. Start with a verb.",
  "gotcha": "ONE concrete thing that will bite them — the MOST likely way this breaks in production. Name a specific input value, a missing handler, a race, a security assumption, or a null case. If the code is genuinely trivial (a pure constant, a type alias), say 'Nothing subtle here — ' then one sentence confirming its role. Maximum 2 sentences."
}

Rules:
 - Respectful peer, not quiz-master.
 - "what_it_does" references specific names from the code.
 - "gotcha" is ONE thing, the most important. Never a list.
 - No exclamation marks.
 - Each string under 45 words.

Return ONLY the JSON object.`;
}

/** Delta-aware prompt — fires when we have both BEFORE and AFTER text
 *  for the changed range. Asks the model to describe what CHANGED and
 *  what new assumption was introduced, not to re-summarize the whole
 *  file. This is the fix for "same basic briefing every paste into an
 *  existing component." */
function buildDeltaPrompt(p: {
  fileName: string;
  lang: string;
  safeStart: number;
  safeEnd: number;
  before: string;
  after: string;
  contextBlock: string;
}): string {
  return `The user just accepted an AI edit in ${p.fileName} (Cursor / Claude Code). Code at lines ${p.safeStart + 1}–${p.safeEnd + 1} was REPLACED with new code — they didn't type it. They want a 30-second diff-aware briefing on what CHANGED, not a re-summary of the whole region.

BEFORE (what was at the range):
\`\`\`${p.lang}
${p.before}
\`\`\`

AFTER (what's there now):
\`\`\`${p.lang}
${p.after}
\`\`\`

Surrounding context (the accepted lines are prefixed with > in this block):
\`\`\`${p.lang}
${p.contextBlock}
\`\`\`

Return ONLY a JSON object, no prose, no markdown fences:
{
  "what_it_does": "one or two sentences describing the DELTA — what's new or different now that wasn't before. Reference real identifiers from the AFTER. Start with a verb like 'Adds…', 'Replaces…', 'Switches…', 'Removes…'. NEVER re-summarize what the whole region does if the delta is small — focus on what's different.",
  "gotcha": "ONE concrete thing the DELTA introduced that could bite them. Prefer risks the BEFORE code didn't have — a new assumption, a new null case, a new race, a new mutation, a new external dep. If the delta is genuinely safe (pure rename, formatting), say 'Nothing subtle here — ' then one sentence naming what changed. Max 2 sentences."
}

Rules:
 - The "what_it_does" field talks about the DIFF, not the file.
 - "gotcha" focuses on what's NEWLY RISKY, not pre-existing issues.
 - Reference specific identifiers from BEFORE vs AFTER when that sharpens the point.
 - No exclamation marks. Each string under 45 words.
 - If BEFORE and AFTER are semantically identical (whitespace-only, rename-only), "what_it_does" should say that plainly and "gotcha" should be the 'Nothing subtle here' form.

Return ONLY the JSON object.`;
}

function parseBriefing(raw: string): Briefing | null {
  // Strip markdown fences + followups pollution, then find the first
  // balanced {…} and JSON.parse it. Same approach explainBack uses.
  const cleaned = raw
    .trim()
    .replace(/<followups>[\s\S]*?<\/followups>/gi, "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();

  const candidates: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        candidates.push(cleaned.slice(start, i + 1));
        start = -1;
      }
    }
  }
  candidates.sort((a, b) => b.length - a.length);
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c) as Partial<Briefing>;
      if (
        typeof parsed.what_it_does === "string" &&
        typeof parsed.gotcha === "string"
      ) {
        return {
          what_it_does: parsed.what_it_does,
          gotcha: parsed.gotcha,
        };
      }
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

// ---- Thread lifecycle ----

function showThread(
  uri: vscode.Uri,
  startLine: number,
  endLine: number,
  briefing: Briefing
): void {
  if (!controller) return;

  const key = threadKey(uri.toString(), startLine);
  // Replace any existing thread at this key — a new burst on the same
  // line supersedes the old briefing.
  const existing = activeThreads.get(key);
  if (existing) {
    try {
      existing.dispose();
    } catch {
      /* ignore */
    }
    activeThreads.delete(key);
  }

  const range = new vscode.Range(startLine, 0, endLine, 0);

  const md = new vscode.MarkdownString();
  md.isTrusted = true;
  md.supportHtml = false;
  md.appendMarkdown(`### What it does\n\n${briefing.what_it_does}\n\n`);
  md.appendMarkdown(`### One thing to know\n\n${briefing.gotcha}\n\n`);
  md.appendMarkdown(`---\n\n`);

  const fullArgs = encodeURIComponent(
    JSON.stringify({
      uri: uri.toString(),
      startLine,
      endLine,
      briefing: `${briefing.what_it_does} ${briefing.gotcha}`,
    })
  );
  const shortArgs = encodeURIComponent(
    JSON.stringify({ uri: uri.toString(), startLine })
  );

  md.appendMarkdown(
    `**[✓ Got it](command:protege.vibeBrief.gotIt?${fullArgs})**` +
      ` · ` +
      `**[↗ Tell me more](command:protege.vibeBrief.tellMore?${fullArgs})**` +
      ` · ` +
      `**[✕ Dismiss](command:protege.vibeBrief.dismiss?${shortArgs})**`
  );

  const comment: vscode.Comment = {
    body: md,
    mode: vscode.CommentMode.Preview,
    author: { name: "Protege" },
  };

  const thread = controller.createCommentThread(uri, range, [comment]);
  const lineCount = endLine - startLine + 1;
  thread.label = `Briefing · ${lineCount} ${lineCount === 1 ? "line" : "lines"}`;
  thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
  // v1: no replies. v2 can flip this to true and wire a reply handler
  // that routes into the sidebar chat.
  thread.canReply = false;

  activeThreads.set(key, thread);
  log(
    "vibeBrief",
    `thread shown · ${uri.fsPath.split("/").pop()} · lines ${startLine}-${endLine}`
  );
}

function disposeThread(uriStr: string, startLine: number): void {
  const key = threadKey(uriStr, startLine);
  const thread = activeThreads.get(key);
  if (!thread) return;
  try {
    thread.dispose();
  } catch {
    /* ignore */
  }
  activeThreads.delete(key);
}

function threadKey(uriStr: string, startLine: number): string {
  return `${uriStr}:${startLine}`;
}

// ---- GC ----

function gcLastCallMap(now: number): void {
  const cutoff = now - LAST_CALL_GC_AGE_MS;
  for (const [k, ts] of lastBriefingAt) {
    if (ts < cutoff) lastBriefingAt.delete(k);
  }
  if (lastBriefingAt.size > LAST_CALL_CAP) {
    const sorted = [...lastBriefingAt.entries()].sort((a, b) => a[1] - b[1]);
    const overBy = lastBriefingAt.size - LAST_CALL_CAP;
    for (let i = 0; i < overBy; i++) lastBriefingAt.delete(sorted[i][0]);
  }
}
