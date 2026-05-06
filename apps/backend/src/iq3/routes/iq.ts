import { Hono } from "hono";
import type { Iq3UserState } from "@protege/types";
import { computeHeadline } from "../composite.js";
import { initialUserState } from "../hmm.js";
import { FALLBACK_DISTRIBUTION } from "../cohort.js";
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

app.get("/me", async (c) => {
  const userId = c.req.header("x-user-id") ?? c.req.query("userId");
  if (!userId) return c.json({ error: "missing userId" }, 400);
  const existing = await repo().load(userId);
  const state = existing ?? initialUserState(userId);
  if (!existing) await repo().save(state);
  const headline = computeHeadline(state, FALLBACK_DISTRIBUTION);
  return c.json({ headline });
});

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

export default app;
