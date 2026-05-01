import * as vscode from "vscode";
import { openProtegePanel } from "./panel.js";
import { getGitHubUser, getCachedGitHubUser } from "./user/auth.js";
import { getAuthSnapshot, type AuthSnapshot } from "./user/authState.js";

/**
 * Activity-bar launcher view.
 *
 * Until 2026-04-22 this was a near-blank placeholder that auto-opened
 * the real Protege tab. That worked but wasted the whole sidebar surface
 * whenever the main panel wasn't mounted (closed, in another group,
 * etc.) — users would see just a logo + button over a large empty area.
 *
 * Now the launcher doubles as a mini dashboard: progress, streak, and
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
let lastAuth: AuthSnapshot | null = null;
let currentView: vscode.WebviewView | null = null;
let currentCtx: vscode.ExtensionContext | null = null;

/**
 * Push new stats to the launcher (if mounted). Safe to call before the
 * view resolves — the values are cached and replayed on next mount.
 */
export function updateLauncherStats(stats: LauncherStats): void {
  lastStats = stats;
  currentView?.webview.postMessage({ type: "stats", ...stats });
}

/**
 * Push auth state to the launcher so the sidebar swaps between the
 * normal stats card and a "sign in to continue" CTA. Without this the
 * launcher would silently show "Save a file to start tracking" even
 * after the user denies the GitHub OAuth dialog — leaving them with no
 * obvious way back in. Cached + replayed on resolve, same as stats.
 *
 * Auto-opening the main panel is also gated on signed-in here: when the
 * user is signed-out we stop the launcher → panel auto-bounce so the
 * sign-in CTA is the only entry point until they accept.
 */
export function updateLauncherAuth(snap: AuthSnapshot): void {
  const wasSignedIn = lastAuth?.user != null;
  lastAuth = snap;
  currentView?.webview.postMessage({
    type: "auth",
    state: snap.state,
    signedIn: snap.user !== null,
  });
  // Sign-in just succeeded while the launcher is visible — open the
  // main panel automatically so the user lands in the real UI without
  // having to click "Open Protege" a second time.
  if (
    !wasSignedIn &&
    snap.user !== null &&
    currentView?.visible &&
    currentCtx
  ) {
    openProtegePanel(currentCtx);
  }
}

