import { Hono } from "hono";
import { callOneShot, getProvider } from "../llm.js";

export const testRoute = new Hono();

testRoute.get("/", async (c) => {
  const provider = getProvider();
  const apiKey =
    provider === "openai"
      ? process.env.OPENAI_API_KEY
      : process.env.ANTHROPIC_API_KEY;
  const keyPreview = apiKey
    ? `${apiKey.slice(0, 11)}…${apiKey.slice(-4)}`
    : "(missing)";

  const result = {
    provider,
    model: "" as string,
    key: keyPreview,
    keyLength: apiKey?.length ?? 0,
    ok: false as boolean,
    reply: "" as string,
    error: null as string | null,
    usage: null as unknown,
    ms: 0 as number,
  };

  const started = Date.now();
  try {
    const { text, usage, modelUsed } = await callOneShot({
      userText: "Reply with exactly: pong",
      maxTokens: 64,
      cacheSystem: false,
    });
    result.ok = true;
    result.reply = text;
    result.usage = usage;
    result.model = modelUsed;
  } catch (err) {
    result.ok = false;
    result.error = err instanceof Error ? err.message : String(err);
  }
  result.ms = Date.now() - started;
  return c.json(result);
});
