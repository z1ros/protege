import * as vscode from "vscode";
import { aiQuery } from "../ai/aiBackend.js";
import { detectConcepts } from "../concepts/detector.js";
import { broadcast } from "../chat/webviewHost.js";
import { getCurrentSessionId, legacySessionIdFor } from "../chat/chatSessions.js";
import { currentUserIdOrNull } from "../user/protegeClient.js";
import type { ChatMessage } from "@protege/types";

/**
 * Exercise Engine — teaching through DOING, not reading.
 *
 * When Protege teaches a concept, it creates a scratch exercise file
 * with a challenge the user must solve. The engine then WATCHES the
 * file for changes and verifies the solution — giving real-time
 * feedback as the user types.
 *
 * Flow:
 *   1. Protege teaches "closures" in chat or peek view
 *   2. User clicks "Practice this" or Protege auto-creates exercise
 *   3. A scratch file opens with:
 *      - A comment explaining the challenge
 *      - Starter code with blanks to fill
 *      - Tests (assertions) that verify the solution
 *   4. As user types, the engine checks:
 *      - Do the assertions pass?
 *      - Is the concept used correctly?
 *      - Are there common mistakes?
 *   5. Inline feedback appears:
 *      - ✅ "Correct! The closure captures the outer variable."
 *      - ❌ "Not quite — your function doesn't return a function."
 *      - 💡 "Hint: the inner function needs access to `count`."
 *   6. On success → IQ bonus + "mastered" badge on the concept
 */

interface Exercise {
  concept: string;
  language: string;
  challenge: string;
  starterCode: string;
  solution: string;
  hints: string[];
  testCode: string; // assertions that verify correctness
}

// Track active exercises
let activeExercise: {
  exercise: Exercise;
  uri: vscode.Uri;
  watcher: vscode.Disposable;
  decoration: vscode.TextEditorDecorationType;
  solved: boolean;
} | null = null;

// ---- Registration ----

export function registerExerciseEngine(
  context: vscode.ExtensionContext
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand(
      "protege.createExercise",
      (concept?: string, language?: string) =>
        createExercise(concept, language)
    ),
    vscode.commands.registerCommand("protege.checkExercise", checkExercise),
    vscode.commands.registerCommand("protege.showHint", showHint),
    new vscode.Disposable(() => cleanupExercise()),
  ];
}

// ---- Create Exercise ----

