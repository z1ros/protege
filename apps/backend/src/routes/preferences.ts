import { Hono } from "hono";
import {
  getCloudPreferences,
  saveCloudPreferences,
  isSupabaseEnabled,
} from "../supabase.js";

/**
 * Preferences route — cross-device settings the extension wants to sync.
 *
 * Stored as a JSONB column on the `users` table (see Architecture/
 * supabase-schema.sql → `preferences`). Schema-less on purpose: the
 * extension reads/writes named keys without the backend knowing their
 * shape. Today's keys: `aiBackend`. Tomorrow's: whatever the client
 * decides.
 *
 * Falls back to a no-op 200 when Supabase isn't configured so the local
 * JSON store dev workflow keeps working.
 */

export const preferencesRoute = new Hono();

preferencesRoute.get("/", async (c) => {
  const userId =
    c.req.query("userId") ?? c.req.header("x-user-id") ?? "local-dev";

  if (!isSupabaseEnabled()) {
    return c.json({ preferences: {} });
  }

  try {
    const preferences = await getCloudPreferences(userId);
    return c.json({ preferences });
  } catch (err) {
    console.warn("[protege] GET /preferences failed:", err);
    return c.json({ preferences: {} });
  }
});

preferencesRoute.patch("/", async (c) => {
  const userId =
    c.req.query("userId") ?? c.req.header("x-user-id") ?? "local-dev";

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (!body || typeof body !== "object") {
    return c.json({ error: "body must be an object of preference key/value pairs" }, 400);
  }

  if (!isSupabaseEnabled()) {
    // No-op in local dev — client persistence via globalState still works.
    return c.json({ ok: true, synced: false });
  }

  try {
    await saveCloudPreferences(userId, body as Record<string, unknown>);
    return c.json({ ok: true, synced: true });
  } catch (err) {
    console.warn("[protege] PATCH /preferences failed:", err);
    return c.json({ error: "cloud sync failed" }, 500);
  }
});
