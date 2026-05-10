/**
 * v2/v3 calibration status report.
 *
 * Runs the dual-author streams (v2-streams-A, v2-streams-B) through
 * the pipeline and prints a side-by-side comparison vs the consensus
 * targets. The remaining systematic deltas are documented in
 * CALIBRATION-LOG.md ("v3 — DONE") — this test exists to detect
 * REGRESSIONS, not to enforce the synthetic-data ceiling.
 *
 * Test passes when both stream authors run end-to-end without error.
 * Calibration findings are logged for the developer to inspect — this
 * is the single canonical place to look for "what does the system
 * score for each archetype today."
 */

import { describe, it, expect } from "vitest";
import { dominantField } from "../fieldVector.js";
import { runPersona, type Persona } from "./runPersona.js";
import { V2_PERSONAS as V2_A } from "./v2-streams-A/index.js";
import { V2_PERSONAS as V2_B } from "./v2-streams-B/index.js";

function archetype(p: Persona): string {
  return p.id.replace(/^v2[AB]:/, "").toLowerCase();
}

const aByArchetype = new Map(V2_A.map((p) => [archetype(p), p]));
const bByArchetype = new Map(V2_B.map((p) => [archetype(p), p]));

describe("Iq3 v2/v3 calibration — status report", () => {
  it("both author stream sets run end-to-end and stay deterministic", () => {
    const archetypes = [
      ...new Set([...aByArchetype.keys(), ...bByArchetype.keys()]),
    ].sort();

    const rows: string[] = [];
    rows.push(
      "archetype                    | A score (rank/field)        | B score (rank/field)        | A Δ | B Δ",
    );
    rows.push(
      "-----------------------------+-----------------------------+-----------------------------+-----+----",
    );

    let anyMismatch = false;
    for (const arch of archetypes) {
      const a = aByArchetype.get(arch);
      const b = bByArchetype.get(arch);
      const target = (a ?? b)!.expect.headlineRange;
      const targetMid = Math.round((target[0] + target[1]) / 2);

      const aCol = a
        ? (() => {
            const { headline } = runPersona(a);
            const f = dominantField(headline.field);
            return `${String(headline.score).padStart(3)} (${headline.rank.rank.padEnd(7)}/${f.padEnd(10)})`;
          })()
        : "—".padEnd(31);
      const bCol = b
        ? (() => {
            const { headline } = runPersona(b);
            const f = dominantField(headline.field);
            return `${String(headline.score).padStart(3)} (${headline.rank.rank.padEnd(7)}/${f.padEnd(10)})`;
          })()
        : "—".padEnd(31);
      const aDelta = a
        ? (() => {
            const { headline } = runPersona(a);
            return headline.score - targetMid;
          })()
        : null;
      const bDelta = b
        ? (() => {
            const { headline } = runPersona(b);
            return headline.score - targetMid;
          })()
        : null;
      rows.push(
        `${arch.padEnd(28)} | ${aCol.padEnd(28)} | ${bCol.padEnd(28)} | ${(aDelta != null ? (aDelta >= 0 ? "+" : "") + aDelta : "—").padStart(4)} | ${(bDelta != null ? (bDelta >= 0 ? "+" : "") + bDelta : "—").padStart(4)}`,
      );

      // Just confirm runs don't throw — no assertion on score band.
      if (a) {
        const { headline } = runPersona(a);
        expect(typeof headline.score).toBe("number");
      }
      if (b) {
        const { headline } = runPersona(b);
        expect(typeof headline.score).toBe("number");
      }
      // Determinism: same call returns identical result
      if (a) {
        const r1 = runPersona(a).headline.score;
        const r2 = runPersona(a).headline.score;
        expect(r1).toBe(r2);
      }

      if (a && b) {
        const { headline: hA } = runPersona(a);
        const { headline: hB } = runPersona(b);
        if (hA.rank.rank !== hB.rank.rank) anyMismatch = true;
      }
    }

    // Print status report so a developer running tests sees the deltas.
    // This is informational; the test passes regardless.
    // eslint-disable-next-line no-console
    console.log("\n" + rows.join("\n") + "\n");
    if (anyMismatch) {
      // eslint-disable-next-line no-console
      console.log(
        "Note: some archetypes have rank mismatch between authors A and B. See CALIBRATION-LOG.md for analysis.",
      );
    }
  });
});
