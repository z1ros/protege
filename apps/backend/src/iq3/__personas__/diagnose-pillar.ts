/**
 * Per-pillar calibration diagnostic.
 *
 * Run from `apps/backend/`:
 *
 *     pnpm tsx src/iq3/__personas__/diagnose-pillar.ts reading
 *
 * For a given pillar, dumps a side-by-side table comparing each
 * persona's system-computed pillar score to the human-anchored
 * consensus target, plus the underlying trait posteriors and the
 * matchKeys that fired during the stream. This is the working
 * surface for pillar-by-pillar calibration.
 *
 * Targets are sourced from CONSENSUS-GROUND-TRUTH.md (4-rater mean,
 * with human anchor overrides applied where flagged).
 */

import type { EchoEvent, Iq3PillarId, Iq3TraitId } from "@protege/types";
import { TRAIT_TO_PILLAR } from "@protege/types";
import { initialUserState } from "../hmm.js";
import {
  applyEventsToState,
  _MATCHERS_FOR_TEST,
  type IngestContext,
} from "../ingest/iq3Hook.js";
import { updateFieldVector } from "../fieldVector.js";
import { computePillars } from "../pillars.js";
import { LIKELIHOODS } from "../likelihoods.js";
import { UNBIASED_PERSONAS } from "./unbiased/index.js";

// 4-rater consensus per-pillar targets (rounded mean from
// CONSENSUS-GROUND-TRUTH.md). Human anchor overrides applied:
//   - Persona 1 AI Partnership: 260 (was mean 262.5)
//   - Persona 2 headline: 570 (Codex profile − 20). Pillars not
//     explicitly overridden by the anchor; using 4-rater mean.
const CONSENSUS_PILLARS: Record<
  string,
  Record<Iq3PillarId, number>
> = {
  "unbiased:bootcampGrad":
    { reading: 229, writing: 293, debugging: 190, testing: 166, maintainability: 205, aiLiteracy: 260 },
  "unbiased:earnestJunior":
    { reading: 518, writing: 513, debugging: 489, testing: 489, maintainability: 528, aiLiteracy: 616 },
  "unbiased:vibecoder":
    { reading: 195, writing: 463, debugging: 199, testing: 203, maintainability: 224, aiLiteracy: 280 },
  "unbiased:pragmaticMid":
    { reading: 706, writing: 685, debugging: 711, testing: 696, maintainability: 698, aiLiteracy: 740 },
  "unbiased:mlResearcher":
    { reading: 733, writing: 637, debugging: 785, testing: 676, maintainability: 564, aiLiteracy: 418 },
  "unbiased:mobileMid":
    { reading: 716, writing: 738, debugging: 705, testing: 626, maintainability: 720, aiLiteracy: 670 },
  "unbiased:seniorBackendArchitect":
    { reading: 861, writing: 795, debugging: 878, testing: 844, maintainability: 869, aiLiteracy: 791 },
  "unbiased:securitySenior":
    { reading: 825, writing: 700, debugging: 873, testing: 884, maintainability: 824, aiLiteracy: 236 },
  "unbiased:devOpsSenior":
    { reading: 770, writing: 779, debugging: 873, testing: 514, maintainability: 671, aiLiteracy: 778 },
  "unbiased:polyglotStaff":
    { reading: 933, writing: 855, debugging: 920, testing: 893, maintainability: 921, aiLiteracy: 880 },
};

const PILLARS: Iq3PillarId[] = [
  "reading",
  "writing",
  "debugging",
  "testing",
  "maintainability",
  "aiLiteracy",
];

function expectedValue(p: { low: number; mid: number; high: number }): number {
  return 0 * p.low + 0.5 * p.mid + 1 * p.high;
}

function fmt(n: number, width = 4): string {
  return String(n).padStart(width, " ");
}

function fmtFloat(n: number, decimals = 2): string {
  return n.toFixed(decimals);
}

function fireMatchKeys(events: EchoEvent[]): Map<string, number> {
  const ctx: IngestContext = { recent: [] };
  const tally = new Map<string, number>();
  for (const e of events) {
    ctx.recent.push(e);
    if (ctx.recent.length > 4000) ctx.recent.splice(0, ctx.recent.length - 4000);
    for (const m of _MATCHERS_FOR_TEST) {
      const keys = m(e, ctx);
      for (const k of keys) tally.set(k, (tally.get(k) ?? 0) + 1);
    }
  }
  return tally;
}

