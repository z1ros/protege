import type { Iq3FieldId, Iq3FieldVector } from "@protege/types";
import { FIELD_IDS, uniformFieldPrior } from "@protege/types";
import { fieldVectorFromConceptCounts } from "./taxonomyService.js";

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
    // Wave A — server-side web frameworks. Express + NestJS + Koa + Fastify
    // were absent; "Node REST API" repos previously got zero dep weight to
    // web and lost to devOps signal from CI/Docker.
    /^express$/i, /^@nestjs\//i, /^koa$/i, /^fastify$/i, /^hono$/i,
    /^@remix-run\//i, /^solid-js$/i, /^@builder\.io\/qwik$/i,
    /^prisma$/i, /^drizzle-orm$/i,
  ]},
  { field: "ml", weight: 3, matches: [
    /^torch$/i, /^pytorch$/i, /^tensorflow$/i, /^scikit-learn$/i, /^numpy$/i,
    /^pandas$/i, /^transformers$/i, /^datasets$/i,
    // Wave A — modern ML stack absent from the original list. JAX-family,
    // Lightning, Hugging Face accelerate, vLLM, LangChain.
    /^jax$/i, /^jaxlib$/i, /^flax$/i, /^equinox$/i, /^optax$/i,
    /^lightning$/i, /^pytorch-lightning$/i, /^accelerate$/i, /^vllm$/i,
    /^langchain/i, /^llama-index/i, /^xgboost$/i, /^lightgbm$/i,
  ]},
  { field: "dataEng", weight: 3, matches: [
    /^apache-airflow$/i, /^dbt-core$/i, /^pyspark$/i, /^kafka-python$/i,
    /^prefect$/i, /^dagster$/i,
    // Wave A — modern data-eng additions.
    /^apache-beam$/i, /^polars$/i, /^duckdb$/i,
    /^trino-python-client$/i, /^snowflake-connector-python$/i,
    /^delta-spark$/i, /^pyiceberg$/i,
  ]},
  { field: "devOps", weight: 2, matches: [
    /^terraform$/i, /^pulumi$/i, /^ansible$/i, /^kubernetes-client$/i,
    // Wave A — direct infra/SRE tooling that nobody else uses.
    /^kubernetes$/i, /^helm$/i, /^@pulumi\//i, /^cdktf$/i,
  ]},
  { field: "sec", weight: 3, matches: [
    /^cryptography$/i, /^pwntools$/i, /^scapy$/i, /^pycryptodome$/i, /^impacket$/i,
    // Wave A — sec tooling absent from the original list.
    /^frida$/i, /^ropper$/i, /^angr$/i, /^volatility3$/i, /^yara-python$/i,
    /^r2pipe$/i, /^pyOpenSSL$/i, /^paramiko$/i,
  ]},
  { field: "mobile", weight: 3, matches: [
    /^react-native$/i, /^expo$/i, /^@ionic\//i, /^flutter$/i,
    // Wave A — Capacitor + AndroidX libraries (these appear in Gradle deps
    // strings); also `kotlin-stdlib`.
    /^@capacitor\//i, /^androidx\./i, /^kotlin-stdlib/i,
  ]},
  { field: "systems", weight: 2, matches: [
    /^libc$/i, /^tokio$/i,
    // Wave A — popular Rust + Go networking/runtime crates.
    /^hyper$/i, /^tonic$/i, /^actix-web$/i, /^axum$/i, /^rocket$/i,
    /^gin-gonic\/gin/i, /^labstack\/echo/i, /^valyala\/fasthttp/i,
  ]},
  { field: "game", weight: 3, matches: [
    /^pixi\.js$/i, /^phaser$/i, /^three$/i, /^pygame$/i,
    // Wave A — modern game engines.
    /^pixijs$/i, /^babylonjs$/i, /^@babylonjs\//i, /^excalibur$/i,
    /^bevy$/i, /^macroquad$/i, /^godot-rust$/i,
  ]},
  { field: "embedded", weight: 3, matches: [
    /^mbed/i, /^arduino/i, /^esp-idf/i,
    // Wave A — Rust embedded ecosystem + STM32 HAL.
    /^embassy/i, /^embedded-hal$/i, /^rtic$/i, /^cortex-m/i,
    /^stm32/i, /^nrf52/i, /^zephyr/i, /^freertos/i,
  ]},
];

