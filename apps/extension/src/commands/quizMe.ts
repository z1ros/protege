import * as vscode from "vscode";
import { detectConcepts } from "../concepts/detector.js";
import { aiGenerateQuiz } from "../ai/aiExplain.js";

/**
 * "Protege: Quiz me" — generates a quick quiz from concepts in the file.
 *
 * Picks 3 concepts from the current file, asks a multiple-choice question
 * for each. All local — no API call. Uses the teach knowledge base for
 * wrong answers (mistakes from other concepts make good distractors).
 */
export async function quizMe(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const doc = editor.document;
  const lang = doc.languageId;
  const concepts = [...new Set(detectConcepts(lang, doc.getText()))];

  if (concepts.length === 0) {
    vscode.window.showInformationMessage(
      "No concepts found to quiz you on. Write some code first!"
    );
    return;
  }

  const shuffled = concepts.sort(() => Math.random() - 0.5);
  const selected = shuffled.slice(0, 3);

  let score = 0;
  let total = 0;

  for (const concept of selected) {
    // Use real AI to generate the question
    const quiz = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Generating question about ${concept}...` },
      () => aiGenerateQuiz(concept, lang)
    );
    if (!quiz) continue;

    total++;

    const options = [quiz.correct, ...quiz.wrong].sort(() => Math.random() - 0.5);

    const answer = await vscode.window.showQuickPick(options, {
      placeHolder: `Quiz (${total}/3): ${quiz.question}`,
    });

    if (!answer) break;

    if (answer === quiz.correct) {
      score++;
      vscode.window.showInformationMessage(`Correct.`);
    } else {
      vscode.window.showWarningMessage(
        `Not quite. The answer: ${quiz.correct}`
      );
    }

    // Small pause between questions
    await new Promise((r) => setTimeout(r, 800));
  }

  if (total > 0) {
    const choice = await vscode.window.showInformationMessage(
      `Quiz done. Score: ${score}/${total}`,
      "Learn weak spots",
      "Done"
    );
    if (choice === "Learn weak spots") {
      vscode.commands.executeCommand("protege.weakSpots");
    }
  }
}
