import * as vscode from "vscode";
import type { OwnershipSummary } from "@protege/types";
import { log } from "../log.js";
import {
  getOwnership,
  listTrackedOwnership,
  isTourOrExplainBackActive,
} from "./ownership.js";
import { aiQuery } from "../ai/aiBackend.js";
import {
  installBreakDetector,
  onBreak,
  type BreakEvent,
  type BreakType,
} from "../detection/breakDetector.js";

/**
 * Ownership Inviter — the single nudge surface.
 *
 * Subscribes to `onBreak`, picks the highest-leverage unreviewed file,
 * asks Haiku for a conversational 45-char chip label (OWNERSHIP_NUDGE_COPY),
 * and pops a status-bar item. Click → dispatch Tour / ExplainBack / dismiss.
 *
 * Gates (all must pass to show a chip):
 *   - setting `protege.ownership.invitations !== "off"`
 *   - dedupe: at most ONE chip per break-type per local day
 *   - at least one workspace file has state `unknown` or `partial`
 *   - no Tour / ExplainBack currently active
 *   - (belt & braces) not already showing a chip
 *
 * The chip auto-expires after 30s. The `"aggressive"` setting disables
 * the per-day dedupe, which is useful while we're tuning.
 */

const CHIP_TTL_MS = 30_000;
const DEDUPE_KEY = "protege.ownership.inviter.dedupe";

/** Emotional beat per break type — fed into the chip-copy prompt so the
 *  label lands in the moment the user is actually in. post-commit is a
 *  victory-lap; idle is a stepback; end-of-day is a wrap. */
const BREAK_TONES: Record<BreakType, string> = {
  "post-commit":
    "victory-lap. they just shipped something. acknowledge the ship before offering the review.",
  "post-save-clean":
    "calm-after-green. no errors, a natural pause. suggest tracing the change they just saved.",
  "idle-10min":
    "stepback. they've been afk 10 min. frame as 'while you're away' — low-pressure.",
  "end-of-day":
    "wrap-up. after 5pm, idle. frame as closing one loose thread before end of day.",
  "unfamiliar-file-open":
    "just-landed. they opened a file they mostly didn't write. offer to open it together.",
};

interface DedupeState {
  /** ISO-date string (yyyy-mm-dd) → Set of break-types already fired. */
  [date: string]: string[];
}

let ctx: vscode.ExtensionContext | null = null;
let statusBar: vscode.StatusBarItem | null = null;
let currentChip: {
  path: string;
  summary: OwnershipSummary;
  expire: NodeJS.Timeout;
} | null = null;
/** True while the "Tour / ExplainBack / Dismiss" QuickPick is showing.
 *  Guards against a new break event showing a second chip behind the
 *  open dialog — the user would have no idea which one they're acting
 *  on. */
let dispatcherOpen = false;

export function registerOwnershipInviter(
  context: vscode.ExtensionContext
): vscode.Disposable[] {
  ctx = context;
  const disposables: vscode.Disposable[] = [];

  statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    110
  );
  statusBar.command = "protege.ownership.acceptChip";
  disposables.push(statusBar);

  // Wire break-detector's ownership-aware hook so it can fire
  // unfamiliar-file-open without importing ownership itself.
  disposables.push(
    installBreakDetector({
      isUnfamiliar(uri) {
        return getOwnership(uri).state === "unknown";
      },
    })
  );

  disposables.push(
    onBreak((evt) => {
      void handleBreak(evt);
    })
  );

  disposables.push(
    vscode.commands.registerCommand("protege.ownership.acceptChip", async () => {
      await showDispatcher();
    })
  );
  disposables.push(
    vscode.commands.registerCommand("protege.ownership.dismissChip", () => {
      dismissChip();
    })
  );

  return disposables;
}

async function handleBreak(evt: BreakEvent): Promise<void> {
  if (!ctx) return;
  const mode = readInvitationsMode();
  if (mode === "off") return;
  if (isTourOrExplainBackActive()) return;
  if (currentChip) return;

  if (dispatcherOpen) return;
  if (mode !== "aggressive" && alreadyFiredToday(evt.type)) return;

  // Pick the candidate. For unfamiliar-file-open, the break itself
  // names the file. For everything else, scan tracked ownership and
  // choose the worst.
  let candidate: { uri: vscode.Uri; path: string; summary: OwnershipSummary } | null = null;
  if (evt.type === "unfamiliar-file-open" && evt.uri) {
    const summary = getOwnership(evt.uri);
    if (summary.state !== "untracked" && summary.state !== "owned") {
      candidate = {
        uri: evt.uri,
        path: shortPath(evt.uri),
        summary,
      };
    }
  } else {
    candidate = pickWorstFile();
  }
  if (!candidate) return;

  markFiredToday(evt.type);

  const label = await buildChipLabel(candidate, evt.type);
  showChip(candidate, label);
}

