import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles/index.css";
// One Dark syntax-highlighting theme — Prism paints spans with
// `.token.keyword`, `.token.string`, etc.; this stylesheet defines
// the colors. Picked to match the Atom / One Dark Pro palette most
// users see in their own editor (tags in red, keywords in purple,
// strings in green), so code in chat reads the way they're used to.
// Imported AFTER index.css so component-specific overrides in
// chat.css (background suppression inside .md-code-wrap) still win.
import "prism-themes/themes/prism-one-dark.css";

const root = document.getElementById("root")!;
createRoot(root).render(<App />);
