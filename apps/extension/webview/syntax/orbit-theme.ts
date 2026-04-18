import type { ThemeRegistration } from "shiki";

/**
 * Protege Orbit — hand-authored Shiki theme.
 *
 * Built against the brand color rgb(74, 158, 255) (electric blue).
 * Background is transparent — our chat bubble provides the deep-space
 * navy gradient. Function calls wear the brand color; warm secondaries
 * (amber strings, rose keywords) balance the cool base.
 *
 * Discipline: only keywords + comments italicize; only function calls
 * carry bold weight; lime for JSX attrs is the one permitted surprise.
 */
export const orbitTheme: ThemeRegistration = {
  name: "protege-orbit",
  type: "dark",
  colors: {
    "editor.background": "#00000000",
    "editor.foreground": "#cbd5ea",
  },
  tokenColors: [
    {
      scope: ["comment", "punctuation.definition.comment"],
      settings: { foreground: "#475775", fontStyle: "italic" },
    },
    {
      scope: [
        "string",
        "string.quoted",
        "string.quoted.double",
        "string.quoted.single",
        "string.template",
        "punctuation.definition.string",
      ],
      settings: { foreground: "#e9c48f" },
    },
    {
      scope: [
        "constant.numeric",
        "constant.character.numeric",
      ],
      settings: { foreground: "#ffa96c" },
    },
    {
      scope: [
        "keyword",
        "keyword.control",
        "keyword.control.import",
        "keyword.control.from",
        "keyword.control.flow",
        "keyword.control.conditional",
        "keyword.control.loop",
        "storage",
        "storage.type",
        "storage.modifier",
      ],
      settings: { foreground: "#ff7b9c", fontStyle: "italic" },
    },
    {
      scope: [
        "keyword.operator",
        "keyword.operator.arithmetic",
        "keyword.operator.comparison",
        "keyword.operator.logical",
        "keyword.operator.assignment",
        "keyword.operator.relational",
        "keyword.operator.arrow",
        "punctuation.accessor",
      ],
      settings: { foreground: "#8ddcff" },
    },
    {
      scope: [
        "entity.name.function",
        "support.function",
        "meta.function-call entity.name.function",
        "variable.function",
      ],
      settings: { foreground: "#4a9eff", fontStyle: "bold" },
    },
    {
      scope: [
        "entity.name.class",
        "entity.name.type",
        "entity.name.type.class",
        "entity.name.type.interface",
        "entity.name.type.enum",
        "support.class",
        "support.type",
        "support.type.primitive",
      ],
      settings: { foreground: "#ffcb8b" },
    },
    {
      scope: [
        "constant.language",
        "constant.language.boolean",
        "constant.language.null",
        "constant.language.undefined",
        "variable.language",
        "variable.language.this",
        "variable.language.super",
        "support.constant",
        "support.variable",
      ],
      settings: { foreground: "#82b7ff" },
    },
    {
      scope: [
        "variable.other.property",
        "variable.other.object.property",
        "meta.property-name",
        "support.type.property-name",
      ],
      settings: { foreground: "#9be6cd" },
    },
    {
      scope: [
        "entity.name.tag",
        "entity.name.tag.html",
        "entity.name.tag.xml",
        "entity.name.tag.jsx",
        "punctuation.definition.tag",
      ],
      settings: { foreground: "#7dd3fc" },
    },
    {
      scope: [
        "entity.other.attribute-name",
        "entity.other.attribute-name.html",
        "entity.other.attribute-name.jsx",
      ],
      settings: { foreground: "#b0e67c" },
    },
    {
      scope: [
        "string.regexp",
        "constant.character.escape",
        "constant.other.escape",
      ],
      settings: { foreground: "#82b7ff" },
    },
    {
      scope: ["support.constant.property-value.css"],
      settings: { foreground: "#ff7b9c" },
    },
    {
      scope: ["variable", "variable.other", "variable.parameter"],
      settings: { foreground: "#cbd5ea" },
    },
    {
      scope: ["punctuation", "meta.brace", "meta.delimiter"],
      settings: { foreground: "#8ea6c4" },
    },
  ],
};