async function createExercise(
  concept?: string,
  language?: string
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const lang = language ?? editor?.document.languageId ?? "typescript";

  // If no concept specified, pick one from the current file
  if (!concept && editor) {
    const concepts = detectConcepts(lang, editor.document.getText());
    if (concepts.length > 0) {
      concept = concepts[Math.floor(Math.random() * concepts.length)];
    }
  }

  if (!concept) {
    concept = await vscode.window.showInputBox({
      prompt: "What concept should I create an exercise for?",
      placeHolder: "e.g. closures, async/await, useEffect...",
    });
  }
  if (!concept) return;

  // Clean up any previous exercise
  cleanupExercise();

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Protege: creating exercise for "${concept}"...`,
    },
    async () => {
      const exercise = await generateExercise(concept!, lang);
      if (!exercise) {
        vscode.window.showErrorMessage("Couldn't generate an exercise. Try again.");
        return;
      }

      // Create the scratch file
      const fileContent = buildExerciseFile(exercise);
      const doc = await vscode.workspace.openTextDocument({
        content: fileContent,
        language: lang.includes("react") ? "typescriptreact" : lang,
      });
      const exerciseEditor = await vscode.window.showTextDocument(
        doc,
        vscode.ViewColumn.Beside
      );

      // Decoration for feedback
      const decoration = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        after: {
          margin: "0 0 0 2em",
          fontStyle: "italic",
          // VS Code's ThemableDecorationAttachmentRenderOptions has no
          // `fontSize` field, but textDecoration is a free-form CSS string
          // that gets inlined — so we smuggle the font-size through it.
          textDecoration: "none; font-size: 0.85em",
        },
      });

      // Watch for changes — check the solution as user types.
      // Trailing-edge debounce: clear the prior timer on every keystroke
      // so we fire exactly ONE LLM verdict request 1s after the user
      // stops typing. Without resetting the timer, every keystroke
      // scheduled its own check — burning quota + cost on partial code.
      let checkTimer: ReturnType<typeof setTimeout> | null = null;
      const watcher = vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() !== doc.uri.toString()) return;
        if (activeExercise?.solved) return;
        if (checkTimer) clearTimeout(checkTimer);
        checkTimer = setTimeout(() => {
          checkTimer = null;
          if (activeExercise && !activeExercise.solved) {
            checkExerciseInline(exerciseEditor, exercise, decoration);
          }
        }, 1000);
      });

      activeExercise = {
        exercise,
        uri: doc.uri,
        watcher,
        decoration,
        solved: false,
      };

      // Announce in chat
      broadcast(chatMsg(
        `**Exercise: ${exercise.concept}**\n\n${exercise.challenge}\n\nI've opened a practice file beside your editor. Fill in the code and I'll check it as you type.\n\n<followups>\nShow me a hint\nI give up — show solution\n</followups>`
      ));
    }
  );
}

// ---- Generate Exercise via AI ----

async function generateExercise(
  concept: string,
  language: string
): Promise<Exercise | null> {
  const result = await aiQuery(
    `You are creating a coding exercise to teach "${concept}" in ${language}.

Create a small, focused exercise. The user should write 3-10 lines of code.

Reply in JSON (no markdown fencing):
{
  "concept": "${concept}",
  "language": "${language}",
  "challenge": "One paragraph explaining what to do",
  "starterCode": "// Code with blanks marked as ??? or TODO",
  "solution": "// The correct completed code",
  "hints": ["hint 1 if stuck", "hint 2 more specific"],
  "testCode": "// Assertions that verify correctness, e.g.:\\n// console.assert(result === expected, 'message')"
}

Rules:
- The starter code should have clear TODO markers showing what to fill in
- The solution should be 3-10 lines, not a full program
- Tests should use console.assert() or simple comparisons
- Make the exercise practical, not academic
- Include at least 2 hints (vague first, specific second)`,
    1024,
    { kind: "teach" }
  );

  if (!result) return null;

  try {
    const cleaned = result.replace(/^```json?\n?/, "").replace(/\n?```$/, "").trim();
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

// ---- Build Exercise File ----

function buildExerciseFile(ex: Exercise): string {
  const divider = "=".repeat(60);
  return `// ${divider}
// PROTEGE EXERCISE: ${ex.concept}
// ${divider}
//
// ${ex.challenge.replace(/\n/g, "\n// ")}
//
// Fill in the code below. Protege will check your work as you type.
// Press Cmd+K H for a hint if you're stuck.
// ${divider}

${ex.starterCode}

// ${divider}
// TESTS — don't edit below this line
// ${divider}

${ex.testCode}
`;
}

// ---- Check Exercise (inline, as user types) ----

async function checkExerciseInline(
  editor: vscode.TextEditor,
  exercise: Exercise,
  decoration: vscode.TextEditorDecorationType
): Promise<void> {
  const code = editor.document.getText();

  // Quick local checks first
  const hasTodo = code.includes("???") || code.includes("TODO");
  const hasAsserts = code.includes("console.assert") || code.includes("assert(");

  if (hasTodo) {
    // Still has blanks. The `???` / `TODO` placeholder in the code is
    // already visually self-evident; no additional arrow-tag after-
    // decoration needed. We still clear any prior grading feedback so
    // stale "✅/❌" from the previous check doesn't linger while the
    // user is typing their next attempt.
    editor.setDecorations(decoration, []);
    return;
  }

  // No more TODOs — check if the concept is actually used
  const concepts = detectConcepts(exercise.language, code);
  const usedConcept = concepts.includes(exercise.concept) ||
    concepts.some(c => c.toLowerCase().includes(exercise.concept.toLowerCase()));

  if (!usedConcept) {
    // Concept not detected in the code
    const lastCodeLine = findLastCodeLine(editor.document);
    if (lastCodeLine !== null) {
      editor.setDecorations(decoration, [{
        range: new vscode.Range(lastCodeLine, 0, lastCodeLine, 0),
        renderOptions: {
          after: {
            contentText: `  Hmm — I don't see ${exercise.concept} being used yet`,
            color: "rgba(224, 108, 117, 0.8)",
          },
        },
      }]);
    }
    return;
  }

  // Concept is used — ask AI to verify the solution
  const verdict = await aiQuery(
    `You are checking a student's exercise about "${exercise.concept}" in ${exercise.language}.

Their code:
\`\`\`${exercise.language}
${code}
\`\`\`

The correct solution:
\`\`\`${exercise.language}
${exercise.solution}
\`\`\`

Is their solution correct? Reply in JSON (no fencing):
{"correct": true/false, "feedback": "one sentence — what's right or what's wrong"}`,
    128,
    { kind: "teach" }
  );

  if (!verdict) return;

  try {
    const parsed = JSON.parse(
      verdict.replace(/^```json?\n?/, "").replace(/\n?```$/, "").trim()
    );

    const lastCodeLine = findLastCodeLine(editor.document);
    if (lastCodeLine === null) return;

    if (parsed.correct) {
      // SUCCESS!
      activeExercise!.solved = true;
      editor.setDecorations(decoration, [{
        range: new vscode.Range(lastCodeLine, 0, lastCodeLine, 0),
        renderOptions: {
          after: {
            contentText: `  Correct — ${parsed.feedback}`,
            color: "rgba(152, 195, 121, 0.9)",
          },
        },
      }]);

      broadcast(chatMsg(
        `**Exercise complete.**\n\n${parsed.feedback}\n\nYou've practiced **${exercise.concept}** hands-on. This is how real learning works.\n\n<followups>\nAnother exercise\nTeach me something new\n</followups>`
      ));

      vscode.window.showInformationMessage(
        `Exercise passed. You nailed ${exercise.concept}.`
      );
    } else {
      editor.setDecorations(decoration, [{
        range: new vscode.Range(lastCodeLine, 0, lastCodeLine, 0),
        renderOptions: {
          after: {
            contentText: `  Not quite — ${parsed.feedback}`,
            color: "rgba(224, 108, 117, 0.8)",
          },
        },
      }]);
    }
  } catch {
    // AI response wasn't valid JSON — ignore
  }
}

