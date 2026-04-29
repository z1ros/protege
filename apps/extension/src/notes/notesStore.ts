import * as vscode from "vscode";
import type { Note } from "@protege/types";

const STORAGE_KEY = "protege.notes";
const MAX_NOTES = 500;

let ctx: vscode.ExtensionContext | null = null;

export function initNotesStore(context: vscode.ExtensionContext): void {
  ctx = context;
}

export function listNotes(): Note[] {
  if (!ctx) return [];
  const all = ctx.globalState.get<Note[]>(STORAGE_KEY) ?? [];
  return [...all].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function createNote(title?: string): Note {
  const now = new Date().toISOString();
  const note: Note = {
    id: `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    title: title?.trim() || "Untitled",
    body: "",
    createdAt: now,
    updatedAt: now,
  };
  if (ctx) {
    const all = ctx.globalState.get<Note[]>(STORAGE_KEY) ?? [];
    const next = [note, ...all].slice(0, MAX_NOTES);
    void ctx.globalState.update(STORAGE_KEY, next);
  }
  return note;
}

export function updateNote(
  id: string,
  patch: { title?: string; body?: string }
): Note | null {
  if (!ctx) return null;
  const all = ctx.globalState.get<Note[]>(STORAGE_KEY) ?? [];
  const idx = all.findIndex((n) => n.id === id);
  if (idx === -1) return null;
  const updated: Note = {
    ...all[idx],
    title: patch.title !== undefined ? patch.title : all[idx].title,
    body: patch.body !== undefined ? patch.body : all[idx].body,
    updatedAt: new Date().toISOString(),
  };
  const next = [...all];
  next[idx] = updated;
  void ctx.globalState.update(STORAGE_KEY, next);
  return updated;
}

export function deleteNote(id: string): void {
  if (!ctx) return;
  const all = ctx.globalState.get<Note[]>(STORAGE_KEY) ?? [];
  void ctx.globalState.update(
    STORAGE_KEY,
    all.filter((n) => n.id !== id)
  );
}
