import * as vscode from "vscode";
import { openProtegePanel } from "./panel.js";

/**
 * Activity-bar launcher view.
 *
 * Until 2026-04-22 this was a near-blank placeholder that auto-opened
 * the real Protege tab. That worked but wasted the whole sidebar surface
 * whenever the main panel wasn't mounted (closed, in another group,
 * etc.) — users would see just a logo + button over a large empty area.
 *
 * Now the launcher doubles as a mini dashboard: Code IQ, streak, and
 * concept count rendered as a compact card. Stats flow from
 * extension.ts (analyzer-save and refreshIQ callsites) via the
 * `updateLauncherStats` helper exported below, which `postMessage`s
 * into the webview whenever numbers change.
 *
 * The launcher HTML is still inline — not part of the react bundle —
 * because it needs to be lightweight and always-available in the
 * sidebar. Styling is tuned to MATCH the main panel's look (same ink
 * background, same grid pitch/opacity, same electric-blue accent) so
 * opening the tab doesn't feel like switching apps.
 */

interface LauncherStats {
  codeIq: number;
  maxIq?: number;
  streakDays: number;
  totalConcepts: number;
}

/** Most recent stats seen by the host. Posted to the webview on mount
 *  and every subsequent update so numbers are fresh even if the view
 *  re-resolves (sidebar collapse/expand triggers a re-resolve). */
let lastStats: LauncherStats | null = null;
let currentView: vscode.WebviewView | null = null;

/**
 * Push new stats to the launcher (if mounted). Safe to call before the
 * view resolves — the values are cached and replayed on next mount.
 */
export function updateLauncherStats(stats: LauncherStats): void {
  lastStats = stats;
  currentView?.webview.postMessage({ type: "stats", ...stats });
}

export class LauncherProvider implements vscode.WebviewViewProvider {
  constructor(private readonly ctx: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView) {
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html();
    currentView = view;

    // Replay the last-known stats so numbers populate immediately on
    // mount. Without this the launcher would show "—" placeholders
    // until the next analyzer save / refreshIQ call.
    if (lastStats) {
      view.webview.postMessage({ type: "stats", ...lastStats });
    }

    view.webview.onDidReceiveMessage((msg: { type: string }) => {
      if (msg.type === "open") openProtegePanel(this.ctx);
    });

    // Legacy behavior: clicking the activity-bar icon auto-opened the
    // real panel as soon as the sidebar view became visible. Kept, so
    // regular workflow is unchanged — the launcher stats are only seen
    // when the user deliberately looks at the sidebar without the
    // main panel mounted (e.g. after closing the tab).
    const openIfVisible = () => {
      if (view.visible) openProtegePanel(this.ctx);
    };
    openIfVisible();
    view.onDidChangeVisibility(openIfVisible);

    view.onDidDispose(() => {
      if (currentView === view) currentView = null;
    });
  }