function pickWorstFile(): {
  uri: vscode.Uri;
  path: string;
  summary: OwnershipSummary;
} | null {
  const tracked = listTrackedOwnership();
  const eligible = tracked
    .filter(
      (t) =>
        t.summary.state === "unknown" || t.summary.state === "partial"
    )
    .sort((a, b) => a.summary.ownedPct - b.summary.ownedPct);
  if (eligible.length === 0) return null;
  const top = eligible[0];
  try {
    const uri = vscode.Uri.parse(top.uriKey);
    return {
      uri,
      path: shortPath(uri),
      summary: top.summary,
    };
  } catch {
    return null;
  }
}

async function buildChipLabel(
  cand: { uri: vscode.Uri; path: string; summary: OwnershipSummary },
  breakType: BreakType
): Promise<string> {
  // Short deterministic fallback covers cold path + aiQuery failures.
  const fallback = `\u25CE ${cand.path} — review ${cand.summary.unknownLines} lines?`;

  const tracked = listTrackedOwnership()
    .filter(
      (t) => t.summary.state === "unknown" || t.summary.state === "partial"
    )
    .sort((a, b) => a.summary.ownedPct - b.summary.ownedPct)
    .slice(0, 3);

  if (tracked.length === 0) return fallback;

  // Ground the time estimate in line count (~40 lines/min review pace)
  // so the chip doesn't fabricate numbers. Floor at 1 minute.
  const estMinutes = (lines: number) => Math.max(1, Math.round(lines / 40));

  const fileLines = tracked
    .map((t) => {
      const name = shortPath(safeParse(t.uriKey) ?? cand.uri);
      return `- ${name} (${Math.round(t.summary.ownedPct * 100)}% owned, ${t.summary.unknownLines} unreviewed, ~${estMinutes(t.summary.unknownLines)} min)`;
    })
    .join("\n");

  // Each break type carries a different emotional beat. Giving the model
  // the beat (not just the label) lets the copy land on-tone instead of
  // defaulting to the same generic "review?" every time.
  const toneHint = BREAK_TONES[breakType];
  const candMinutes = estMinutes(cand.summary.unknownLines);

  const prompt = `The user just hit a natural break: ${breakType}
Tone for this break: ${toneHint}

Unreviewed files in this workspace:
${fileLines}

Write a SINGLE status-bar chip label, 55 characters or fewer. Pick the most urgent file (lowest ownership + most recently-modified) and name it specifically — use an actual function name, concept, or line count, not a generic verb. The chip is an INVITATION, not a command. User can ignore it.

Use the time estimate shown above for the named file — do NOT fabricate a different number. The primary candidate is ${cand.path} (~${candMinutes} min).

Format: "\u25CE <file> — <specific offer> · <time>"
Examples (tone varies by break type):
  post-commit:       "\u25CE auth.ts — shipped. walk the 120 unseen? 3 min"
  idle-10min:        "\u25CE payments.ts — while afk, review the retry path? 4 min"
  end-of-day:        "\u25CE cache.ts — one loose thread before you close? 2 min"
  post-save-clean:   "\u25CE router.ts — clean save. trace the new route? 2 min"
  unfamiliar-file:   "\u25CE queue.ts — 80% unknown. open together? 5 min"

NO exclamation marks. NO "important!" urgency. A fact + a gentle offer.
Return ONLY the chip string.`;

  try {
    const raw = await aiQuery(prompt, 80, { kind: "teach" });
    if (!raw) return fallback;
    const cleaned = raw
      .trim()
      .replace(/^["']|["']$/g, "")
      .replace(/<followups>[\s\S]*?<\/followups>/gi, "")
      .split("\n")[0]
      .trim();
    if (!cleaned || cleaned.length > 80) return fallback;
    return cleaned;
  } catch (err) {
    log(
      "ownershipInviter",
      `label gen failed — ${err instanceof Error ? err.message : String(err)}`
    );
    return fallback;
  }
}

function showChip(
  cand: { uri: vscode.Uri; path: string; summary: OwnershipSummary },
  label: string
): void {
  if (!statusBar) return;
  statusBar.text = label;
  statusBar.tooltip =
    `${cand.path} · ${Math.round(cand.summary.ownedPct * 100)}% owned · ${cand.summary.unknownLines} lines unreviewed\n` +
    `Click to review together (Tour · ExplainBack · Dismiss)`;
  statusBar.show();

  const expire = setTimeout(dismissChip, CHIP_TTL_MS);
  currentChip = { path: cand.uri.toString(), summary: cand.summary, expire };

  log(
    "ownershipInviter",
    `chip shown · ${cand.path} · ${label}`
  );
}

function dismissChip(): void {
  if (currentChip) {
    clearTimeout(currentChip.expire);
    currentChip = null;
  }
  if (statusBar) statusBar.hide();
}

async function showDispatcher(): Promise<void> {
  if (!currentChip) return;
  const path = currentChip.path;
  dispatcherOpen = true;
  let pick: { id: "tour" | "explainBack" | "dismiss" } | undefined;
  try {
    pick = await vscode.window.showQuickPick(
      [
        { label: "$(compass) Tour the file", id: "tour" as const },
        { label: "$(comment-discussion) Explain it back", id: "explainBack" as const },
        { label: "$(eye-closed) Dismiss for today", id: "dismiss" as const },
      ],
      {
        placeHolder: "How do you want to review this file?",
        matchOnDetail: true,
      }
    );
  } finally {
    dispatcherOpen = false;
  }
  if (!pick) {
    dismissChip();
    return;
  }

  dismissChip();

  try {
    const uri = vscode.Uri.parse(path);
    if (pick.id === "dismiss") {
      return;
    }
    // Open the file first so subsequent actions have an active editor.
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });

    if (pick.id === "tour") {
      await vscode.commands.executeCommand("protege.tour.startCodebase");
    } else if (pick.id === "explainBack") {
      // Default to the top-unknown range so the user starts on the
      // part of the file that most needs explanation.
      const summary = getOwnership(uri);
      if (summary.topUnknownRange) {
        const r = new vscode.Range(
          summary.topUnknownRange.startLine,
          0,
          summary.topUnknownRange.endLine,
          Number.MAX_SAFE_INTEGER
        );
        editor.selection = new vscode.Selection(r.start, r.end);
        editor.revealRange(r);
      }
      await vscode.commands.executeCommand("protege.explainBack.start");
    }
  } catch (err) {
    log(
      "ownershipInviter",
      `dispatcher failed — ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// ---- dedupe + settings ----

function readInvitationsMode(): "off" | "natural-breaks" | "aggressive" {
  const v = vscode.workspace
    .getConfiguration("protege")
    .get<string>("ownership.invitations", "natural-breaks");
  if (v === "off" || v === "aggressive") return v;
  return "natural-breaks";
}

function todayKey(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function alreadyFiredToday(type: BreakType): boolean {
  if (!ctx) return false;
  const state = ctx.globalState.get<DedupeState>(DEDUPE_KEY) ?? {};
  return (state[todayKey()] ?? []).includes(type);
}

function markFiredToday(type: BreakType): void {
  if (!ctx) return;
  const state = ctx.globalState.get<DedupeState>(DEDUPE_KEY) ?? {};
  const key = todayKey();
  const today = new Set(state[key] ?? []);
  today.add(type);
  state[key] = [...today];
  // Garbage-collect old date entries so state doesn't grow forever.
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 7);
  const cutoffIso = cutoff.toISOString().slice(0, 10);
  for (const k of Object.keys(state)) {
    if (k < cutoffIso) delete state[k];
  }
  void ctx.globalState.update(DEDUPE_KEY, state);
}

function shortPath(uri: vscode.Uri): string {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const abs = uri.fsPath;
  if (root && abs.startsWith(root)) {
    const rel = abs.slice(root.length + 1);
    const parts = rel.split("/");
    if (parts.length > 2) return `${parts[0]}/…/${parts[parts.length - 1]}`;
    return rel;
  }
  return abs.split("/").pop() ?? abs;
}

function safeParse(s: string): vscode.Uri | null {
  try {
    return vscode.Uri.parse(s);
  } catch {
    return null;
  }
}
