import * as vscode from "vscode";
import * as path from "node:path";
import { log } from "../log.js";

/**
 * "Protege: Trace" — selection hover action.
 *
 * Given a symbol in the selection, show where it's defined and every
 * place it's called from. The teaching angle: instead of dropping the
 * user into VS Code's separate references panel, we surface a single
 * QuickPick grouped by intent (Definition · Callers · Implementations)
 * with file paths + preview lines, so reading the call graph stays
 * inside one popup the user can scroll through quickly.
 *
 * Pipeline:
 *   1. Pick the target position. If selection is non-empty and contains
 *      exactly one identifier-like token, target that token's position.
 *      Otherwise use `selection.active` and let VS Code's
 *      word-at-position detection handle disambiguation.
 *   2. Run `vscode.executeDefinitionProvider`,
 *      `vscode.executeReferenceProvider`, and
 *      `vscode.executeImplementationProvider` in parallel.
 *   3. Read each result location's line of source for a preview
 *      (cached per URI to avoid re-opening the same file 20 times).
 *   4. Render a QuickPick with separator items between sections.
 *
 * Pure VS Code API — no AI, no shell. Works in any language with a
 * language server attached (TS, Python, Go, Rust, Java, etc.).
 *
 * Logs go to the Protege output channel under tag "trace".
 */

const MAX_REFS = 50;

interface Location {
  uri: vscode.Uri;
  range: vscode.Range;
}

export async function traceCommand(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage("Protege: open a file first.");
    return;
  }

  const target = pickTargetPosition(editor);
  if (!target) {
    vscode.window.showInformationMessage(
      "Protege: put your cursor on (or select) a symbol to trace."
    );
    return;
  }

  const wordRange = editor.document.getWordRangeAtPosition(target.position);
  const symbolName = wordRange
    ? editor.document.getText(wordRange)
    : "<symbol>";

  log(
    "trace",
    `query · ${symbolName} @ ${editor.document.uri.fsPath.split("/").pop()}:${target.position.line + 1}`
  );

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: `Protege: tracing ${symbolName}…`,
    },
    async () => {
      const [defs, refs, impls] = await Promise.all([
        runProvider("vscode.executeDefinitionProvider", editor.document.uri, target.position),
        runProvider("vscode.executeReferenceProvider", editor.document.uri, target.position),
        runProvider("vscode.executeImplementationProvider", editor.document.uri, target.position),
      ]);

      // Strip duplicates: an implementation is also a definition for
      // most languages, and we don't want the same line listed twice.
      const defKeys = new Set(defs.map(locationKey));
      const dedupedImpls = impls.filter((l) => !defKeys.has(locationKey(l)));

      // Filter references: drop the line that is the definition itself,
      // since the user already sees it under Definition.
      const dedupedRefs = refs
        .filter((l) => !defKeys.has(locationKey(l)))
        .slice(0, MAX_REFS);

      if (
        defs.length === 0 &&
        dedupedRefs.length === 0 &&
        dedupedImpls.length === 0
      ) {
        vscode.window.showInformationMessage(
          `Protege: no references found for "${symbolName}". A language server may need a moment to index — try again in a few seconds.`
        );
        return;
      }

      await presentLocations(symbolName, defs, dedupedRefs, dedupedImpls);
    }
  );
}

interface TargetPosition {
  position: vscode.Position;
}

function pickTargetPosition(editor: vscode.TextEditor): TargetPosition | null {
  const sel = editor.selection;
  if (!sel.isEmpty) {
    // Selection mode: pick the first identifier-like token in the
    // selection and aim at the middle of it. The middle is more robust
    // than start — some providers reject positions that land on the
    // boundary between tokens.
    const text = editor.document.getText(sel);
    const m = /[A-Za-z_$][A-Za-z0-9_$]*/.exec(text);
    if (!m) return { position: sel.active };
    const offset = editor.document.offsetAt(sel.start) + m.index + Math.floor(m[0].length / 2);
    return { position: editor.document.positionAt(offset) };
  }
  // Cursor mode — let getWordRangeAtPosition do the work.
  const word = editor.document.getWordRangeAtPosition(sel.active);
  if (!word) return null;
  return { position: sel.active };
}

