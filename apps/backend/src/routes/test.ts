import { Hono } from "hono";
import { anthropic, MODEL as ANTHROPIC_MODEL } from "../anthropic.js";

export const testRoute = new Hono();

testRoute.get("/", async (c) => {
  const keyPreview = process.env.ANTHROPIC_API_KEY
    ? `${process.env.ANTHROPIC_API_KEY.slice(0, 11)}…${process.env.ANTHROPIC_API_KEY.slice(-4)}`
    : "(missing)";

  const result = {
    provider: "anthropic",
    model: ANTHROPIC_MODEL,
    key: keyPreview,
    keyLength: process.env.ANTHROPIC_API_KEY?.length ?? 0,
    ok: false as boolean,
    reply: "" as string,
    error: null as string | null,
    usage: null as unknown,
    ms: 0 as number,
  };

  const started = Date.now();
  try {
    const res = await anthropic.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 64,
      messages: [{ role: "user", content: "Reply with exactly: pong" }],
    });
    result.ok = true;
    const textBlock = res.content.find((b) => b.type === "text");
    result.reply = textBlock && textBlock.type === "text" ? textBlock.text : "";
    result.usage = res.usage;
  } catch (err) {
    result.ok = false;
    result.error = err instanceof Error ? err.message : String(err);
  }
  result.ms = Date.now() - started;
  return c.json(result);
});
