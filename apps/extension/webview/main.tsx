import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles/index.css";
// Shiki bootstraps on app mount — no theme CSS needed. Shiki paints
// inline styles directly on token spans using VS Code's own TextMate
// grammars + One Dark Pro theme JSON. Kick off the load in the
// background so by the time the first code block renders, the
// highlighter singleton is ready and painting happens synchronously.
import { ensureShiki } from "./syntax/shikiHighlighter.js";
void ensureShiki();

const root = document.getElementById("root")!;
createRoot(root).render(<App />);
