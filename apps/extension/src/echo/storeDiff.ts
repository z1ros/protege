import * as vscode from "vscode";
import * as path from "node:path";
import { authHeaders } from "../user/auth.js";
import { BACKEND_URL, currentUserIdOrNull } from "../user/protegeClient.js";

/**
 * Diagnostic command: prompt for a time window, hit the backend's
 * `/echo/debug/recent` inspector, and pretty-print what changed in the
 * store since that window started. Answers "did my typing actually land
 * in the database?" without the user having to read the raw JSON file.
 */

interface RecentChangesSnapshot {
  since: string;
  now: string;
  echoEvents: Array<{
    ts: number;
    type: string;
    file?: string;
    payload: Record<string, unknown>;
  }>;
  echoEventsByType: Record<string, number>;
  fileAuthorshipCounters: Array<{
    filePath: string;
    humanChars: number;
    aiChars: number;
    updatedAt: string;
  }>;
  conceptStates: Array<{
    conceptName: string;
    timesUsed: number;
    authorshipRatio: number | null;
    hasBeenAuthored: boolean;
    lastUsedAt: string;
    firstAuthoredAt: string | null;
  }>;
  conceptEncounters: Array<{
    concept: string;
    filePath: string;
    seenAt: string;
    authorshipRatioAtTime: number | null;
  }>;
  behaviorRollups: Array<{
    date: string;
    activeMinutes: number;
    linesAdded: number;
    linesRemoved: number;
    archetypeHint: string | null;
  }>;
  commitStories: Array<{
    commitSha: string;
    commitTs: string;
    message: string;
  }>;
  conceptStatuses: Array<{
    concept: string;
    status: string;
    updatedAt: string;
  }>;
}

let channel: vscode.OutputChannel | null = null;

export function startStoreDiff(
  context: vscode.ExtensionContext,
  _userId: string | null
): vscode.Disposable {
  channel = vscode.window.createOutputChannel("Protege Echo Store Diff");

  const cmd = vscode.commands.registerCommand(
    "protege.showStoreDiff",
    async () => {
      const userId = currentUserIdOrNull();
      if (!userId) {
        vscode.window.showInformationMessage(
          "Sign in with GitHub to view the Echo store diff."
        );
        return;
      }
      const raw = await vscode.window.showInputBox({
        prompt: "Show store changes since how many minutes ago?",
        value: "5",
        validateInput: (v) => {
          const n = Number(v);
          if (!Number.isFinite(n) || n <= 0) return "Must be a positive number";
          return null;
        },
      });
      if (raw === undefined) return; // user cancelled
      const minutes = Number(raw);
      const sinceMs = Date.now() - minutes * 60_000;

      let snap: RecentChangesSnapshot;
      try {
        const url = `${BACKEND_URL}/echo/debug/recent?since=${sinceMs}&userId=${encodeURIComponent(userId)}`;
        const res = await fetch(url, {
          method: "GET",
          headers: { ...authHeaders() },
        });
        if (!res.ok) {
          vscode.window.showErrorMessage(
            `Store diff fetch failed: HTTP ${res.status}`
          );
          return;
        }
        snap = (await res.json()) as RecentChangesSnapshot;
      } catch (err) {
        vscode.window.showErrorMessage(
          `Store diff fetch error: ${err instanceof Error ? err.message : String(err)}`
        );
        return;
      }

      if (channel) {
        channel.clear();
        const header = formatHeader(snap.since, minutes);
        channel.appendLine(header);
        channel.appendLine("");
        channel.appendLine(formatSnapshot(snap));
        channel.show(true);
      }
    }
  );
  context.subscriptions.push(cmd);

  return new vscode.Disposable(() => {
    cmd.dispose();
    channel?.dispose();
    channel = null;
  });
}

function formatHeader(sinceIso: string, minutes: number): string {
  const t = new Date(sinceIso);
  const hh = String(t.getHours()).padStart(2, "0");
  const mm = String(t.getMinutes()).padStart(2, "0");
  const ss = String(t.getSeconds()).padStart(2, "0");
  return `── changes since ${hh}:${mm}:${ss} (${minutes}m ago) ──`;
}

function basename(file: string): string {
  if (!file.includes("/") && !file.includes("\\")) return file;
  return path.basename(file);
}

function timeHMS(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function timeFromIso(iso: string): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return iso;
  return timeHMS(ts);
}

