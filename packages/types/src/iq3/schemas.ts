import { z } from "zod";
import { FIELD_IDS } from "./fields.js";
import { PILLAR_IDS } from "./pillars.js";
import { RANK_IDS } from "./rank.js";
import { TRAIT_IDS } from "./traits.js";

export const Iq3FieldIdSchema = z.enum(FIELD_IDS);
export const Iq3PillarIdSchema = z.enum(PILLAR_IDS);
export const Iq3RankIdSchema = z.enum(RANK_IDS);
export const Iq3TraitIdSchema = z.enum(TRAIT_IDS);
export const Iq3TraitStateSchema = z.enum(["low", "mid", "high"]);

export const Iq3TraitPosteriorSchema = z.object({
  low: z.number().min(0).max(1),
  mid: z.number().min(0).max(1),
  high: z.number().min(0).max(1),
});

export const Iq3FieldVectorSchema = z.object(
  Object.fromEntries(FIELD_IDS.map((f) => [f, z.number().min(0).max(1)])),
) as unknown as z.ZodObject<Record<typeof FIELD_IDS[number], z.ZodNumber>>;

export const SelfRatingSchema = z.object({
  userId: z.string().min(1),
  /** 1–10 self-reported seniority */
  rating: z.number().int().min(1).max(10),
  ratedAt: z.string().datetime(),
  /** optional free-text */
  note: z.string().max(500).optional(),
});

export type SelfRating = z.infer<typeof SelfRatingSchema>;

/**
 * Anonymous "found something weird" feedback on Code IQ scoring.
 *
 * No userId — endpoint is auth-gated to prevent spam, but the persisted
 * row stores only the free-text and a server-stamped timestamp. Used to
 * surface scoring issues from real users without tying complaints to
 * identities.
 */
export const FEEDBACK_TEXT_MAX = 1000;

export const Iq3FeedbackSchema = z.object({
  text: z.string().min(1).max(FEEDBACK_TEXT_MAX),
  submittedAt: z.string().datetime(),
});

export type Iq3Feedback = z.infer<typeof Iq3FeedbackSchema>;