async function runProvider(
  command: string,
  uri: vscode.Uri,
  position: vscode.Position
): Promise<Location[]> {
  try {
    // The reference / definition / implementation providers all return
    // either Location[] or LocationLink[]. Normalise to Location.
    const raw = (await vscode.commands.executeCommand(
      command,
      uri,
      position
    )) as Array<vscode.Location | vscode.LocationLink> | undefined;
    if (!raw || raw.length === 0) return [];
    return raw.map((r) => {
      if ("targetUri" in r) {
        return { uri: r.targetUri, range: r.targetSelectionRange ?? r.targetRange };
      }
      return { uri: r.uri, range: r.range };
    });
  } catch (err) {
    log("trace", `${command} failed — ${(err as Error).message}`);
    return [];
  }
}

async function presentLocations(
  symbolName: string,
  defs: Location[],
  refs: Location[],
  impls: Location[]
): Promise<void> {
  const previewCache = new Map<string, string[]>();
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  type Item = vscode.QuickPickItem & { location?: Location };
  const items: Item[] = [];

  if (defs.length > 0) {
    items.push({
      label: defs.length === 1 ? "Definition" : `Definitions (${defs.length})`,
      kind: vscode.QuickPickItemKind.Separator,
    });
    for (const loc of defs) {
      items.push(await buildItem(loc, root, previewCache));
    }
  }

  if (impls.length > 0) {
    items.push({
      label: `Implementations (${impls.length})`,
      kind: vscode.QuickPickItemKind.Separator,
    });
    for (const loc of impls) {
      items.push(await buildItem(loc, root, previewCache));
    }
  }

  if (refs.length > 0) {
    const truncated = refs.length === MAX_REFS;
    items.push({
      label: truncated
        ? `Callers (showing ${MAX_REFS}+ — refine the symbol)`
        : `Callers (${refs.length})`,
      kind: vscode.QuickPickItemKind.Separator,
    });
    for (const loc of refs) {
      items.push(await buildItem(loc, root, previewCache));
    }
  }

  const pick = await vscode.window.showQuickPick(items, {
    title: `Protege · Trace ${symbolName}`,
    placeHolder: "Pick a location to jump to",
    matchOnDescription: true,
    matchOnDetail: true,
  });

  if (!pick?.location) return;

  const doc = await vscode.workspace.openTextDocument(pick.location.uri);
  const editor = await vscode.window.showTextDocument(doc, {
    viewColumn: vscode.ViewColumn.Beside,
    preview: true,
  });
  editor.selection = new vscode.Selection(pick.location.range.start, pick.location.range.end);
  editor.revealRange(pick.location.range, vscode.TextEditorRevealType.InCenter);
}

async function buildItem(
  loc: Location,
  root: string | undefined,
  previewCache: Map<string, string[]>
): Promise<vscode.QuickPickItem & { location: Location }> {
  const rel = root
    ? path.relative(root, loc.uri.fsPath).split(path.sep).join("/")
    : path.basename(loc.uri.fsPath);
  const preview = await previewLine(loc, previewCache);
  return {
    label: `$(symbol-method) ${rel}:${loc.range.start.line + 1}`,
    detail: preview,
    location: loc,
  };
}

async function previewLine(
  loc: Location,
  cache: Map<string, string[]>
): Promise<string> {
  const key = loc.uri.toString();
  let lines = cache.get(key);
  if (!lines) {
    try {
      const buf = await vscode.workspace.fs.readFile(loc.uri);
      lines = new TextDecoder("utf-8", { fatal: false })
        .decode(buf)
        .split("\n");
    } catch {
      lines = [];
    }
    cache.set(key, lines);
  }
  const line = lines[loc.range.start.line];
  if (!line) return "";
  return line.trim().slice(0, 160);
}

function locationKey(l: Location): string {
  return `${l.uri.toString()}:${l.range.start.line}:${l.range.start.character}`;
}
