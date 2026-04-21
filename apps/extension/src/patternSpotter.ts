import * as vscode from "vscode";
import { aiQuery } from "./aiBackend.js";
import { log } from "./log.js";

/**
 * Proactive Pattern Spotter — background scan for LEARNING moments
 * (not bugs). After the user has been editing for a while and then
 * pauses, we ask Haiku to spot ONE pattern in their code worth
 * understanding: a decaying concept, a correctly-used-but-subtle idiom,
 * or a small repetition with a cleaner form.
 *
 * The result surfaces as a native VS Code notification with a "Teach me"
 * action that routes to the existing `protege.teachConcept` command.
 * No webview changes — intentionally quiet.
 *
 * Firing gate (ALL must hold):
 *   - edits made since last pitch ≥ EDITS_THRESHOLD (proxy for "user has
 *     been working a while")
 *   - idle ≥ IDLE_MS (no edits in the last minute — user paused)
 *   - cooldown ≥ COOLDOWN_MS since the previous pitch
 *
 * Dedup:
 *   - Seen-concept map in globalState keyed by concept name → timestamp.
 *     A concept won't re-surface within REPEAT_MS (24h).
 *
 * The plan explicitly says "silence is better than nagging". When in
 * doubt, the model returns `skip: true` and we do nothing.
 */

const TICK_MS = 30_000;              // poll every 30s
const IDLE_MS = 60_000;              // user must be idle 60s before we fire
const EDITS_THRESHOLD = 30;          // ~30 keystrokes / doc-change events
const COOLDOWN_MS = 15 * 60_000;     // 15 min between pitches
const REPEAT_MS = 24 * 60 * 60_000;  // 24h before re-pitching the same concept
const MAX_PROMPT_LINES = 220;        // cap sent context; cloud-friendly

const SEEN_KEY = "protege.patternSpotterSeen";    // Record<concept, timestamp>
const LAST_PITCH_KEY = "protege.patternSpotterLastPitchAt";

const SUPPORTED_LANGS = new Set([
  "typescript", "typescriptreact", "javascript", "javascriptreact",
  "python", "go", "rust", "java", "csharp", "cpp", "c", "ruby",
  "php", "swift", "kotlin", "scala", "vue", "svelte",
]);

let lastEditAt = 0;
let editsSinceLastPitch = 0;
let lastPitchAt = 0;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

export function registerPatternSpotter(
  context: vscode.ExtensionContext
): vscode.Disposable[] {
  // Hydrate cooldown so a reload doesn't grant a free pitch.
  lastPitchAt = context.globalState.get<number>(LAST_PITCH_KEY) ?? 0;

  const disposables: vscode.Disposable[] = [];

  disposables.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.scheme !== "file") return;
      if (!SUPPORTED_LANGS.has(e.document.languageId)) return;
      if (e.contentChanges.length === 0) return;
      lastEditAt = Date.now();
      editsSinceLastPitch++;
    })
  );

  tickTimer = setInterval(() => {
    void maybeFire(context);
  }, TICK_MS);

  disposables.push({
    dispose() {
      if (tickTimer) {
        clearInterval(tickTimer);
        tickTimer = null;
      }
    },
  });

  return disposables;
}

async function maybeFire(context: vscode.ExtensionContext): Promise<void> {
  if (inFlight) return;

  const now = Date.now();
  if (editsSinceLastPitch < EDITS_THRESHOLD) return;
  if (lastEditAt === 0) return;
  if (now - lastEditAt < IDLE_MS) return;
  if (now - lastPitchAt < COOLDOWN_MS) return;

  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== "file") return;
  if (!SUPPORTED_LANGS.has(editor.document.languageId)) return;

  inFlight = true;
  try {
    const pitch = await runSpotter(editor);
    if (!pitch) return;

    // Dedup against seen-concepts.
    const seen = context.globalState.get<Record<string, number>>(SEEN_KEY) ?? {};
    const last = seen[pitch.concept] ?? 0;
    if (now - last < REPEAT_MS) {
      log("patternSpotter", `skip — concept "${pitch.concept}" was pitched ${Math.round((now - last) / 60_000)}min ago`);
      return;
    }

    await showPitch(context, pitch);

    // Regardless of user response, reset activity counter + record cooldown.
    editsSinceLastPitch = 0;
    lastPitchAt = now;
    await context.globalState.update(LAST_PITCH_KEY, now);

    seen[pitch.concept] = now;
    // Prune any 7+ day old entries so the map doesn't grow forever.
    const weekAgo = now - 7 * 24 * 60 * 60_000;
    for (const k of Object.keys(seen)) {
      if ((seen[k] ?? 0) < weekAgo) delete seen[k];
    }
    await context.globalState.update(SEEN_KEY, seen);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("patternSpotter", `spotter FAIL — ${msg}`);
  } finally {
    inFlight = false;
  }
}