const EXT_HINTS: Record<string, { field: Iq3FieldId; weight: number }[]> = {
  ".tsx":   [{ field: "web", weight: 2 }],
  ".jsx":   [{ field: "web", weight: 2 }],
  ".vue":   [{ field: "web", weight: 2 }],
  ".svelte":[{ field: "web", weight: 2 }],
  // Wave B-2: vanilla `.ts` and `.js` are overwhelmingly web today
  // (Node services, browser bundles, library source). Without these,
  // an Express + Prisma fixture with 96 `.ts` files got zero web
  // weight from extensions and lost to a few `.sql` migrations.
  ".ts":    [{ field: "web", weight: 1 }, { field: "generalist", weight: 1 }],
  ".js":    [{ field: "web", weight: 1 }, { field: "generalist", weight: 1 }],
  ".css":   [{ field: "web", weight: 1 }],
  ".html":  [{ field: "web", weight: 1 }],
  // Wave B-2: lowered generalist share from .py because deep-Python repos
  // (sec toolkits, ml libraries, data pipelines) were tying generalist
  // with their actual specialty. Generalist still gets *some* signal but
  // not enough to outvote a clear specialty supported by deps.
  ".py":    [{ field: "ml", weight: 1 }, { field: "dataEng", weight: 1 }, { field: "generalist", weight: 0.5 }],
  ".ipynb": [{ field: "ml", weight: 3 }],
  ".tf":    [{ field: "devOps", weight: 3 }],
  ".yaml":  [{ field: "devOps", weight: 1 }],
  ".yml":   [{ field: "devOps", weight: 1 }],
  ".dockerfile": [{ field: "devOps", weight: 2 }],
  ".swift": [{ field: "mobile", weight: 3 }],
  ".kt":    [{ field: "mobile", weight: 2 }],
  // Wave A — Dart/Java/Objective-C added. Dart is overwhelmingly Flutter.
  ".dart":  [{ field: "mobile", weight: 3 }],
  ".java":  [{ field: "mobile", weight: 1 }, { field: "generalist", weight: 1 }],
  ".m":     [{ field: "mobile", weight: 2 }],
  ".mm":    [{ field: "mobile", weight: 2 }],
  ".rs":    [{ field: "systems", weight: 2 }],
  // Wave A — Go is multipurpose; favor systems lightly with a generalist
  // share so it doesn't anchor systems too aggressively.
  ".go":    [{ field: "systems", weight: 1 }, { field: "generalist", weight: 1 }],
  // .c stays as systems(2)/embedded(1) — pure-C is split between
  // firmware and systems-C (databases, network stacks, kernel modules).
  // Ambiguity is broken AFTER accumulation by a dep-conditional embedded
  // boost (see `applyEmbeddedDepBoost` below) — when esp-idf/stm32/
  // zephyr/freertos/arduino/embassy/embedded-hal/rtic/cortex-m deps fire,
  // the embedded weight scales to win firmware repos. Without those
  // deps, .c-heavy repos (e.g. C++ databases with utility .c) stay
  // classified as systems.
  ".c":     [{ field: "systems", weight: 2 }, { field: "embedded", weight: 1 }],
  ".cpp":   [{ field: "systems", weight: 1 }, { field: "game", weight: 1 }, { field: "embedded", weight: 1 }],
  ".cc":    [{ field: "systems", weight: 1 }, { field: "game", weight: 1 }, { field: "embedded", weight: 1 }],
  // .h files are genuinely shared between embedded firmware, systems C
  // (kernel headers, network stacks), and C++ databases. Keep equal
  // weights — let DEP_HINTS (esp-idf / stm32 / freertos vs none) and
  // .ino (+4 embedded) be the tiebreakers, not the headers themselves.
  ".h":     [{ field: "embedded", weight: 1 }, { field: "systems", weight: 1 }],
  ".hpp":   [{ field: "systems", weight: 1 }, { field: "embedded", weight: 1 }],
  // Wave B — assembly + sage notebooks signal sec/reverse-engineering.
  ".asm":   [{ field: "sec", weight: 2 }, { field: "systems", weight: 1 }, { field: "embedded", weight: 1 }],
  ".s":     [{ field: "sec", weight: 2 }, { field: "systems", weight: 1 }, { field: "embedded", weight: 1 }],
  ".sage":  [{ field: "sec", weight: 3 }],
  // Wave B-2 — embedded-specific extensions: device tree, linker
  // scripts, board overlays. Strong signals nobody else uses.
  ".dts":   [{ field: "embedded", weight: 4 }],
  ".overlay": [{ field: "embedded", weight: 3 }],
  ".ld":    [{ field: "embedded", weight: 3 }],
  ".ino":   [{ field: "embedded", weight: 4 }],
  ".sol":   [{ field: "sec", weight: 1 }],
  // Wave B-2: shell scripts are dual-use. Pure devOps repos have heavy
  // shell, but so do dotfiles, exercise collections, and any polyglot
  // repo. Lowered generalist share from 1 to 0.5 so a sec or ml repo
  // with helper bash scripts doesn't lose to generalist via shell-only
  // signal accumulation.
  ".sh":    [{ field: "devOps", weight: 1 }, { field: "generalist", weight: 0.5 }],
  // Wave A — game-engine + graphics signals.
  ".cs":    [{ field: "game", weight: 2 }, { field: "web", weight: 1 }],
  ".gd":    [{ field: "game", weight: 4 }],
  ".uasset":[{ field: "game", weight: 3 }],
  ".uproject":[{ field: "game", weight: 3 }],
  ".glsl":  [{ field: "game", weight: 3 }],
  ".hlsl":  [{ field: "game", weight: 3 }],
  ".frag":  [{ field: "game", weight: 3 }],
  ".vert":  [{ field: "game", weight: 3 }],
  ".shader":[{ field: "game", weight: 3 }],
  // SQL files are dual-use: dataEng pipelines AND web-backend
  // migrations. Pure dataEng repos have many .sql; a typical web app
  // has 3-10 migration files. Splitting equally lets web's other
  // signals dominate when they exist, while pure-data repos stack the
  // signal across many .sql files via log-scaled accumulation.
  ".sql":   [{ field: "dataEng", weight: 1 }, { field: "web", weight: 1 }],
  ".lua":   [{ field: "game", weight: 1 }, { field: "generalist", weight: 1 }],
  // Wave A — yara files for sec.
  ".yar":   [{ field: "sec", weight: 3 }],
  ".yara":  [{ field: "sec", weight: 3 }],
};

