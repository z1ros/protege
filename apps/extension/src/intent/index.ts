/**
 * Intent-classification subsystem — plans/task-shaping.md Phase 1.
 *
 * Call `shapeTask(message, buildShapeContext(...))` before every chat
 * turn to decide shape / complexity / mode / whether to offer a fork.
 * Regex tier first, LLM tier (Haiku via /classify) when ambiguous.
 */

export { shapeTask } from "./classifier.js";
export { buildShapeContext } from "./signals.js";
export { classifyWithRegex } from "./regexTier.js";
export { classifyWithLlm } from "./llmTier.js";
export { verifyUnderstanding } from "./verifier.js";
