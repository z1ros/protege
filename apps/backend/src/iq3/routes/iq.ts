import { Hono } from "hono";
import type { Iq3FieldId, Iq3UserState } from "@protege/types";
import { FIELD_IDS } from "@protege/types";
import { computeHeadline } from "../composite.js";
import { applyMatchKeys, initialUserState } from "../hmm.js";
import { MATCHKEY_TO_TRAITS } from "../likelihoods.js";
import { applySelfDeclaration } from "../fieldVector.js";
import { FALLBACK_DISTRIBUTION } from "../cohort.js";
import { githubAuth, resolveUserId } from "../../middleware/auth.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getIq3UserStateRepo, setIq3UserStateRepo } from "../repo.js";

export { setIq3UserStateRepo };

const repo = getIq3UserStateRepo;

const app = new Hono();

// /taxonomy is registered BEFORE the auth middleware: it's a static
// schema with no PII, so it must remain reachable without a Bearer.
// Hono `app.use("*")` only applies to routes registered AFTER the use()
// call, so order matters here.
app.get("/taxonomy", async (c) => {
  const taxonomyPath = resolve(
    process.cwd(),
    "../extension/webview/skills-taxonomy.json",
  );
  const tagsPath = resolve(
    process.cwd(),
    "../extension/webview/skills-taxonomy.field-tags.json",
  );
  const taxonomy = JSON.parse(readFileSync(taxonomyPath, "utf-8"));
  const tags = JSON.parse(readFileSync(tagsPath, "utf-8"));
  return c.json({ taxonomy, tags });
});

// Everything below this line requires a verified GitHub Bearer. The
// userId is taken from the verified token (via resolveUserId) and any
// caller-supplied x-user-id / ?userId / body.userId that disagrees is
// rejected — see middleware/auth.ts. This is the IDOR fix for
// /iq/me + /iq/onboarding (Codex finding F1).
app.use("*", githubAuth());

app.get("/me", async (c) => {
  const userId = resolveUserId(c, undefined);
  const existing = await repo().load(userId);
  const state = existing ?? initialUserState(userId);
  if (!existing) await repo().save(state);
  const headline = computeHeadline(state, FALLBACK_DISTRIBUTION);
  return c.json({ headline });
});

// Onboarding accepts a small fixed set of probe-derived matchKeys.
// Uncapped + unvalidated input would let any authenticated caller burn
// CPU on `applyMatchKeys` or push arbitrary keys into a future-added
// likelihood entry (security audit H1).
const ONBOARDING_MAX_MATCHKEYS = 50;

app.post("/onboarding", async (c) => {
  const body = await c.req.json().catch(() => null);
  // Accept body.userId for back-compat but resolveUserId enforces it
  // matches the authenticated identity (else 403).
  const claimedUserId =
    typeof body?.userId === "string" ? (body.userId as string) : undefined;
  const userId = resolveUserId(c, claimedUserId);
  const rawKeys: unknown = body?.matchKeys;
  if (!Array.isArray(rawKeys)) {
    return c.json({ error: "matchKeys must be an array of strings" }, 400);
  }
  if (rawKeys.length > ONBOARDING_MAX_MATCHKEYS) {
    return c.json(
      { error: `matchKeys exceeds limit of ${ONBOARDING_MAX_MATCHKEYS}` },
      400,
    );
  }
  const matchKeys: string[] = [];
  for (const k of rawKeys) {
    if (typeof k !== "string" || !MATCHKEY_TO_TRAITS.has(k)) {
      return c.json({ error: "unknown matchKey" }, 400);
    }
    matchKeys.push(k);
  }
  const field = body?.field;

  let state = (await repo().load(userId)) ?? initialUserState(userId);
  state = applyMatchKeys(state, matchKeys, { isAiEvent: false });
  if (typeof field === "string" && (FIELD_IDS as readonly string[]).includes(field)) {
    state.field = applySelfDeclaration(state.field, field as Iq3FieldId, 0.2);
  }
  await repo().save(state);
  return c.json({ ok: true });
});

export default app;