// ---- Standalone check command ----

async function checkExercise(): Promise<void> {
  if (!activeExercise) {
    vscode.window.showInformationMessage("No active exercise. Create one first.");
    return;
  }
  const editor = vscode.window.visibleTextEditors.find(
    (e) => e.document.uri.toString() === activeExercise!.uri.toString()
  );
  if (!editor) return;
  await checkExerciseInline(editor, activeExercise.exercise, activeExercise.decoration);
}

// ---- Hints ----

let hintIndex = 0;

async function showHint(): Promise<void> {
  if (!activeExercise) {
    vscode.window.showInformationMessage("No active exercise.");
    return;
  }
  const hints = activeExercise.exercise.hints;
  if (hints.length === 0) {
    vscode.window.showInformationMessage("No hints available for this exercise.");
    return;
  }
  const hint = hints[Math.min(hintIndex, hints.length - 1)];
  hintIndex++;

  broadcast(chatMsg(`**Hint ${Math.min(hintIndex, hints.length)}/${hints.length}:** ${hint}`));
}

// ---- Cleanup ----

function cleanupExercise(): void {
  if (!activeExercise) return;
  activeExercise.watcher.dispose();
  activeExercise.decoration.dispose();
  activeExercise = null;
  hintIndex = 0;
}

// ---- Helpers ----

function findLine(doc: vscode.TextDocument, search: string): number | null {
  for (let i = 0; i < doc.lineCount; i++) {
    if (doc.lineAt(i).text.includes(search)) return i;
  }
  return null;
}

function findLastCodeLine(doc: vscode.TextDocument): number | null {
  for (let i = doc.lineCount - 1; i >= 0; i--) {
    const text = doc.lineAt(i).text.trim();
    if (text && !text.startsWith("//") && !text.startsWith("*")) return i;
  }
  return null;
}

/** Build a host-side assistant broadcast for the active chat session.
 *  See teachingFlow.ts chatMsg for the same rationale. */
function chatMsg(content: string): { type: "chat/append"; message: ChatMessage } {
  const sessionId =
    getCurrentSessionId() ??
    legacySessionIdFor(currentUserIdOrNull() ?? "local-dev");
  return {
    type: "chat/append",
    message: {
      id: crypto.randomUUID(),
      sessionId,
      role: "assistant",
      content,
      createdAt: new Date().toISOString(),
    },
  };
}
