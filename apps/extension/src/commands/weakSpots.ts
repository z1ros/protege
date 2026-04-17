import * as vscode from "vscode";
import { detectConcepts } from "../concepts/detector.js";
import { getRule, type Rule } from "../concepts/rules.js";

/**
 * "Protege: Show my weak spots" — shows concepts in this file
 * where the user likely needs practice.
 *
 * Uses the concept detection rules + a simple heuristic: concepts
 * that appear only once in the file and have low weight (difficulty)
 * are "weak spots" the user should practice.
 *
 * Shows results as a quick pick so the user can jump to learn any concept.
 */
export async function showWeakSpots(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const doc = editor.document;
  const lang = doc.languageId;
  const content = doc.getText();

  const concepts = detectConcepts(lang, content);

  if (concepts.length === 0) {
    vscode.window.showInformationMessage(
      "No tracked concepts found in this file. Save some code to start tracking!"
    );
    return;
  }

  // Count occurrences of each concept
  const counts = new Map<string, number>();
  for (const c of concepts) {
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }

  // Unique concepts with their metadata
  const items: vscode.QuickPickItem[] = [];
  const seen = new Set<string>();

  for (const [name, count] of counts) {
    if (seen.has(name)) continue;
    seen.add(name);

    const rule = getRule(name);
    const weight = rule?.weight ?? 1;

    // Heuristic: single use + low weight = probably unfamiliar
    const strength =
      count >= 3 ? "strong" : count >= 2 ? "moderate" : "weak";
    const icon =
      strength === "strong"
        ? "$(check)"
        : strength === "moderate"
          ? "$(circle-outline)"
          : "$(warning)";

    items.push({
      label: `${icon} ${name}`,
      description: `${count} use${count > 1 ? "s" : ""} · weight ${weight}`,
      detail:
        strength === "weak"
          ? "You've only used this once — consider practicing it"
          : strength === "moderate"
            ? "Getting familiar — keep using it"
            : "Looking solid",
    });
  }

  // Sort: weak first, then moderate, then strong
  const order = { "$(warning)": 0, "$(circle-outline)": 1, "$(check)": 2 };
  items.sort((a, b) => {
    const aIcon = a.label.split(" ")[0];
    const bIcon = b.label.split(" ")[0];
    return (order[aIcon as keyof typeof order] ?? 1) - (order[bIcon as keyof typeof order] ?? 1);
  });

  const weakCount = items.filter((i) => i.label.includes("$(warning)")).length;

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `${concepts.length} concepts in this file · ${weakCount} need practice`,
    matchOnDescription: true,
    matchOnDetail: true,
  });

  if (picked) {
    const conceptName = picked.label.replace(/^\$\(\w+\)\s*/, "");
    vscode.commands.executeCommand("protege.teachConcept", conceptName);
  }
}