function formatSnapshot(snap: RecentChangesSnapshot): string {
  const lines: string[] = [];

  // ----- echoEvents -----
  const totalEvents = snap.echoEvents.length;
  const breakdown = Object.entries(snap.echoEventsByType).sort(
    (a, b) => b[1] - a[1]
  );
  // Use the aggregate count (sum of breakdown) as the "rows" number since
  // `echoEvents` array is capped at 100 by the backend, but echoEventsByType
  // counts everything in window.
  const totalByType = breakdown.reduce((acc, [, n]) => acc + n, 0);
  lines.push(`echoEvents: ${totalByType} rows`);
  for (const [t, n] of breakdown) {
    lines.push(`  ${t}: ${n}`);
  }
  if (totalEvents > 0) {
    lines.push("");
    lines.push(`  recent (latest ${Math.min(10, totalEvents)}):`);
    for (const e of snap.echoEvents.slice(0, 10)) {
      lines.push(`    [${timeHMS(e.ts)}] ${e.type.padEnd(16)} ${eventLineFields(e)}`);
    }
  }
  lines.push("");

  // ----- fileAuthorshipCounters -----
  lines.push(
    `fileAuthorshipCounters: ${snap.fileAuthorshipCounters.length} updated`
  );
  for (const r of snap.fileAuthorshipCounters) {
    const total = r.humanChars + r.aiChars;
    const ratio = total > 0 ? (r.humanChars / total).toFixed(2) : "—";
    lines.push(
      `  ${basename(r.filePath)}: humanChars=${r.humanChars} aiChars=${r.aiChars} (ratio ${ratio})`
    );
  }
  lines.push("");

  // ----- conceptStates -----
  lines.push(`conceptStates: ${snap.conceptStates.length} updated`);
  for (const c of snap.conceptStates) {
    if (c.hasBeenAuthored) {
      const firstAuth = c.firstAuthoredAt ?? "—";
      lines.push(
        `  ${c.conceptName}: timesUsed=${c.timesUsed} hasBeenAuthored=true firstAuthoredAt=${firstAuth} (AUTHORED FLAG SET)`
      );
    } else {
      const ratio =
        c.authorshipRatio !== null ? c.authorshipRatio.toFixed(2) : "null";
      lines.push(
        `  ${c.conceptName}: timesUsed=${c.timesUsed} hasBeenAuthored=false authorshipRatio=${ratio}`
      );
    }
  }
  lines.push("");

  // ----- conceptEncounters -----
  lines.push(`conceptEncounters: ${snap.conceptEncounters.length} appended`);
  for (const r of snap.conceptEncounters) {
    const ratio =
      r.authorshipRatioAtTime !== null
        ? r.authorshipRatioAtTime.toFixed(2)
        : "null";
    lines.push(
      `  ${r.concept} @ ${basename(r.filePath)} (ratio ${ratio}) at ${timeFromIso(r.seenAt)}`
    );
  }
  lines.push("");

  // ----- behaviorRollups -----
  lines.push(`behaviorRollups: ${snap.behaviorRollups.length} updated`);
  for (const r of snap.behaviorRollups) {
    const arche = r.archetypeHint ?? "null";
    lines.push(
      `  ${r.date}: activeMinutes=${r.activeMinutes} linesAdded=${r.linesAdded} linesRemoved=${r.linesRemoved} archetypeHint=${arche}`
    );
  }
  lines.push("");

  // ----- commitStories -----
  lines.push(`commitStories: ${snap.commitStories.length}`);
  for (const r of snap.commitStories) {
    lines.push(
      `  ${r.commitSha.slice(0, 7)} at ${timeFromIso(r.commitTs)}: ${r.message}`
    );
  }

  // ----- conceptStatuses -----
  lines.push(`conceptStatuses: ${snap.conceptStatuses.length}`);
  for (const r of snap.conceptStatuses) {
    lines.push(`  ${r.concept}: ${r.status} @ ${timeFromIso(r.updatedAt)}`);
  }

  return lines.join("\n");
}

function eventLineFields(e: {
  type: string;
  file?: string;
  payload: Record<string, unknown>;
}): string {
  const parts: string[] = [];
  if (e.file) parts.push(`file=${basename(e.file)}`);
  const p = e.payload ?? {};
  switch (e.type) {
    case "keystroke_batch":
      if (p.charsTyped !== undefined) parts.push(`charsTyped=${p.charsTyped}`);
      break;
    case "line_diff":
      if (p.linesAdded !== undefined && p.linesRemoved !== undefined) {
        parts.push(`+${p.linesAdded} -${p.linesRemoved}`);
      }
      break;
    case "concept_encountered":
      if (p.concept !== undefined) parts.push(`concept=${p.concept}`);
      break;
    case "ai_suggestion_accepted":
      if (p.charsAccepted !== undefined || p.chars !== undefined) {
        parts.push(`charsAccepted=${p.charsAccepted ?? p.chars}`);
      }
      break;
    case "paste_classified":
      if (p.source !== undefined) parts.push(`kind=${p.source}`);
      if (p.chars !== undefined) parts.push(`chars=${p.chars}`);
      break;
    case "commit_detected":
      if (p.sha !== undefined) parts.push(`sha=${String(p.sha).slice(0, 7)}`);
      break;
  }
  return parts.join("  ");
}
