import * as vscode from "vscode";
import { aiQuery } from "./aiBackend.js";
import { showTeachPopups } from "./teachPopup.js";
import { getActiveFileEditor } from "./activeFile.js";
import { broadcast } from "./webviewHost.js";
import type { ChatMessage } from "@protege/types";

/**
 * Multi-Step Teaching Flows — JARVIS Plan 2, Prompt 7.
 *
 * When the user asks a complex question ("explain React hooks"), the
 * response router detects it's a multi-step topic and hands it off to
 * this module. Instead of dumping one long reply, Protege delivers the
 * teaching in 3-4 guided steps, each triggering different IDE actions.
 *
 * Flow:
 *   1. First call → Claude generates a structured plan (JSON)
 *   2. Chat shows: "I'll walk you through this in N steps. Starting step 1..."
 *   3. Step 1 triggers: highlight code + teaching popup
 *   4. User clicks "Next step →" in chat → step 2 fires
 *   5. Each step: different IDE action + chat message
 *   6. Final step: practice file created
 *
 * The webview drives step advancement via "teachFlow/next" messages.
 */

interface TeachStep {
  title: string;
  explanation: string;
  /** Symbols to highlight in the user's code */
  highlight: string[];
  /** Code example to show */
  example?: { code: string; lang: string };
  /** If true, create a practice scratch file on this step */
  practice?: boolean;
}

interface ActiveFlow {
  topic: string;
  steps: TeachStep[];
  currentStep: number;
  lang: string;
}

let activeFlow: ActiveFlow | null = null;

// ---- Public API ----

export function registerTeachingFlow(): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("protege.startTeachFlow", startFlow),
    vscode.commands.registerCommand("protege.nextTeachStep", nextStep),
    vscode.commands.registerCommand("protege.stopTeachFlow", stopFlow),
  ];
}

/** Called from responseRouter when a complex teaching topic is detected */
export async function startTeachingFlow(
  topic: string,
  lang: string
): Promise<void> {
  await startFlow(topic, lang);
}

export function isFlowActive(): boolean {
  return activeFlow !== null;
}

export function advanceFlow(): void {
  nextStep();
}

// ---- Core ----

async function startFlow(topic?: string, lang?: string): Promise<void> {
  const editor = getActiveFileEditor();
  const fileLang = lang ?? editor?.document.languageId ?? "typescript";
  const flowTopic = topic ?? await askTopic();
  if (!flowTopic) return;

  // Get file context for Claude
  const fileContent = editor?.document.getText().slice(0, 2000) ?? "";

  broadcast(chatMsg(
    `Starting guided lesson on **${flowTopic}**... Let me prepare the steps.`
  ));

  try {
    const prompt = `You are a coding mentor creating a step-by-step lesson about "${flowTopic}" in ${fileLang}.

The student's current code:
\`\`\`${fileLang}
${fileContent}
\`\`\`

Create a 3-4 step teaching plan. Each step should build on the previous one.

Reply in this EXACT JSON format (no markdown fencing):
{
  "steps": [
    {
      "title": "Step title",
      "explanation": "2-3 sentence explanation for this step",
      "highlight": ["symbol1", "symbol2"],
      "example": { "code": "example code", "lang": "${fileLang}" }
    },
    {
      "title": "Practice",
      "explanation": "Now try it yourself...",
      "highlight": [],
      "practice": true
    }
  ]
}

Rules:
- "highlight" should contain symbol names that exist in the student's code
- Make step 1 about understanding what they already have
- Make step 2-3 about improving / learning new patterns
- Make the last step a practice exercise
- Keep explanations short and practical`;

    const reply = await aiQuery(prompt, 512, { kind: "teach" });
    if (!reply) {
      vscode.window.showWarningMessage("Protege: no response from AI backend for lesson generation.");
      return;
    }

    // Parse the JSON
    let parsed: { steps: TeachStep[] };
    try {
      const cleaned = reply.replace(/^```json?\n?/, "").replace(/\n?```$/, "").trim();
      parsed = JSON.parse(cleaned);
    } catch {
      // If parsing fails, create a simple 2-step flow
      parsed = {
        steps: [
          {
            title: `Understanding ${flowTopic}`,
            explanation: reply.slice(0, 300),
            highlight: [],
          },
          {
            title: "Practice",
            explanation: `Try using ${flowTopic} in your own code.`,
            highlight: [],
            practice: true,
          },
        ],
      };
    }

    if (!parsed.steps || parsed.steps.length === 0) {
      broadcast(chatMsg(`I couldn't create a lesson plan for "${flowTopic}". Try asking a more specific question.`));
      return;
    }

    activeFlow = {
      topic: flowTopic,
      steps: parsed.steps,
      currentStep: 0,
      lang: fileLang,
    };

    // Show the plan overview
    const stepList = parsed.steps
      .map((s, i) => `${i + 1}. ${s.title}`)
      .join("\n");

    broadcast(chatMsg(
      `**Guided lesson: ${flowTopic}** (${parsed.steps.length} steps)\n\n${stepList}\n\nStarting step 1...`
    ));

    // Execute step 1
    await executeStep(0);

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    broadcast(chatMsg(`Failed to create lesson: ${msg}`));
  }
}

