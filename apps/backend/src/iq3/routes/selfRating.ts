import { Hono } from "hono";
import { SelfRatingSchema } from "@protege/types";

const app = new Hono();

app.post("/", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = SelfRatingSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid", details: parsed.error.flatten() }, 400);
  }
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
    const { createClient } = await import("@supabase/supabase-js");
    const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { error } = await client.from("iq3_self_ratings").insert({
      user_id: parsed.data.userId,
      rating: parsed.data.rating,
      rated_at: parsed.data.ratedAt,
      note: parsed.data.note,
    });
    if (error) return c.json({ error: error.message }, 500);
  } else {
    const { writeFileSync, readFileSync, existsSync } = await import("node:fs");
    const path = "./.protege-store-iq3-self-ratings.json";
    const arr = existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : [];
    arr.push(parsed.data);
    writeFileSync(path, JSON.stringify(arr, null, 2));
  }
  return c.json({ ok: true });
});

export default app;
