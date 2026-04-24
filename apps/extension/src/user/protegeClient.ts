import * as vscode from "vscode";
import type { AnalyzeResponse, Finding, MeResponse } from "@protege/types";
import { authHeaders } from "./auth.js";

const BACKEND_URL =
  process.env.PROTEGE_BACKEND_URL ?? "http://localhost:8787";

const USER_ID_KEY = "protege.userId";

/**
 * Returns a stable per-machine userId. Generated on first activation
 * and persisted in globalState. Used as a fallback identifier when the
 * user hasn't signed in with GitHub yet.
 */
export function getUserId(context: vscode.ExtensionContext): string {
  let id = context.globalState.get<string>(USER_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    context.globalState.update(USER_ID_KEY, id);
  }
  return id;
}

function headers(userId: string): Record<string, string> {
  return authHeaders(userId);
}

export async function analyzeFile(
  userId: string,
  file: { path: string; language: string; content: string }
): Promise<Finding[]> {
  const res = await fetch(`${BACKEND_URL}/analyze`, {
    method: "POST",
    headers: headers(userId),
    body: JSON.stringify({ userId, file }),
  });
  if (!res.ok) throw new Error(`analyze HTTP ${res.status}`);
  const data = (await res.json()) as AnalyzeResponse;
  return data.findings ?? [];
}

import type { GainEvent } from "@protege/types";

export interface RecordConceptsInput {
  filePath: string;
  fileHash: string;
  concepts: string[];
  contextScores?: Record<string, number>; // concept name → 1.0-3.0 context multiplier
  hasErrors: boolean;
  errorCount: number;
}

export interface RecordConceptsResult {
  skipped: boolean;
  codeIq: number;
  totalConcepts: number;
  gains: GainEvent[];
}

export async function recordConcepts(
  userId: string,
  input: RecordConceptsInput
): Promise<RecordConceptsResult> {
  const res = await fetch(`${BACKEND_URL}/concept-used`, {
    method: "POST",
    headers: headers(userId),
    body: JSON.stringify({ userId, ...input }),
  });
  if (!res.ok) throw new Error(`concept-used HTTP ${res.status}`);
  return (await res.json()) as RecordConceptsResult;
}

export async function fetchMe(userId: string): Promise<MeResponse> {
  const res = await fetch(`${BACKEND_URL}/me?userId=${encodeURIComponent(userId)}`, {
    headers: headers(userId),
  });
  if (!res.ok) throw new Error(`me HTTP ${res.status}`);
  return (await res.json()) as MeResponse;
}

/**
 * Read the user's cross-device preferences blob from Supabase (or `{}` if
 * the backend isn't configured / network fails). Shape is client-owned.
 */
export async function fetchPreferences(
  userId: string
): Promise<Record<string, unknown>> {
  try {
    const res = await fetch(
      `${BACKEND_URL}/preferences?userId=${encodeURIComponent(userId)}`,
      { headers: headers(userId) }
    );
    if (!res.ok) return {};
    const body = (await res.json()) as { preferences?: Record<string, unknown> };
    return body.preferences ?? {};
  } catch {
    return {};
  }
}

/**
 * Patch the user's preferences blob. Fire-and-forget — we don't block
 * the UI on cloud sync. Local persistence is the source of truth for the
 * current session; the cloud is the source of truth across devices.
 */
export async function patchPreferences(
  userId: string,
  patch: Record<string, unknown>
): Promise<boolean> {
  try {
    const res = await fetch(`${BACKEND_URL}/preferences?userId=${encodeURIComponent(userId)}`, {
      method: "PATCH",
      headers: { ...headers(userId), "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export { BACKEND_URL };
