import * as vscode from "vscode";
import type { WalkStep } from "@protege/types";

/**
 * Sticky sidebar view for File Walk.
 *
 * Shows the current step's title + body + concept buttons in a fixed
 * vertical strip that doesn't scroll with the editor — solves the
 * "comment thread keeps moving when I click Next" problem from prior
 * iterations. The user can dock the sidebar wherever they like
 * (drag it to the auxiliary right sidebar, or stack it under the
 * Protege chat panel).
 *
 * State flow:
 *   - fileWalk.ts owns the session. On every transition (start,
 *     next/prev, exit) it calls `pushWalkState(snapshot | null)`.
 *   - The view renders the snapshot and emits actions back via the
 *     handler set with `setWalkActionHandler`.
 */

export interface WalkSidebarStep {
  index: number;
  title: string;
  lineStart: number;
  lineEnd: number;
}

export interface WalkSidebarState {
  filePath: string;          // basename, for the header
  index: number;
  steps: WalkSidebarStep[];
  current: WalkStep;          // full step body for the active index
  cached: boolean;
}

export type WalkSidebarAction =
  | { type: "next" }
  | { type: "prev" }
  | { type: "exit" }
  | { type: "start" }
  | { type: "jumpTo"; index: number }
  | { type: "teachConcept"; concept: string };

let lastState: WalkSidebarState | null = null;
let currentView: vscode.WebviewView | null = null;
let actionHandler: ((a: WalkSidebarAction) => void) | null = null;

export function setWalkActionHandler(
  handler: (a: WalkSidebarAction) => void
): void {
  actionHandler = handler;
}

/** Push a fresh state snapshot to the sidebar, or `null` for the
 *  empty (no-walk-active) state. Auto-reveals the view when a walk
 *  starts so the user doesn't have to hunt for it. */
export function pushWalkState(state: WalkSidebarState | null): void {
  lastState = state;
  if (currentView) {
    currentView.webview.postMessage({ type: "walk/state", state });
    if (state) {
      // preserveFocus: don't yank focus out of the editor.
      try {
        currentView.show(true);
      } catch {
        /* view may not yet be visible-able; harmless */
      }
    }
  } else if (state) {
    // View hasn't been resolved yet — nudge the activity bar so the
    // sidebar opens the protege container, which resolves our view.
    void vscode.commands.executeCommand("protege.fileWalk.focus");
  }
}

export class WalkViewProvider implements vscode.WebviewViewProvider {
  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html();
    currentView = view;

    // Replay last state on (re)mount so the view is always coherent
    // even when the user collapsed/re-expanded the sidebar.
    view.webview.postMessage({ type: "walk/state", state: lastState });

    view.webview.onDidReceiveMessage((msg: WalkSidebarAction) => {
      if (!actionHandler) return;
      actionHandler(msg);
    });