  private html() {
    const nonce = getNonce();
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
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    color: var(--text);
    background:
      linear-gradient(rgba(255, 255, 255, 0.035) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255, 255, 255, 0.035) 1px, transparent 1px),
      radial-gradient(ellipse 90% 55% at 50% 0%, rgba(74, 158, 255, 0.14), transparent 60%),
      var(--ink);
    background-size: 40px 40px, 40px 40px, auto, auto;
    padding: 14px 12px 14px;
    font-size: 12px;
    line-height: 1.5;
    min-height: 100%;
    overflow-x: hidden;
  }

  /* ==========================================================
     Hero — cinematic "welcome" plate. Mirrors CinematicPlate from
     the main panel: deep gradient, radial electric accent, glass
     border, rounded corners, soft lift shadow, grain texture.
     Makes the launcher feel like the same product as the tab
     instead of a bare placeholder.
     ========================================================== */
  .hero {
    position: relative;
    overflow: hidden;
    padding: 18px 16px 16px;
    border: 1px solid var(--glass-border);
    border-radius: 14px;
    background:
      radial-gradient(ellipse 140% 90% at 50% -10%, rgba(74, 158, 255, 0.3), transparent 62%),
      radial-gradient(ellipse 80% 60% at 100% 100%, rgba(26, 94, 216, 0.16), transparent 60%),
      linear-gradient(180deg, rgba(20, 17, 31, 0.92), rgba(7, 6, 13, 0.95));
    box-shadow:
      0 10px 30px rgba(0, 0, 0, 0.45),
      0 0 0 1px rgba(255, 255, 255, 0.03) inset;
    margin-bottom: 12px;
  }
  /* Soft noise grain overlay — gives the hero depth, matches the
     grain on CinematicPlate in the main panel. Inline SVG so no
     external asset dependency. */
  .hero::before {
    content: "";
    position: absolute;
    inset: 0;
    pointer-events: none;
    background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(%23n)' opacity='0.35'/></svg>");
    background-size: 120px 120px;
    opacity: 0.04;
    mix-blend-mode: overlay;
  }
  /* Accent constellation-dot in the top-right corner. Echoes the
     concept-map node aesthetic, very subtle. */
  .hero::after {
    content: "";
    position: absolute;
    top: 12px;
    right: 12px;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--electric);
    box-shadow: 0 0 14px rgba(74, 158, 255, 0.7);
  }

  .hero-top {
    display: flex;
    align-items: center;
    gap: 11px;
    margin-bottom: 14px;
    position: relative;
    z-index: 1;
  }
  .mark {
    width: 40px;
    height: 40px;
    border-radius: 11px;
    background: linear-gradient(135deg, var(--electric), var(--electric-deep));
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: Georgia, serif;
    font-style: italic;
    font-size: 19px;
    font-weight: 700;
    color: var(--glow);
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, 0.16) inset,
      0 8px 22px rgba(74, 158, 255, 0.42),
      0 0 26px rgba(74, 158, 255, 0.28);
    flex-shrink: 0;
    /* Breathing halo — implemented as an animated outer box-shadow
       instead of a ::after pseudo-element with z-index -1. The
       pseudo-element approach only works when its parent creates a
       stacking context; .mark has position relative but no z-index,
       so negative z-index would climb to the root stacking context
       and the halo would end up hidden behind the body bg. Box-shadow
       animation sidesteps the stacking-context problem entirely. */
    animation: mark-pulse 3.2s ease-in-out infinite;
  }
  @keyframes mark-pulse {
    0%, 100% {
      box-shadow:
        0 0 0 1px rgba(255, 255, 255, 0.16) inset,
        0 8px 22px rgba(74, 158, 255, 0.42),
        0 0 22px rgba(74, 158, 255, 0.22);
    }
    50% {
      box-shadow:
        0 0 0 1px rgba(255, 255, 255, 0.18) inset,
        0 8px 26px rgba(74, 158, 255, 0.55),
        0 0 38px rgba(74, 158, 255, 0.42);
    }
  }
  .hero-identity {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }
  .microcaps {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.18em;
    color: var(--text-faint);
  }
  .title {
    font-family: Georgia, serif;
    font-style: italic;
    font-size: 23px;
    font-weight: 600;
    color: var(--glow);
    letter-spacing: -0.012em;
    line-height: 1.1;
    margin: 0;
  }
  .desc {
    color: var(--text-dim);
    margin: 0 0 14px;
    font-size: 11.5px;
    line-height: 1.55;
    position: relative;
    z-index: 1;
  }
  .btn {
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
    box-shadow:
      0 4px 20px rgba(74, 158, 255, 0.32),
      0 1px 0 0 rgba(255, 255, 255, 0.15) inset;
    transition: transform 120ms ease, box-shadow 150ms ease, filter 150ms ease;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    position: relative;
    z-index: 1;
  }
  .btn:hover {
    transform: translateY(-1px);
    box-shadow:
      0 8px 28px rgba(74, 158, 255, 0.5),
      0 1px 0 0 rgba(255, 255, 255, 0.18) inset;
    filter: brightness(1.05);
  }
  .btn:active { transform: translateY(0); }
  .hint {
    color: var(--text-faint);
    margin: 10px 0 0;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.16em;
    text-align: center;
    position: relative;
    z-index: 1;
  }

  /* ---- Stats ---- */
  /* One hero card (IQ) + two equal minis (Streak + Concepts) in a 2-col
     grid underneath. Typography-first: big serif numbers, microcaps
     labels, no emoji — all icons are SVG strokes so they inherit color
     and never read as "graphic" among the typography. */
  .stats {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 4px;
  }
  .stat {
    padding: 14px 14px 13px;
    border-radius: 10px;
    border: 1px solid var(--glass-border);
    background: rgba(13, 11, 24, 0.82);
    transition: border-color 160ms ease, transform 160ms ease, background 160ms ease;
  }
  .stat:hover {
    border-color: rgba(255, 255, 255, 0.2);
    background: rgba(13, 11, 24, 0.95);
    transform: translateY(-1px);
  }
  .stat-label {
    display: flex;
    align-items: center;
    gap: 6px;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.18em;
    color: var(--text-faint);
    margin-bottom: 6px;
  }
  .stat-label svg {
    width: 11px;
    height: 11px;
    opacity: 0.9;
  }
  .stat-value {
    font-family: Georgia, serif;
    font-size: 26px;
    font-weight: 600;
    color: var(--glow);
    line-height: 1;
    letter-spacing: -0.01em;
    display: flex;
    align-items: baseline;
    gap: 4px;
  }
  .stat-value-unit {
    font-size: 13px;
    font-weight: 500;
    color: var(--text-dim);
    letter-spacing: 0;
    font-style: normal;
  }
  .stat-sub {
    margin-top: 6px;
    font-size: 10.5px;
    color: var(--text-dim);
    line-height: 1.4;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    letter-spacing: 0.02em;
  }

  /* Hero IQ card — slightly larger value + progress bar. */
  .stat-hero .stat-value { font-size: 32px; }
  .bar {
    position: relative;
    height: 3px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.06);
    overflow: hidden;
    margin-top: 10px;
  }
  .bar-fill {
    position: absolute;
    top: 0; left: 0; bottom: 0;
    border-radius: 999px;
    background: linear-gradient(90deg, var(--electric), var(--electric-soft));
    box-shadow: 0 0 8px rgba(74, 158, 255, 0.35);
    transition: width 320ms cubic-bezier(0.2, 0.9, 0.3, 1);
  }

  /* Streak + Concepts sit in a 2-col grid. */
  .stats-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .stats-row .stat { padding: 12px 12px 11px; }
  .stats-row .stat-value { font-size: 22px; }
  .stats-row .stat-label { margin-bottom: 5px; }

  /* Streak flame icon — inherits color. Active state uses a warm hue
     as an accent (typographic amber, not an emoji). */
  .stat-streak .stat-label svg { color: #ffb07a; }
  .stat-streak-active .stat-value { color: var(--glow); }
  .stat-streak:not(.stat-streak-active) .stat-label svg { color: var(--text-faint); }

  .ghost-num {
    color: var(--text-faint);
    opacity: 0.55;
    font-size: 0.75em;
    font-weight: 500;
  }
</style>
</head>
<body>
  <section class="hero" aria-label="Protege">
    <div class="hero-top">
      <div class="mark">P</div>
      <div class="hero-identity">
        <span class="microcaps">AI Mentor</span>
        <h1 class="title">Protege</h1>
      </div>
    </div>
    <p class="desc">Your personal AI coding mentor. Opens as a tab on the right.</p>
    <button class="btn" id="open">
      <span>Open Protege</span>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
        <line x1="5" y1="12" x2="19" y2="12" />
        <polyline points="12 5 19 12 12 19" />
      </svg>
    </button>
    <div class="hint">Auto-opens on click</div>
  </section>

  <section class="stats" aria-label="Your stats">
    <div class="stat stat-hero">
      <div class="stat-label">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 17l5-5 4 4 8-8" />
          <path d="M15 8h5v5" />
        </svg>
        <span>Code IQ</span>
      </div>
      <div class="stat-value" id="iq-value"><span class="ghost-num">—</span></div>
      <div class="stat-sub" id="iq-sub">Save a file to start tracking.</div>
      <div class="bar"><div class="bar-fill" id="iq-bar" style="width: 0%"></div></div>
    </div>

    <div class="stats-row">
      <div class="stat stat-streak" id="streak-card">
        <div class="stat-label">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5Z" />
          </svg>
          <span>Streak</span>
        </div>
        <div class="stat-value" id="streak-value">
          <span class="ghost-num">—</span>
        </div>
      </div>

      <div class="stat stat-concepts">
        <div class="stat-label">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 6h16M4 12h10M4 18h7" />
          </svg>
          <span>Concepts</span>
        </div>
        <div class="stat-value" id="concepts-value">
          <span class="ghost-num">—</span>
        </div>
      </div>
    </div>
  </section>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('open').addEventListener('click', () => {
      vscode.postMessage({ type: 'open' });
    });

    const iqVal = document.getElementById('iq-value');
    const iqSub = document.getElementById('iq-sub');
    const iqBar = document.getElementById('iq-bar');
    const streakVal = document.getElementById('streak-value');
    const streakCard = document.getElementById('streak-card');
    const conceptsVal = document.getElementById('concepts-value');

    const fmt = (n) => Number.isFinite(n) ? n.toLocaleString() : '—';

    window.addEventListener('message', (e) => {
      const m = e.data;
      if (!m || m.type !== 'stats') return;

      // Code IQ — big number + "of X" unit + progress bar.
      if (Number.isFinite(m.codeIq)) {
        iqVal.textContent = fmt(m.codeIq);
        if (Number.isFinite(m.maxIq) && m.maxIq > 0) {
          const pct = Math.max(0, Math.min(100, (m.codeIq / m.maxIq) * 100));
          iqBar.style.width = pct.toFixed(1) + '%';
          iqSub.textContent = Math.round(pct) + '% · of ' + fmt(m.maxIq);
        } else {
          iqBar.style.width = '0%';
          iqSub.textContent = 'Save a file to start tracking.';
        }
      }

      // Streak — value + "days" unit. Flame icon in the label is SVG
      // (not emoji). Warm accent color when the streak is active.
      if (Number.isFinite(m.streakDays)) {
        if (m.streakDays > 0) {
          streakVal.innerHTML = m.streakDays +
            '<span class="stat-value-unit">' +
            (m.streakDays === 1 ? 'day' : 'days') +
            '</span>';
          streakCard.classList.add('stat-streak-active');
        } else {
          streakVal.innerHTML = '<span class="ghost-num">none</span>';
          streakCard.classList.remove('stat-streak-active');
        }
      }

      // Concepts — simple count, muted when zero.
      if (Number.isFinite(m.totalConcepts)) {
        if (m.totalConcepts > 0) {
          conceptsVal.textContent = fmt(m.totalConcepts);
        } else {
          conceptsVal.innerHTML = '<span class="ghost-num">none</span>';
        }
      }
    });
  </script>
</body>
</html>`;
  }
}

function getNonce() {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++)
    out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
