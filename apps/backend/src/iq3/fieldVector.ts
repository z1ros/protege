import type { Iq3FieldId, Iq3FieldVector } from "@protege/types";
import { FIELD_IDS } from "@protege/types";

/** Lightweight signature of a workspace, computed extension-side. */
export interface RepoSignals {
  /** package.json `dependencies` + `devDependencies` keys */
  packageJsonDeps?: string[];
  /** Python requirements.txt or pyproject.toml dependencies */
  requirementsTxt?: string[];
  /** Cargo.toml deps */
  cargoToml?: string[];
  /** go.mod requires */
  goMod?: string[];
  /** count of files per extension */
  fileExtensions?: Record<string, number>;
  /** infra-shaped files in the workspace */
  infraFiles?: string[];
}

const DEP_HINTS: Array<{ field: Iq3FieldId; matches: RegExp[]; weight: number }> = [
  { field: "web", weight: 3, matches: [
    /^react$/i, /^next$/i, /^vue$/i, /^svelte$/i, /^tailwindcss$/i,
    /^@angular\//i, /^astro$/i, /^vite$/i, /^webpack$/i,
  ]},
  { field: "ml", weight: 3, matches: [
    /^torch$/i, /^pytorch$/i, /^tensorflow$/i, /^scikit-learn$/i, /^numpy$/i,
    /^pandas$/i, /^transformers$/i, /^datasets$/i,
  ]},
  { field: "dataEng", weight: 3, matches: [
    /^apache-airflow$/i, /^dbt-core$/i, /^pyspark$/i, /^kafka-python$/i,
    /^prefect$/i, /^dagster$/i,
  ]},
  { field: "devOps", weight: 2, matches: [
    /^terraform$/i, /^pulumi$/i, /^ansible$/i, /^kubernetes-client$/i,
  ]},
  { field: "sec", weight: 3, matches: [
    /^cryptography$/i, /^pwntools$/i, /^scapy$/i, /^pycryptodome$/i, /^impacket$/i,
  ]},
  { field: "mobile", weight: 3, matches: [
    /^react-native$/i, /^expo$/i, /^@ionic\//i, /^flutter$/i,
  ]},
  { field: "systems", weight: 2, matches: [/^libc$/i, /^tokio$/i] },
  { field: "game", weight: 3, matches: [/^pixi\.js$/i, /^phaser$/i, /^three$/i, /^pygame$/i] },
  { field: "embedded", weight: 3, matches: [/^mbed/i, /^arduino/i, /^esp-idf/i] },
];

const EXT_HINTS: Record<string, { field: Iq3FieldId; weight: number }[]> = {
  ".tsx":   [{ field: "web", weight: 2 }],
  ".jsx":   [{ field: "web", weight: 2 }],
  ".vue":   [{ field: "web", weight: 2 }],
  ".svelte":[{ field: "web", weight: 2 }],
  ".css":   [{ field: "web", weight: 1 }],
  ".py":    [{ field: "ml", weight: 1 }, { field: "dataEng", weight: 1 }, { field: "generalist", weight: 1 }],
  ".ipynb": [{ field: "ml", weight: 3 }],
  ".tf":    [{ field: "devOps", weight: 3 }],
  ".yaml":  [{ field: "devOps", weight: 1 }],
  ".yml":   [{ field: "devOps", weight: 1 }],
  ".dockerfile": [{ field: "devOps", weight: 2 }],
  ".swift": [{ field: "mobile", weight: 3 }],
  ".kt":    [{ field: "mobile", weight: 2 }],
  ".rs":    [{ field: "systems", weight: 2 }],
  ".c":     [{ field: "systems", weight: 2 }, { field: "embedded", weight: 1 }],
  ".cpp":   [{ field: "systems", weight: 1 }, { field: "game", weight: 1 }, { field: "embedded", weight: 1 }],
  ".h":     [{ field: "systems", weight: 1 }, { field: "embedded", weight: 1 }],
  ".ino":   [{ field: "embedded", weight: 4 }],
  ".sol":   [{ field: "sec", weight: 1 }],
  ".sh":    [{ field: "devOps", weight: 1 }],
};

const INFRA_HINTS: Array<{ pattern: RegExp; field: Iq3FieldId; weight: number }> = [
  { pattern: /^Dockerfile$/, field: "devOps", weight: 3 },
  { pattern: /docker-compose\.ya?ml$/, field: "devOps", weight: 2 },
  { pattern: /^k8s\//, field: "devOps", weight: 2 },
  { pattern: /\.(tf|tfvars)$/, field: "devOps", weight: 2 },
  { pattern: /^\.github\/workflows\//, field: "devOps", weight: 1 },
];

/** Compute P(field) from a single repo's signals using additive evidence + smoothing. */
export function detectFieldFromRepo(signals: RepoSignals): Iq3FieldVector {
  const raw = Object.fromEntries(FIELD_IDS.map((f) => [f, 1])) as Record<Iq3FieldId, number>; // Laplace +1

  const allDeps = [
    ...(signals.packageJsonDeps ?? []),
    ...(signals.requirementsTxt ?? []),
    ...(signals.cargoToml ?? []),
    ...(signals.goMod ?? []),
  ];
  for (const dep of allDeps) {
    for (const hint of DEP_HINTS) {
      if (hint.matches.some((rx) => rx.test(dep))) {
        raw[hint.field] += hint.weight;
      }
    }
  }

  if (signals.fileExtensions) {
    for (const [ext, count] of Object.entries(signals.fileExtensions)) {
      const hits = EXT_HINTS[ext.toLowerCase()];
      if (!hits) continue;
      for (const hit of hits) {
        raw[hit.field] += hit.weight * Math.log2(count + 1);
      }
    }
  }

  for (const file of signals.infraFiles ?? []) {
    for (const hint of INFRA_HINTS) {
      if (hint.pattern.test(file)) raw[hint.field] += hint.weight;
    }
  }

  raw.generalist += 2;

  const total = Object.values(raw).reduce((s, x) => s + x, 0);
  return Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [k, v / total]),
  ) as Iq3FieldVector;
}

/** Merge a fresh detection with the user's existing field vector via EMA. */
export function emaMergeField(
  prior: Iq3FieldVector,
  fresh: Iq3FieldVector,
  halfLifeDays = 30,
  daysSinceLastUpdate = 1,
): Iq3FieldVector {
  const alpha = 1 - Math.pow(0.5, daysSinceLastUpdate / halfLifeDays);
  const result = {} as Iq3FieldVector;
  for (const f of FIELD_IDS) {
    result[f] = (1 - alpha) * prior[f] + alpha * fresh[f];
  }
  const total = Object.values(result).reduce((s, x) => s + x, 0);
  for (const f of FIELD_IDS) result[f] /= total;
  return result;
}

/** Mix in a self-declared field at low weight. */
export function applySelfDeclaration(
  prior: Iq3FieldVector,
  declared: Iq3FieldId,
  weight = 0.2,
): Iq3FieldVector {
  const result = {} as Iq3FieldVector;
  for (const f of FIELD_IDS) {
    result[f] = (1 - weight) * prior[f];
  }
  result[declared] += weight;
  return result;
}

/** Find the dominant field. */
export function dominantField(v: Iq3FieldVector): Iq3FieldId {
  let best: Iq3FieldId = "generalist";
  let bestP = -1;
  for (const f of FIELD_IDS) {
    if (v[f] > bestP) {
      best = f;
      bestP = v[f];
    }
  }
  return best;
}
