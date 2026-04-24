import * as vscode from "vscode";

/**
 * Protege's hover template — minimalist single source of truth.
 *
 * Design rules:
 *   - One line header: logo · name · title  ·  [SEVERITY]
 *   - Body sentence, one paragraph
 *   - Optional before → after code blocks (no labels, just the ↓ arrow)
 *   - Action row with codicon command links
 *   - No banner, no footer, no metadata dashboard
 *
 * VS Code owns the popup frame; we just keep our content tight.
 */

export type HoverKind = "bug" | "perf" | "tip" | "warn" | "info" | "security" | "teach";

export interface HoverAction {
  icon?: string;
  label: string;
  command: string;
  args?: unknown;
  primary?: boolean;
}

export interface HoverOptions {
  kind: HoverKind;
  title: string;
  body: string;
  code?: {
    before?: string;
    after?: string;
    lang?: string;
  };
  actions?: HoverAction[];
}

const PALETTE: Record<HoverKind, { accent: string; label: string }> = {
  bug:      { accent: "#ff8fa8", label: "BUG" },
  perf:     { accent: "#ffd280", label: "PERF" },
  tip:      { accent: "#9eccff", label: "TIP" },
  warn:     { accent: "#ffb86b", label: "WARN" },
  info:     { accent: "#c8d4ea", label: "INFO" },
  security: { accent: "#ff8fa8", label: "SEC" },
  teach:    { accent: "#b863ff", label: "TEACH" },
};

// Tiny inline SVG logo — base64'd so it stays a single <img> data URI.
// 12x12 white orbit ring + dot. Matches the Protege brand.
const LOGO_B64 = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 32 32">` +
    `<circle cx="16" cy="16" r="10.5" fill="none" stroke="#d0d5e8" stroke-width="2.2"/>` +
    `<circle cx="23.42" cy="8.58" r="3" fill="#d0d5e8"/>` +
  `</svg>`,
  "utf8"
).toString("base64");
const LOGO_URI = `data:image/svg+xml;base64,${LOGO_B64}`;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function commandUri(action: HoverAction): string {
  if (action.args === undefined) return `command:${action.command}`;
  const encoded = encodeURIComponent(JSON.stringify(action.args));
  return `command:${action.command}?${encoded}`;
}

export function renderProtegeHover(opts: HoverOptions): vscode.MarkdownString {
  const md = new vscode.MarkdownString("", true);
  md.isTrusted = true;
  md.supportThemeIcons = true;
  md.supportHtml = true;

  const p = PALETTE[opts.kind];

  // ---- One-line header: [logo] Protege · Title     [CHIP] ----
  md.appendMarkdown(
    `<img src="${LOGO_URI}" width="12" height="12" align="center" /> ` +
    `<span style="color:rgba(245,246,250,0.5);font-weight:600;letter-spacing:0.5">Protege</span>` +
    `<span style="color:rgba(245,246,250,0.3)"> · </span>` +
    `<span style="color:#f5f6fa;font-weight:600">${escapeHtml(opts.title)}</span>` +
    `&nbsp;&nbsp;` +
    `<span style="color:${p.accent};font-size:10px;font-weight:700;letter-spacing:1.5;` +
    `background:${p.accent}22;padding:2px 6px;border-radius:6px">` +
    `${p.label}</span>\n\n`
  );

  // ---- Body ----
  md.appendMarkdown(`${opts.body.trim()}\n\n`);

  // ---- Before / After code ----
  if (opts.code && (opts.code.before || opts.code.after)) {
    const lang = opts.code.lang ?? "";
    if (opts.code.before && opts.code.after && opts.code.before !== opts.code.after) {
      md.appendCodeblock(opts.code.before, lang);
      md.appendMarkdown(
        `<span style="color:rgba(245,246,250,0.5);font-size:14px">↓</span>\n\n`
      );
      md.appendCodeblock(opts.code.after, lang);
    } else if (opts.code.after) {
      md.appendCodeblock(opts.code.after, lang);
    } else if (opts.code.before) {
      md.appendCodeblock(opts.code.before, lang);
    }
    md.appendMarkdown(`\n`);
  }

  // ---- Action row ----
  if (opts.actions && opts.actions.length > 0) {
    const parts = opts.actions.map((a) => {
      const icon = a.icon ? `$(${a.icon}) ` : "";
      const uri = commandUri(a);
      const label = a.primary ? `**${a.label}**` : a.label;
      return `[${icon}${label}](${uri})`;
    });
    md.appendMarkdown(`\n${parts.join("&nbsp;&nbsp;&nbsp;")}\n`);
  }

  return md;
}
