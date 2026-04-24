import type { UserPreferenceRow } from "../../../src/store.js";

interface Options {
  userId: string;
}

export function generateUserPreferences(opts: Options): UserPreferenceRow {
  return {
    userId: opts.userId,
    storyModeNotify: false,
    echoConceptLanguage: null,
    backfillDone: true,
  };
}
