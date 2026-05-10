import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { detectFieldFromRepo, type RepoSignals } from "./fieldVector.js";
import { dominantField } from "./fieldVector.js";
import type { Iq3FieldId } from "@protege/types";

interface FieldFixture {
  id: string;
  description: string;
  expectedDominantField: Iq3FieldId;
  repoSignals: RepoSignals;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURES_ROOT = join(__dirname, "__field-fixtures__");

function loadFixtures(subdir: string): Array<{ file: string; fixture: FieldFixture }> {
  const dir = join(FIXTURES_ROOT, subdir);
  const entries = readdirSync(dir).filter((f) => f.endsWith(".json"));
  return entries.map((file) => {
    const raw = readFileSync(join(dir, file), "utf8");
    const fixture = JSON.parse(raw) as FieldFixture;
    return { file, fixture };
  });
}

function runFixture(fixture: FieldFixture): void {
  const vector = detectFieldFromRepo(fixture.repoSignals);
  const got = dominantField(vector);
  expect(
    got,
    `expected dominant field "${fixture.expectedDominantField}" but got "${got}". full vector: ${JSON.stringify(vector)}`,
  ).toBe(fixture.expectedDominantField);
}

describe("field classification — synthetic fixtures", () => {
  const fixtures = loadFixtures("synthetic");
  for (const { fixture } of fixtures) {
    it(`${fixture.id} — ${fixture.description}`, () => {
      runFixture(fixture);
    });
  }
});

describe("field classification — real fixtures", () => {
  const fixtures = loadFixtures("real");
  for (const { fixture } of fixtures) {
    it(`${fixture.id} — ${fixture.description}`, () => {
      runFixture(fixture);
    });
  }
});
