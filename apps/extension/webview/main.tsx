import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles/index.css";
// Night Owl syntax-highlighting theme — highlight.js paints CSS classes
// like `.hljs-keyword`, `.hljs-string`, etc.; this stylesheet defines
// the colors. Imported AFTER index.css so component-specific overrides
// in chat.css (background suppression on .md-code-wrap .hljs) still win.
import "highlight.js/styles/night-owl.css";

const root = document.getElementById("root")!;
createRoot(root).render(<App />);
