/** Field IDs — fields the developer might be specializing in. */
export const FIELD_IDS = [
  "web",
  "ml",
  "dataEng",
  "devOps",
  "sec",
  "mobile",
  "systems",
  "game",
  "embedded",
  "generalist",
] as const;

export type Iq3FieldId = (typeof FIELD_IDS)[number];

/** Probability vector over fields. Sums to 1.0. */
export type Iq3FieldVector = Record<Iq3FieldId, number>;

/** Default uniform prior used at cold start before any signals. */
export function uniformFieldPrior(): Iq3FieldVector {
  const p = 1 / FIELD_IDS.length;
  return Object.fromEntries(FIELD_IDS.map((f) => [f, p])) as Iq3FieldVector;
}