interface Pitch {
  concept: string;
  pitch: string;
  location?: { path?: string; line?: number };
}

async function runSpotter(editor: vscode.TextEditor): Promise<Pitch | null> {
  const doc = editor.document;
  const lang = doc.languageId;
  const fileName = doc.fileName.split(/[\\/]/).pop() ?? "file";
  const lines = doc.getText().split("\n");
  const preview = lines.slice(0, MAX_PROMPT_LINES).join("\n");

  const prompt = `Watch the user's code over the last 10 minutes of editing. Spot ONE pattern they just used that's worth understanding — not a bug, not a finding, a LEARNING opportunity.

Priorities (in order):
1. A concept in their mastery list that's decaying (they learned it ≥ 5 days ago, haven't practiced it since, and it just appeared in their code)
2. A pattern they used CORRECTLY but might not understand deeply (e.g. they used useMemo but the actual performance win is subtle)
3. A small idiom they repeated 2–3 times that has a cleaner form

Return a JSON object:
- "concept": kebab-case
- "location": { "path", "line" }
- "pitch": one sentence, under 18 words, that INVITES them — no obligation. E.g. "You just used useMemo three times — want 60 seconds on when it actually helps?"
- "skip": true | false — if nothing is worth surfacing, set skip: true and return

Budget: one pitch per 15 minutes max. If in doubt, skip. Silence is better than nagging.

File: ${fileName}
Language: ${lang}

\`\`\`${lang}
${preview}
\`\`\`

Return ONLY the JSON object. No prose, no markdown fences.`;

  const raw = await aiQuery(prompt, 220, { kind: "teach" });
  if (!raw) return null;

  const parsed = parsePitch(raw);
  if (!parsed) {
    log("patternSpotter", `parse FAIL · first 200ch · ${raw.slice(0, 200)}`);
    return null;
  }
  if (parsed.skip) {
    log("patternSpotter", `model returned skip:true for ${fileName}`);
    return null;
  }
  if (!parsed.concept || !parsed.pitch) {
    log("patternSpotter", `missing fields: concept="${parsed.concept}" pitch="${parsed.pitch}"`);
    return null;
  }

  return {
    concept: parsed.concept.trim(),
    pitch: parsed.pitch.trim(),
    location: parsed.location,
  };
}

interface RawPitch {
  concept?: string;
  pitch?: string;
  skip?: boolean;
  location?: { path?: string; line?: number };
}

function parsePitch(raw: string): RawPitch | null {
  // Strip markdown fences if the model wrapped the object despite the rule.
  let cleaned = raw.trim();
  const fence = /^```(?:json|JSON)?\s*([\s\S]*?)\s*```\s*$/m;
  const m = cleaned.match(fence);
  if (m && m[1]) cleaned = m[1].trim();

  try {
    const obj = JSON.parse(cleaned) as unknown;
    if (obj && typeof obj === "object") return obj as RawPitch;
  } catch {
    // fall through to balanced-brace rescue
  }

  // Rescue: first balanced {...}
  const start = cleaned.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(cleaned.slice(start, i + 1)) as RawPitch;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

async function showPitch(
  context: vscode.ExtensionContext,
  pitch: Pitch
): Promise<void> {
  log(
    "patternSpotter",
    `pitch · concept="${pitch.concept}" · ${pitch.pitch.length}ch`
  );

  // Native, non-modal, auto-dismisses if user ignores it. No obligation.
  const choice = await vscode.window.showInformationMessage(
    pitch.pitch,
    "Teach me",
    "Not now"
  );

  if (choice === "Teach me") {
    await vscode.commands.executeCommand("protege.teachConcept", pitch.concept);
  }
  // "Not now" or dismiss → no action. Concept is still marked seen so we
  // don't re-pitch the same thing tomorrow.
}
