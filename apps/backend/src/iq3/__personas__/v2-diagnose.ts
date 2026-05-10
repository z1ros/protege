/**
 * Quick v2 pillar diagnostic — dumps pillar scores per persona for
 * BOTH stream sets so we can see which pillars are causing rank
 * floor violations.
 */

import { runPersona } from "./runPersona.js";
import { V2_PERSONAS as A } from "./v2-streams-A/index.js";
import { V2_PERSONAS as B } from "./v2-streams-B/index.js";

function dumpPersona(label: string, p: typeof A[number]) {
  const { headline } = runPersona(p);
  const pillars = headline.pillars;
  const ps = (k: keyof typeof pillars) =>
    pillars[k].pending ? "PEND" : String(pillars[k].score).padStart(4, " ");
  const floorViol = headline.rank.floorViolation
    ? ` [floor: ${headline.rank.floorViolation.pillar}=${headline.rank.floorViolation.score}<${headline.rank.floorViolation.floor}]`
    : "";
  console.log(
    `${label.padEnd(36)} score=${String(headline.score).padStart(3, " ")} rank=${headline.rank.rank.padEnd(7, " ")} unc=${headline.rank.uncappedRank.padEnd(7, " ")} comp=${ps("reading")} exec=${ps("writing")} diag=${ps("debugging")} verif=${ps("testing")} stew=${ps("maintainability")} ai=${ps("aiLiteracy")}${floorViol}`,
  );
}

console.log("=== AUTHOR A ===");
for (const p of A) dumpPersona(p.id, p);
console.log("\n=== AUTHOR B ===");
for (const p of B) dumpPersona(p.id, p);