    view.onDidDispose(() => {
      if (currentView === view) currentView = null;
    });
  }

  private html(): string {
    const nonce = makeNonce();
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data:;" />
<style>
  :root {
    --ink: #07060d;
    --ink-2: #0d0b18;
    --ink-3: #14111f;
    --glow: #ffffff;
    --text: #f5f6fa;
    --text-dim: rgba(245, 246, 250, 0.62);
    --text-faint: rgba(245, 246, 250, 0.32);
    --text-ghost: rgba(245, 246, 250, 0.16);
    --electric: #4a9eff;
    --electric-soft: #c8d4ea;
    --electric-deep: #1a5ed8;
    --glass-border: rgba(255, 255, 255, 0.1);
    --glass-border-strong: rgba(255, 255, 255, 0.22);
    --warn: #ffb07a;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    color: var(--text);
    background: var(--ink);
    padding: 12px 12px 18px;
    font-size: 12px;
    line-height: 1.5;
    min-height: 100%;
    overflow-x: hidden;
  }

  /* ===== Header ===== */
  .header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 4px 12px;
    border-bottom: 1px solid var(--glass-border);
    margin-bottom: 12px;
  }
  .header-icon {
    width: 22px; height: 22px;
    display: flex; align-items: center; justify-content: center;
    color: var(--electric);
  }
  .header-text {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.18em;
    color: var(--text-faint);
  }
  .header-spacer { flex: 1; }
  .icon-btn {
    background: transparent;
    border: 1px solid var(--glass-border);
    border-radius: 6px;
    color: var(--text-dim);
    width: 26px; height: 26px;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer;
    transition: color 120ms, border-color 120ms, background 120ms;
    font-family: inherit;
    padding: 0;
  }
  .icon-btn:hover {
    color: var(--glow);
    border-color: var(--glass-border-strong);
    background: var(--ink-3);
  }

  /* ===== Empty state ===== */
  .empty {
    text-align: center;
    padding: 22px 16px 14px;
    border: 1px solid var(--glass-border);
    border-radius: 12px;
    background: var(--ink-2);
  }
  .empty-icon {
    width: 42px; height: 42px;
    margin: 0 auto 14px;
    border-radius: 50%;
    background: linear-gradient(135deg, var(--electric), var(--electric-deep));
    display: flex; align-items: center; justify-content: center;
    color: var(--glow);
    box-shadow: 0 0 22px rgba(74, 158, 255, 0.32);
  }
  .empty-title {
    font-family: Georgia, serif;
    font-style: italic;
    font-size: 17px;
    font-weight: 600;
    color: var(--glow);
    margin: 0 0 6px;
  }
  .empty-desc {
    color: var(--text-dim);
    font-size: 11.5px;
    line-height: 1.55;
    margin: 0 0 16px;
  }
  .btn-primary {
    width: 100%;
    padding: 10px 14px;
    background: linear-gradient(135deg, var(--electric), var(--electric-deep));
    color: var(--glow);
    border: 1px solid rgba(74, 158, 255, 0.65);
    border-radius: 10px;
    cursor: pointer;
    font-weight: 500;
    font-size: 12px;
    letter-spacing: 0.04em;
    font-family: inherit;
    box-shadow: 0 4px 18px rgba(74, 158, 255, 0.28),
                0 1px 0 0 rgba(255, 255, 255, 0.15) inset;
    transition: transform 120ms, filter 150ms;
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  }
  .btn-primary:hover { transform: translateY(-1px); filter: brightness(1.06); }
  .btn-primary:active { transform: translateY(0); }

  /* ===== Active step ===== */
  .nav {
    display: grid;
    grid-template-columns: 36px 1fr 36px;
    align-items: center;
    gap: 8px;
    margin-bottom: 12px;
  }
  .nav-btn {
    background: var(--ink-2);
    border: 1px solid var(--glass-border);
    border-radius: 8px;
    color: var(--text);
    height: 34px;
    cursor: pointer;
    font-family: inherit;
    font-size: 14px;
    transition: border-color 120ms, color 120ms, background 120ms;
    padding: 0;
    display: flex; align-items: center; justify-content: center;
  }
  .nav-btn:hover {
    border-color: var(--glass-border-strong);
    color: var(--glow);
    background: var(--ink-3);
  }
  .nav-progress {
    text-align: center;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.16em;
    color: var(--text-dim);
  }
  .nav-progress strong {
    color: var(--glow);
    font-weight: 600;
  }

  .progress-bar {
    height: 3px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.06);
    overflow: hidden;
    margin-bottom: 14px;
  }
  .progress-fill {
    height: 100%;
    background: linear-gradient(90deg, var(--electric), var(--electric-soft));
    box-shadow: 0 0 8px rgba(74, 158, 255, 0.35);
    transition: width 320ms cubic-bezier(0.2, 0.9, 0.3, 1);
  }

  .step-card {
    border: 1px solid var(--glass-border);
    border-radius: 12px;
    background: var(--ink-2);
    padding: 14px 14px 16px;
    margin-bottom: 12px;
  }
  .step-title {
    font-family: Georgia, serif;
    font-size: 16px;
    font-weight: 600;
    color: var(--glow);
    line-height: 1.25;
    margin: 0 0 4px;
    letter-spacing: -0.005em;
  }
  .step-meta {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 9.5px;
    text-transform: uppercase;
    letter-spacing: 0.16em;
    color: var(--text-faint);
    margin-bottom: 10px;
  }
  .step-body {
    color: var(--text);
    font-size: 12.5px;
    line-height: 1.6;
    white-space: pre-wrap;
    overflow-wrap: break-word;
  }

  .concepts {
    margin-top: 12px;
  }
  .concepts-label {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.18em;
    color: var(--text-faint);
    margin-bottom: 8px;
  }
  .chip-row {
    display: flex; flex-wrap: wrap; gap: 6px;
  }
  .chip {
    background: rgba(74, 158, 255, 0.08);
    border: 1px solid rgba(74, 158, 255, 0.32);
    color: var(--electric-soft);
    padding: 5px 10px;
    border-radius: 999px;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 10.5px;
    cursor: pointer;
    transition: background 120ms, border-color 120ms, color 120ms;
  }
  .chip:hover {
    background: rgba(74, 158, 255, 0.18);
    border-color: var(--electric);
    color: var(--glow);
  }

  /* ===== All-steps list ===== */
  .all-steps {
    margin-top: 14px;
  }
  .all-steps-label {
    display: flex; align-items: center; justify-content: space-between;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.18em;
    color: var(--text-faint);
    margin: 12px 0 8px;
  }
  .step-list {
    display: flex; flex-direction: column;
    border: 1px solid var(--glass-border);
    border-radius: 10px;
    overflow: hidden;
    background: var(--ink-2);
  }
  .step-row {
    display: grid;
    grid-template-columns: 28px 1fr auto;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border-top: 1px solid var(--glass-border);
    cursor: pointer;
    transition: background 120ms;
    color: var(--text-dim);
    font-size: 11.5px;
    line-height: 1.35;
  }
  .step-row:first-child { border-top: none; }
  .step-row:hover { background: var(--ink-3); color: var(--text); }
  .step-row-num {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    color: var(--text-faint);
    text-align: right;
    font-size: 10.5px;
  }
  .step-row-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .step-row-lines {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 10px;
    color: var(--text-faint);
  }
  .step-row.active {
    background: rgba(74, 158, 255, 0.1);
    color: var(--glow);
  }
  .step-row.active .step-row-num { color: var(--electric); }
  .step-row.active .step-row-title { font-weight: 600; }

  .file-meta {
    display: flex; align-items: center; gap: 6px;
    margin-bottom: 10px;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 10.5px;
    color: var(--text-dim);
    overflow: hidden;
  }
  .file-meta-dot {
    width: 6px; height: 6px;
    border-radius: 50%;
    background: var(--electric);
    box-shadow: 0 0 6px rgba(74, 158, 255, 0.6);
    flex-shrink: 0;
  }
  .file-meta-name {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .file-meta-cached {
    margin-left: auto;
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.16em;
    color: var(--text-faint);
  }
</style>
</head>
<body>
  <div class="header">
    <div class="header-icon">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="6" r="2.2" />
        <path d="M9 22l1.5-9 4 3 3-2" />
        <path d="M5 14l5-3 4 3 5-2" />
      </svg>
    </div>
    <div class="header-text">File Walk</div>
    <div class="header-spacer"></div>
    <button class="icon-btn" id="exit-btn" title="Exit walk" style="display:none">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="6" y1="6" x2="18" y2="18" />
        <line x1="18" y1="6" x2="6" y2="18" />
      </svg>
    </button>
  </div>

  <div id="empty-state" class="empty" style="display:none">
    <div class="empty-icon">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="6" r="2.2" />
        <path d="M9 22l1.5-9 4 3 3-2" />
        <path d="M5 14l5-3 4 3 5-2" />
      </svg>
    </div>
    <h2 class="empty-title">No walk in progress</h2>
    <p class="empty-desc">Open a file and click below for a step-by-step mentor walkthrough.</p>
    <button class="btn-primary" id="start-btn">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
        <polygon points="6 4 20 12 6 20 6 4" fill="currentColor" />
      </svg>
      <span>Walk this file</span>
    </button>
  </div>

  <div id="active-state" style="display:none">
    <div class="file-meta">
      <span class="file-meta-dot"></span>
      <span class="file-meta-name" id="file-meta-name">file.ts</span>
      <span class="file-meta-cached" id="file-meta-cached"></span>
    </div>

    <div class="nav">
      <button class="nav-btn" id="prev-btn" title="Previous step">◀</button>
      <div class="nav-progress">
        Step <strong id="step-now">—</strong> / <span id="step-total">—</span>
      </div>
      <button class="nav-btn" id="next-btn" title="Next step">▶</button>
    </div>
    <div class="progress-bar">
      <div class="progress-fill" id="progress-fill" style="width: 0%"></div>
    </div>

    <div class="step-card">
      <h2 class="step-title" id="step-title">—</h2>
      <div class="step-meta" id="step-meta">—</div>
      <div class="step-body" id="step-body">—</div>

      <div class="concepts" id="concepts-section" style="display:none">
        <div class="concepts-label">Teach a concept</div>
        <div class="chip-row" id="chip-row"></div>
      </div>
    </div>

    <div class="all-steps">
      <div class="all-steps-label">
        <span>All steps</span>
        <span id="all-steps-count">—</span>
      </div>
      <div class="step-list" id="step-list"></div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    const empty = document.getElementById('empty-state');
    const active = document.getElementById('active-state');
    const exitBtn = document.getElementById('exit-btn');
    const startBtn = document.getElementById('start-btn');
    const prevBtn = document.getElementById('prev-btn');
    const nextBtn = document.getElementById('next-btn');

    const fileNameEl = document.getElementById('file-meta-name');
    const cachedEl = document.getElementById('file-meta-cached');
    const stepNowEl = document.getElementById('step-now');
    const stepTotalEl = document.getElementById('step-total');
    const progressFill = document.getElementById('progress-fill');
    const titleEl = document.getElementById('step-title');
    const metaEl = document.getElementById('step-meta');
    const bodyEl = document.getElementById('step-body');
    const conceptsSection = document.getElementById('concepts-section');
    const chipRow = document.getElementById('chip-row');
    const stepList = document.getElementById('step-list');
    const allStepsCount = document.getElementById('all-steps-count');

    function send(action) { vscode.postMessage(action); }

    startBtn.addEventListener('click', () => send({ type: 'start' }));
    exitBtn.addEventListener('click', () => send({ type: 'exit' }));
    prevBtn.addEventListener('click', () => send({ type: 'prev' }));
    nextBtn.addEventListener('click', () => send({ type: 'next' }));

    function render(state) {
      if (!state) {
        empty.style.display = '';
        active.style.display = 'none';
        exitBtn.style.display = 'none';
        return;
      }

      empty.style.display = 'none';
      active.style.display = '';
      exitBtn.style.display = '';

      fileNameEl.textContent = state.filePath;
      cachedEl.textContent = state.cached ? 'cached' : 'fresh';

      const total = state.steps.length;
      const current = state.current;
      stepNowEl.textContent = (state.index + 1).toString();
      stepTotalEl.textContent = total.toString();
      const pct = total > 0 ? ((state.index + 1) / total) * 100 : 0;
      progressFill.style.width = pct.toFixed(1) + '%';

      titleEl.textContent = current.title;
      metaEl.textContent = 'Lines ' + current.lineStart + '–' + current.lineEnd;
      bodyEl.textContent = current.body;

      // Concept chips
      chipRow.innerHTML = '';
      if (current.concepts && current.concepts.length > 0) {
        conceptsSection.style.display = '';
        for (const c of current.concepts) {
          const btn = document.createElement('button');
          btn.className = 'chip';
          btn.textContent = c;
          btn.addEventListener('click', () => send({ type: 'teachConcept', concept: c }));
          chipRow.appendChild(btn);
        }
      } else {
        conceptsSection.style.display = 'none';
      }

      // All-steps list
      stepList.innerHTML = '';
      allStepsCount.textContent = total.toString() + ' steps';
      state.steps.forEach((s) => {
        const row = document.createElement('div');
        row.className = 'step-row' + (s.index === state.index ? ' active' : '');
        row.addEventListener('click', () => send({ type: 'jumpTo', index: s.index }));

        const num = document.createElement('div');
        num.className = 'step-row-num';
        num.textContent = (s.index + 1).toString();

        const title = document.createElement('div');
        title.className = 'step-row-title';
        title.textContent = s.title;

        const lines = document.createElement('div');
        lines.className = 'step-row-lines';
        lines.textContent = s.lineStart === s.lineEnd
          ? 'L' + s.lineStart
          : 'L' + s.lineStart + '–' + s.lineEnd;

        row.appendChild(num);
        row.appendChild(title);
        row.appendChild(lines);
        stepList.appendChild(row);
      });
    }

    window.addEventListener('message', (e) => {
      const m = e.data;
      if (!m || m.type !== 'walk/state') return;
      render(m.state);
    });

    // Initial: nothing yet — host will replay state on resolve.
    render(null);
  </script>
</body>
</html>`;
  }
}

function makeNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
