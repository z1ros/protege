import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { chatRoute } from "./routes/chat.js";
import { analyzeRoute } from "./routes/analyze.js";
import { conceptRoute } from "./routes/concept.js";
import { meRoute } from "./routes/me.js";
import { testRoute } from "./routes/test.js";
import { ttsRoute, sttRoute } from "./routes/tts.js";
import { memoryRoute } from "./routes/memory.js";
import { voiceRoute } from "./routes/voice.js";
import { preferencesRoute } from "./routes/preferences.js";
import { echoRoute } from "./routes/echo.js";
import { registerEchoJobs } from "./echo/index.js";

const app = new Hono();

app.use("*", cors());

app.onError((err, c) => {
  console.error("[protege] error:", err);
  const message =
    err instanceof Error ? err.message : "Unknown error";
  return c.json({ error: message }, 500);
});

app.get("/", (c) => c.json({ name: "protege-backend", status: "ok" }));

app.post("/log", async (c) => {
  const { tag, msg } = (await c.req.json()) as { tag?: string; msg?: string };
  console.log(`[${tag ?? "ext"}] ${msg ?? ""}`);
  return c.json({ ok: true });
});

app.route("/test", testRoute);
app.route("/chat", chatRoute);
app.route("/analyze", analyzeRoute);
app.route("/concept-used", conceptRoute);
app.route("/me", meRoute);
app.route("/tts", ttsRoute);
app.route("/stt", sttRoute);
app.route("/memory", memoryRoute);
app.route("/voice", voiceRoute);
app.route("/preferences", preferencesRoute);
app.route("/echo", echoRoute);

// Echo nightly jobs — rollup, archetypeClassifier.
// Scaffolding only; widget agents fill in the real aggregation logic.
registerEchoJobs();

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port });
console.log(`[protege] backend listening on :${port}`);
