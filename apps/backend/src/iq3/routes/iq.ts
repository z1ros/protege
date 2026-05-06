import { Hono } from "hono";
import type { Iq3FieldId, Iq3UserState } from "@protege/types";
import { FIELD_IDS } from "@protege/types";
import { computeHeadline } from "../composite.js";
import { applyMatchKeys, initialUserState } from "../hmm.js";
import { applySelfDeclaration } from "../fieldVector.js";
import { FALLBACK_DISTRIBUTION } from "../cohort.js";
import { githubAuth, resolveUserId } from "../../middleware/auth.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface UserStateRepo {
  load(userId: string): Promise<Iq3UserState | null>;
  save(state: Iq3UserState): Promise<void>;
}

let _repo: UserStateRepo | null = null;
export function setIq3UserStateRepo(repo: UserStateRepo) {
  _repo = repo;
}
function repo(): UserStateRepo {
  if (!_repo) throw new Error("iq3 user-state repo not initialized");
  return _repo;
}

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

app.post("/onboarding", async (c) => {
  const body = await c.req.json().catch(() => null);
  // Accept body.userId for back-compat but resolveUserId enforces it
  // matches the authenticated identity (else 403).
  const claimedUserId =
    typeof body?.userId === "string" ? (body.userId as string) : undefined;
  const userId = resolveUserId(c, claimedUserId);
  const matchKeys: string[] = Array.isArray(body?.matchKeys)
    ? body.matchKeys
    : [];
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