const INFRA_HINTS: Array<{ pattern: RegExp; field: Iq3FieldId; weight: number }> = [
  { pattern: /^Dockerfile$/, field: "devOps", weight: 3 },
  { pattern: /docker-compose\.ya?ml$/, field: "devOps", weight: 2 },
  { pattern: /^k8s\//, field: "devOps", weight: 2 },
  { pattern: /\.(tf|tfvars)$/, field: "devOps", weight: 2 },
  { pattern: /^\.github\/workflows\//, field: "devOps", weight: 1 },
  // Wave B-2 — embedded toolchain markers. Many synthetic fixtures
  // (esp32-iot-firmware, stm32-zephyr-rtos, firmware-with-web-portal)
  // have no JS/Python deps but ship with these unmistakable embedded
  // build files. Pattern-matching them here gives embedded a strong
  // signal independent of file extensions.
  { pattern: /(^|\/)sdkconfig(\.defaults)?$/, field: "embedded", weight: 4 },
  { pattern: /(^|\/)platformio\.ini$/, field: "embedded", weight: 4 },
  { pattern: /(^|\/)Kconfig$/, field: "embedded", weight: 3 },
  { pattern: /(^|\/)prj\.conf$/, field: "embedded", weight: 3 },
  { pattern: /(^|\/)partitions\.csv$/, field: "embedded", weight: 3 },
  { pattern: /(^|\/)west\.ya?ml$/, field: "embedded", weight: 3 },
  { pattern: /(^|\/)idf\.py$/, field: "embedded", weight: 3 },
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

  // Wave A — log-scale per-field infra-file accumulation. Previously a
  // repo with 12 GitHub workflows + 1 Dockerfile + 8 k8s manifests would
  // add `12*1 + 1*3 + 8*2 = 31` to devOps, which swamped any
  // application-level signal. Group all infra hits per field, then
  // log-scale the total. Matches the existing extension-count pattern.
  const infraFieldWeight = new Map<Iq3FieldId, number>();
  for (const file of signals.infraFiles ?? []) {
    for (const hint of INFRA_HINTS) {
      if (hint.pattern.test(file)) {
        infraFieldWeight.set(
          hint.field,
          (infraFieldWeight.get(hint.field) ?? 0) + hint.weight,
        );
      }
    }
  }
  for (const [field, total] of infraFieldWeight) {
    raw[field] += Math.log2(total + 1);
  }

  // Wave B-2 — confirmed-embedded boost. .c and .h weights stay
  // balanced toward systems by default (pure-C codebases include
  // databases, network stacks, kernel modules — not just firmware).
  // We boost embedded when EITHER a known embedded dep fires (esp-idf,
  // stm32, zephyr, freertos, arduino, mbed, embassy, embedded-hal,
  // rtic, cortex-m, nrf52) OR an embedded INFRA marker is present
  // (sdkconfig, platformio.ini, Kconfig, prj.conf, partitions.csv,
  // west.yml, idf.py — all matched in INFRA_HINTS above). Many real
  // firmware repos ship with no JS/Python deps but with these toolchain
  // markers; without the INFRA branch they look like generic systems-C.
  const EMBEDDED_DEP_RX =
    /^(esp-idf|stm32|nrf52|zephyr|freertos|arduino|mbed|embassy|embedded-hal|rtic|cortex-m)/i;
  const hasEmbeddedDeps = allDeps.some((d) => EMBEDDED_DEP_RX.test(d));
  const hasEmbeddedInfra = (infraFieldWeight.get("embedded") ?? 0) > 0;
  if (hasEmbeddedDeps || hasEmbeddedInfra) {
    const cFamilyCount =
      (signals.fileExtensions?.[".c"] ?? 0) +
      (signals.fileExtensions?.[".h"] ?? 0) +
      (signals.fileExtensions?.[".cpp"] ?? 0) +
      (signals.fileExtensions?.[".hpp"] ?? 0);
    if (cFamilyCount > 0) {
      raw.embedded += Math.log2(cFamilyCount + 1) * 2;
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

/** Find the dominant field.
 *
 *  Wave B — polyglot override. If the marginal winner has no decisive
 *  lead AND the distribution is high-entropy (mass spread across many
 *  fields), classify as `generalist` instead. This lets dotfiles,
 *  polyglot exercise collections, and staff-engineer playgrounds land
 *  on `generalist` without polluting the underlying field vector with
 *  an additive bias term. The vector still reflects the actual signal
 *  spread; only the categorical "winner" decision is overridden.
 *
 *  Thresholds:
 *  - `bestP < 0.30` — top field has no decisive plurality
 *  - entropy/maxEntropy > 0.78 — mass is genuinely spread (not one
 *    dominant field with noise tails)
 *
 *  These cutoffs were tuned against the unanimous-agree fixture set
 *  (`__field-fixtures__/synthetic`+`real`) such that single-field
 *  repos still classify by their dominant field and only legitimately
 *  polyglot repos flip to generalist.
 */
export function dominantField(v: Iq3FieldVector): Iq3FieldId {
  let best: Iq3FieldId = "generalist";
  let bestP = -1;
  for (const f of FIELD_IDS) {
    if (v[f] > bestP) {
      best = f;
      bestP = v[f];
    }
  }
  if (best === "generalist") return best;
  // Polyglot override fires only when ALL of:
  //   1) The marginal winner has < 28% mass (no clear plurality).
  //   2) The gap to second place is small (< 4%) — i.e. two or more
  //      fields are essentially tied.
  //   3) Distribution entropy is high (mass spread across many fields,
  //      not just two competing).
  // This combination matches what humans recognize as "polyglot" — no
  // dominant specialty AND multiple competing specialties — and avoids
  // misclassifying near-misses (e.g. a fixture where sec narrowly leads
  // a noisy distribution at 27%) as generalist.
  const DECISIVE_LEAD_THRESHOLD = 0.28;
  const TIE_GAP_THRESHOLD = 0.05;
  const HIGH_ENTROPY_THRESHOLD = 0.78;
  if (bestP >= DECISIVE_LEAD_THRESHOLD) return best;
  let secondBestP = -1;
  for (const f of FIELD_IDS) {
    if (f === best) continue;
    if (v[f] > secondBestP) secondBestP = v[f];
  }
  const gap = bestP - secondBestP;
  if (gap >= TIE_GAP_THRESHOLD) return best;
  let entropy = 0;
  for (const f of FIELD_IDS) {
    const p = v[f];
    if (p > 0) entropy += -p * Math.log(p);
  }
  const maxEntropy = Math.log(FIELD_IDS.length);
  const entropyFraction = maxEntropy > 0 ? entropy / maxEntropy : 0;
  if (entropyFraction > HIGH_ENTROPY_THRESHOLD) return "generalist";
  return best;
}

export interface FieldUpdateInput {
  prior: Iq3FieldVector;
  repoSignals?: RepoSignals;
  conceptCounts?: Record<string, number>;
  selfDeclared?: Iq3FieldId;
  daysSinceLastUpdate?: number;
}

/**
 * One-shot field vector update applying all three sources at the spec's
 * weights: 40% repo / 40% concepts / 20% self-declared.
 */
export function updateFieldVector(input: FieldUpdateInput): Iq3FieldVector {
  const repo  = input.repoSignals    ? detectFieldFromRepo(input.repoSignals) : null;
  const conc  = input.conceptCounts  ? fieldVectorFromConceptCounts(input.conceptCounts) : null;

  const fresh = mixFreshSources(repo, conc, input.selfDeclared);
  return emaMergeField(input.prior, fresh, 30, input.daysSinceLastUpdate ?? 1);
}

function mixFreshSources(
  repo: Iq3FieldVector | null,
  conc: Iq3FieldVector | null,
  selfDeclared: Iq3FieldId | undefined,
): Iq3FieldVector {
  const baseline = uniformFieldPrior();
  const w_repo = repo ? 0.4 : 0;
  const w_conc = conc ? 0.4 : 0;
  const w_self = selfDeclared ? 0.2 : 0;
  const w_baseline = 1 - (w_repo + w_conc + w_self);
  const result = {} as Iq3FieldVector;
  for (const f of FIELD_IDS) {
    result[f] =
      w_baseline * baseline[f] +
      w_repo * (repo ? repo[f] : 0) +
      w_conc * (conc ? conc[f] : 0) +
      w_self * (selfDeclared === f ? 1 : 0);
  }
  return result;
}
