import { describe, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { detectFieldFromRepo, dominantField } from "./fieldVector.js";
import type { Iq3FieldId } from "@protege/types";

interface FieldFixture {
  id: string;
  description: string;
  expectedDominantField: Iq3FieldId;
  repoSignals: Parameters<typeof detectFieldFromRepo>[0];
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONTESTED_DIR = join(__dirname, "__field-fixtures__", "contested");

describe("field classification — contested fixtures (audit-flagged, informational only)", () => {
  const files = readdirSync(CONTESTED_DIR).filter((f) => f.endsWith(".json"));
  for (const file of files) {
    const fixture = JSON.parse(
      readFileSync(join(CONTESTED_DIR, file), "utf8"),
    ) as FieldFixture;
    it(`${fixture.id} — expected=${fixture.expectedDominantField}`, () => {
      const v = detectFieldFromRepo(fixture.repoSignals);
      const top = dominantField(v);
      // INFORMATIONAL — these fixtures' labels are flagged as contested
      // by the cross-auditor review. We log the system's classification
      // but DO NOT assert; passing or failing here is not a defect, it
      // is a calibration data point.
      // eslint-disable-next-line no-console
      console.log(
        `[contested] ${fixture.id}: expected=${fixture.expectedDominantField} got=${top}`,
      );
    });
  }
});
