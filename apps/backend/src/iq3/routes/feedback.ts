import { Hono } from "hono";
import { Iq3FeedbackSchema, FEEDBACK_TEXT_MAX } from "@protege/types";
import { githubAuth } from "../../middleware/auth.js";

/**
 * Mounted at /iq/feedback. Anonymous "found something weird?" feedback
 * on Code IQ scoring.
 *
 * Auth gate stays on so callers must hold a verified GitHub Bearer
 * (cuts spam/abuse vectors), but the persisted row stores ONLY the
 * trimmed text and a server-stamped timestamp. The verified userId is
 * intentionally dropped — the feature exists so users can flag scoring
 * weirdness without their identity being attached to the complaint.
 *
 * Storage mirrors selfRating.ts: Supabase when both env vars are set,
 * else a local JSON file at the backend cwd (gitignored).
 */
const STORE_PATH = "./.protege-store-iq3-feedback.json";

const app = new Hono();

app.use("*", githubAuth());

app.post("/", async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { text?: unknown }
    | null;

  // Trim before length-validating so a textarea full of whitespace
  // can't sneak past min(1).
  const rawText = typeof body?.text === "string" ? body.text.trim() : "";
  const submittedAt = new Date().toISOString();

  const parsed = Iq3FeedbackSchema.safeParse({ text: rawText, submittedAt });
  if (!parsed.success) {
    return c.json(
      { error: "invalid", details: parsed.error.flatten() },
      400,
    );
  }

  // Defense in depth — schema already caps at FEEDBACK_TEXT_MAX, but
  // referencing the constant here makes the intent explicit at the
  // boundary and avoids a "well, why not 10MB" drift later.
  if (parsed.data.text.length > FEEDBACK_TEXT_MAX) {
    return c.json({ error: "text too long" }, 400);
  }

  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
    const { createClient } = await import("@supabase/supabase-js");
    const client = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY,
    );
    const { error } = await client.from("iq3_feedback").insert({
      text: parsed.data.text,
      submitted_at: parsed.data.submittedAt,
    });
    if (error) return c.json({ error: error.message }, 500);
  } else {
    const { writeFileSync, readFileSync, existsSync } = await import("node:fs");
    const arr = existsSync(STORE_PATH)
      ? (JSON.parse(readFileSync(STORE_PATH, "utf-8")) as Array<unknown>)
      : [];
    arr.push(parsed.data);
    writeFileSync(STORE_PATH, JSON.stringify(arr, null, 2));
  }

  return c.json({ ok: true });
});

export default app;