export class LauncherProvider implements vscode.WebviewViewProvider {
  constructor(private readonly ctx: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView) {
    // Allow the webview to load the bundled logo.svg from `media/`.
    // Without this, asWebviewUri() generates a `vscode-webview-resource://`
    // URL that the webview would refuse to fetch under the strict CSP.
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.ctx.extensionUri, "media"),
      ],
    };
    const logoUri = view.webview.asWebviewUri(
      vscode.Uri.joinPath(this.ctx.extensionUri, "media", "logo.svg")
    );
    view.webview.html = this.html(view.webview, logoUri);
    currentView = view;
    currentCtx = this.ctx;

    // Replay the last-known stats so numbers populate immediately on
    // mount. Without this the launcher would show "—" placeholders
    // until the next analyzer save / refreshIQ call.
    if (lastStats) {
      view.webview.postMessage({ type: "stats", ...lastStats });
    }

    // Replay auth state so the sidebar starts in the right shape
    // (signed-in stats vs. signed-out CTA). Falls back to a fresh
    // snapshot if no listener has fed us yet.
    const authSnap = lastAuth ?? getAuthSnapshot();
    view.webview.postMessage({
      type: "auth",
      state: authSnap.state,
      signedIn: authSnap.user !== null,
    });

    view.webview.onDidReceiveMessage(async (msg: { type: string }) => {
      if (msg.type === "open") openProtegePanel(this.ctx);
      if (msg.type === "auth/login") {
        // Pop the GitHub OAuth dialog ONLY if we don't already have a
        // signed-in session. When the user is already signed in, calling
        // `getGitHubUser({ createIfNone: true })` makes VS Code surface a
        // "wants you to sign in again" modal — pure noise. The cached
        // user already triggered the auth listener once, so the launcher
        // UI is correctly in the signed-in shape; this branch is a no-op.
        if (!getCachedGitHubUser()) {
          await getGitHubUser(true);
        }
      }
    });

    // Auto-open the main panel only when the user is signed in. When
    // signed-out we keep the launcher's sign-in CTA as the sole entry
    // point — otherwise denying the OAuth dialog and re-focusing the
    // sidebar would loop the user through the main panel's auth gate
    // every time the view regains visibility.
    const openIfSignedIn = () => {
      if (!view.visible) return;
      if (lastAuth?.user) openProtegePanel(this.ctx);
    };
    openIfSignedIn();
    view.onDidChangeVisibility(openIfSignedIn);

    view.onDidDispose(() => {
      if (currentView === view) currentView = null;
      if (currentCtx === this.ctx) currentCtx = null;
    });
  }

  private html(webview: vscode.Webview, logoUri: vscode.Uri) {
    const nonce = getNonce();
    // CSP source for images. `${webview.cspSource}` is the magic origin
    // VS Code expects in the meta CSP whenever the webview loads images
    // via asWebviewUri(). Without this listed in `img-src`, the launcher
    // logo would 404 with a Content-Security-Policy console error.
    const imgSrc = `${webview.cspSource} data:`;
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${imgSrc};" />
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
  /* Brand mark — uses the real Protege logo from media/logo.svg.
     Previously this was an inline "Orbit" SVG (one ring + one dot)
     drawn programmatically. Replaced 2026-04-30 with the actual logo
     so the launcher matches the rest of the product surface.
     Background gradient + glow softened so they don't fight the
     full-color logo at this size. */
  .mark {
    width: 42px;
    height: 42px;
    border-radius: 12px;
    background: rgba(13, 11, 24, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--glow);
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, 0.08) inset,
      0 6px 18px rgba(74, 158, 255, 0.22),
      0 0 16px rgba(74, 158, 255, 0.12);
    flex-shrink: 0;
    animation: mark-pulse 3.2s ease-in-out infinite;
    transition: transform 320ms cubic-bezier(0.16, 1, 0.3, 1);
    overflow: hidden;
  }
  .mark:hover { transform: rotate(-12deg); }
  .mark img {
    width: 30px;
    height: 30px;
    object-fit: contain;
    display: block;
    /* Logo's native viewBox is taller than wide (401×542) — letterboxes
       cleanly inside the 42×42 plate without distortion thanks to
       object-fit: contain above. */
  }
  @keyframes mark-pulse {
    0%, 100% {
      box-shadow:
        0 0 0 1px rgba(255, 255, 255, 0.1) inset,
        0 8px 22px rgba(74, 158, 255, 0.32),
        0 0 18px rgba(74, 158, 255, 0.18);
    }
    50% {
      box-shadow:
        0 0 0 1px rgba(255, 255, 255, 0.16) inset,
        0 8px 26px rgba(74, 158, 255, 0.45),
        0 0 32px rgba(74, 158, 255, 0.32);
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

  /* ---- Stats ----
     Two equal cards (Streak + Concepts) in a 2-col grid. The old
     "Progress" hero card was Code-IQ–derived and Code IQ has been
     retired across the app, so it's gone here too — these two stats
     are the only real, non-aggregated numbers we surface. */
  .stats { margin-top: 4px; }
  .stat {
    padding: 12px 12px 11px;
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
    margin-bottom: 5px;
  }
  .stat-label svg { width: 11px; height: 11px; opacity: 0.9; }
  .stat-value {
    font-family: Georgia, serif;
    font-size: 22px;
    font-weight: 600;
    color: var(--glow);
    line-height: 1;
    letter-spacing: -0.01em;
    display: flex;
    align-items: baseline;
    gap: 4px;
  }
  .stat-value-unit {
    font-size: 11.5px;
    font-weight: 500;
    color: var(--text-dim);
    letter-spacing: 0;
    font-style: normal;
  }

  .stats-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }

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

  /* ---- Auth states ----
     The body's data-auth attribute switches the hero between two
     surfaces: the default "Open Protege" entry point (signed-in or
     pre-probe) and a sign-in CTA (signed-out). Stats are hidden when
     signed-out — "Save a file to start tracking" is misleading when
     the user can't track anything yet. */
  body:not([data-auth="signed-out"]) .signin-only { display: none; }
  body[data-auth="signed-out"] .signedin-only { display: none; }
  body[data-auth="signed-out"] .stats { display: none; }

  /* GitHub mark inside the sign-in button matches the in-panel gate
     (App.tsx auth-gate), so both surfaces feel like the same flow. */
  .btn-signin svg { flex-shrink: 0; }
</style>
</head>
<body>
  <section class="hero" aria-label="Protege">
    <div class="hero-top">
      <div class="mark" aria-hidden="true">
        <img src="${logoUri}" alt="" />
      </div>
      <div class="hero-identity">
        <span class="microcaps">Mentor</span>
        <h1 class="title">Protege</h1>
      </div>
    </div>
    <p class="desc signedin-only">Your personal AI coding mentor. Opens as a tab on the right.</p>
    <p class="desc signin-only">Sign in with GitHub to continue. Protege ties your concepts, Echo activity, and learning history to your account — that's the only thing we use it for.</p>
    <button class="btn signedin-only" id="open">
      <span>Open Protege</span>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
        <line x1="5" y1="12" x2="19" y2="12" />
        <polyline points="12 5 19 12 12 19" />
      </svg>
    </button>
    <button class="btn btn-signin signin-only" id="signin">
      <svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13">
        <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
      </svg>
      <span>Sign in with GitHub</span>
    </button>
    <div class="hint signedin-only">Auto-opens on click</div>
    <div class="hint signin-only">GitHub required to use Protege</div>
  </section>

  <section class="stats" aria-label="Your stats">
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
    const signinBtn = document.getElementById('signin');
    signinBtn.addEventListener('click', () => {
      // Disable while the OAuth dialog is open to prevent double-fires
      // (clicking again before the modal resolves throws an extra
      // getSession call). Re-enabled when the auth message arrives.
      signinBtn.disabled = true;
      signinBtn.style.opacity = '0.7';
      vscode.postMessage({ type: 'auth/login' });
    });

    const streakVal = document.getElementById('streak-value');
    const streakCard = document.getElementById('streak-card');
    const conceptsVal = document.getElementById('concepts-value');

    const fmt = (n) => Number.isFinite(n) ? n.toLocaleString() : '—';

    window.addEventListener('message', (e) => {
      const m = e.data;
      if (!m) return;

      if (m.type === 'auth') {
        // signed-in (or unknown / signing-in pre-resolution) → default
        // entry point with stats. signed-out → sign-in CTA, stats hidden.
        document.body.setAttribute(
          'data-auth',
          m.signedIn ? 'signed-in' : (m.state === 'signed-out' ? 'signed-out' : 'signed-in')
        );
        signinBtn.disabled = false;
        signinBtn.style.opacity = '';
        return;
      }

      if (m.type !== 'stats') return;

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
