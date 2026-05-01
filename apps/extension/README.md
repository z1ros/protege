<p align="center">
  <img src="https://github.com/z1ros/yurii.dev-portfolio/blob/main/Frame%2012.jpg?raw=true" alt="Protege" width="100%" />
</p>

# Protege — your personal AI coding mentor

> Get a little sharper every commit. Protege learns your blind spots and grows with you — from your first `<h1>` to your first system design review.

A mentor that lives inside your IDE. Watches every keystroke, catches every mistake, teaches every level.

Works inside **VS Code** and **Cursor**.

---

## One mentor · many hands

**Watches everything. Teaches every level.** So your hands stay on the keyboard.

### Acts in real time

Watches every keystroke silently. The feedback is already waiting the moment you slip — zero context switching.

### Identifies bugs and errors

Spots null derefs, race conditions, and injection risks before you hit save. Always explains the *why*, never just the *what*.

### Proactive

Quietly surfaces cleaner patterns, the built-in you reinvented, and the tech that actually fits your use case.

### Acts like a companion

Adapts to your level, remembers your blind spots, learns what you've already mastered. The longer you use it, the better it knows you.

### Never stops teaching

From your first line of HTML to senior architecture reviews. Pulls weak-spot drills out of your own code so you never plateau.

---

## Why this matters

The faster you build, the more it costs to fix. Most beginners ship code they don't fully understand — and the technical debt compounds.

| Stat | Source |
|---|---|
| **70%** more bugs in human-written code | CodeRabbit · 2025 |
| **59%** of developers ship code they don't understand | Clutch · 2025 |
| **41%** increase in technical debt across teams | CMU · 2026 |
| **4×** higher maintenance costs by year two | Codebridge · 2026 |

The learning layer doesn't exist yet. Protege is it.

---

## How it works

| Surface | What you see |
|---|---|
| **Live Review** | Pause while you type → faint underline + hover with senior-engineer feedback. On-device by default (Qwen 7B local). |
| **Smart Fix** | One-click bug repairs offered next to detected defects. |
| **Teach Me** | Ask in chat, get a 1:1 explanation that builds on what you already know — not a wall of text. |
| **Predict & Reveal** (`Cmd+K P`) | Guess what the highlighted code does, then check. The friction *is* the lesson. |
| **Learning Mode** (`Cmd+K L`) | Pick a goal; Protege builds a 3–5 step plan and you write each step yourself. Validator checks your work. |
| **AI Block Highlighter** | Auto-inserted regions get a subtle blue wash + "Teach me this block" hover so you don't ship code you don't understand. |
| **Misconception Catcher** | Scans for specific wrong mental models (await in `.map`, `JSON.parse+stringify` cloning, `.sort` mutation) and flags them. |
| **Notes** | Notion-style scratchpad inside the panel. Paste code, take lesson notes, build a personal reference. |
| **Voice Mode** | Local TTS reads explanations while your eyes stay on the code. Optional wake word so you can ask without hands. |

---

## Installation

Search **Protege** in VS Code Extensions (Cmd+Shift+X) or:

```bash
code --install-extension protege-ai.protege
```

## First-run setup

1. Click the Protege icon in the Activity Bar.
2. Sign in with GitHub — used for identity only, no repo access.
3. The on-device model (Qwen 7B, ~4.7 GB) auto-downloads on first Live Tab visit. One-time setup; everything's offline-capable after.
4. Open any file → start typing → Protege does the rest.

---

## Privacy

- **Stays local**: ownership tracking, Live Review on-device scans, voice synthesis (TTS).
- **Sent to backend**: chat messages and the file content you explicitly ask about.
- **Never sent**: your typed code (until you ask), file system contents, terminal output.

---

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Cmd+Shift+L` | Toggle Protege panel |
| `Cmd+K S` | Show actions for the current selection |
| `Cmd+K P` | Predict-and-reveal — guess what code does, then check |
| `Cmd+K L` | Start a Learning Mode session |
| `Tab` | Apply a Ghost suggestion |
| `Esc` | Dismiss the active suggestion |

## Daily limits

Protege caps cloud usage per UTC day:

- **100** chat messages
- **25** tool calls
- **25** voice minutes

Resets at 00:00 UTC. The Profile page shows your live usage.

---

## Where knowledge begins

A coding mentor that lives in your editor. Watches every keystroke, catches every mistake, teaches every level.

A mentor that never disappears.

---

**© 2026 Protege Labs, Inc.** · Building · Early access · [Privacy](https://github.com/z1ros/yurii.dev-portfolio) · [Terms](https://github.com/z1ros/yurii.dev-portfolio)

License: MIT