async function nextStep(): Promise<void> {
  if (!activeFlow) {
    vscode.window.showInformationMessage("No active teaching flow. Start one from chat or Command Palette.");
    return;
  }

  const next = activeFlow.currentStep + 1;
  if (next >= activeFlow.steps.length) {
    // Flow complete
    broadcast(chatMsg(
      `**Lesson complete!** You've finished all ${activeFlow.steps.length} steps on "${activeFlow.topic}". Great work! 🎉`
    ));
    activeFlow = null;
    return;
  }

  activeFlow.currentStep = next;
  await executeStep(next);
}

function stopFlow(): void {
  if (!activeFlow) return;
  broadcast(chatMsg(`Lesson on "${activeFlow.topic}" stopped.`));
  activeFlow = null;
}

async function executeStep(stepIdx: number): Promise<void> {
  if (!activeFlow) return;
  const step = activeFlow.steps[stepIdx];
  if (!step) return;

  const total = activeFlow.steps.length;
  const isLast = stepIdx === total - 1;

  // Chat message for this step
  let chatContent = `**Step ${stepIdx + 1}/${total}: ${step.title}**\n\n${step.explanation}`;

  if (step.example) {
    chatContent += `\n\n\`\`\`${step.example.lang}\n${step.example.code}\n\`\`\``;
  }

  if (!isLast) {
    chatContent += `\n\n<followups>\nNext step →\nStop lesson\n</followups>`;
  } else {
    chatContent += `\n\n<followups>\nI'm done!\nTeach me something else\n</followups>`;
  }

  broadcast(chatMsg(chatContent));

  // IDE actions
  const editor = getActiveFileEditor();
  if (editor && step.highlight.length > 0) {
    showTeachPopups(step.highlight, step.explanation, editor);
  }

  // Practice step: create a scratch file
  if (step.practice && activeFlow) {
    const ext = activeFlow.lang.includes("typescript") ? ".ts"
      : activeFlow.lang === "python" ? ".py"
      : ".js";

    const content = `// Practice: ${activeFlow.topic} — Step ${stepIdx + 1}\n// ${step.explanation}\n//\n// Write your code below:\n\n`;

    const doc = await vscode.workspace.openTextDocument({
      content,
      language: activeFlow.lang.includes("react")
        ? "typescriptreact"
        : activeFlow.lang,
    });
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
  }
}

// ---- Helpers ----

async function askTopic(): Promise<string | undefined> {
  return vscode.window.showInputBox({
    prompt: "What topic should Protege teach you?",
    placeHolder: "e.g., React hooks, async/await, CSS grid...",
  });
}

function chatMsg(content: string): { type: "chat/append"; message: ChatMessage } {
  return {
    type: "chat/append",
    message: {
      id: crypto.randomUUID(),
      role: "assistant",
      content,
      createdAt: new Date().toISOString(),
    },
  };
}