function main() {
  const arg = (process.argv[2] ?? "").toLowerCase();
  const pillar = PILLARS.find((p) => p.toLowerCase() === arg);
  if (!pillar) {
    console.error(
      `usage: tsx diagnose-pillar.ts <pillar>\n  pillars: ${PILLARS.join(", ")}`,
    );
    process.exit(2);
  }

  // Which traits feed this pillar?
  const pillarTraits: Iq3TraitId[] = (
    Object.entries(TRAIT_TO_PILLAR) as Array<[Iq3TraitId, Iq3PillarId]>
  )
    .filter(([, p]) => p === pillar)
    .map(([t]) => t);

  console.log(`\n=== Pillar: ${pillar} ===`);
  console.log(`Traits feeding this pillar: ${pillarTraits.join(", ")}\n`);

  // Per-persona comparison table.
  console.log(
    "persona".padEnd(36) +
      "actual".padStart(8) +
      "target".padStart(8) +
      "delta".padStart(8) +
      "  " +
      pillarTraits.map((t) => t.slice(0, 14).padStart(14)).join(""),
  );
  console.log("-".repeat(120));

  const allMatchKeysAcrossPersonas = new Set<string>();
  const persona2matchKeys = new Map<string, Map<string, number>>();

  for (const p of UNBIASED_PERSONAS) {
    let state = initialUserState(p.id);
    state = {
      ...state,
      field: updateFieldVector({
        prior: state.field,
        repoSignals: p.field.repoSignals,
        conceptCounts: p.field.conceptCounts,
        selfDeclared: p.field.selfDeclared,
        daysSinceLastUpdate: 365,
      }),
    };
    const events = p.events();
    state = applyEventsToState(state, events);

    const pillarsOut = computePillars(state);
    const actual = pillarsOut[pillar].score;
    const target = CONSENSUS_PILLARS[p.id]?.[pillar] ?? 0;
    const delta = actual - target;

    // Trait posteriors (as expected value 0..1).
    const traitVals = pillarTraits.map((t) => expectedValue(state.traits[t]));
    const traitCol = traitVals
      .map((v) => fmtFloat(v).padStart(14))
      .join("");

    console.log(
      p.id.replace("unbiased:", "").padEnd(36) +
        fmt(actual, 8) +
        fmt(target, 8) +
        fmt(delta, 8) +
        "  " +
        traitCol,
    );

    const fired = fireMatchKeys(events);
    persona2matchKeys.set(p.id, fired);
    for (const k of fired.keys()) allMatchKeysAcrossPersonas.add(k);
  }

  // What matchKeys fired across the personas? Highlight ones feeding
  // this pillar's traits.
  console.log("\n--- matchKey fire counts per persona ---");
  const sorted = [...allMatchKeysAcrossPersonas].sort();
  console.log(
    "matchKey".padEnd(72) +
      UNBIASED_PERSONAS.map((p) =>
        p.id.replace("unbiased:", "").slice(0, 8).padStart(8),
      ).join(""),
  );
  for (const k of sorted) {
    const row = UNBIASED_PERSONAS.map((p) =>
      fmt(persona2matchKeys.get(p.id)?.get(k) ?? 0, 8),
    ).join("");
    console.log(k.padEnd(72) + row);
  }

  // Which matchKeys feed this pillar's traits — and which of THOSE
  // never fired? This is the gap analysis.
  console.log("\n--- COVERAGE GAP for this pillar ---");
  const expectedKeys = new Set<string>();
  for (const e of LIKELIHOODS) {
    if (pillarTraits.includes(e.trait)) expectedKeys.add(e.matchKey);
  }
  const firedAny = new Set<string>();
  for (const fired of persona2matchKeys.values()) {
    for (const k of fired.keys()) firedAny.add(k);
  }
  const expectedFiredHere: string[] = [];
  const expectedNeverFired: string[] = [];
  for (const k of expectedKeys) {
    (firedAny.has(k) ? expectedFiredHere : expectedNeverFired).push(k);
  }
  console.log(
    `expected matchKeys (feeding this pillar's traits): ${expectedKeys.size}`,
  );
  console.log(`  fired in at least one persona: ${expectedFiredHere.length}`);
  console.log(`  never fired (no producer):    ${expectedNeverFired.length}`);
  if (expectedNeverFired.length > 0) {
    console.log("\n  unfired matchKeys:");
    for (const k of expectedNeverFired.sort()) console.log(`    ${k}`);
  }
}

main();
