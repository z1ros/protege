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
import { classifyRoute } from "./routes/classify.js";
import { verifyRoute } from "./routes/verify.js";
import { conceptTipsRoute } from "./routes/conceptTips.js";
import { walkRoute } from "./routes/walk.js";
import { notesRoute } from "./routes/notes.js";
import { chatHistoryRoute } from "./routes/chatHistory.js";

const app = new Hono();

// CORS allowlist via env (comma-separated). Empty/unset = allow all
// origins, which is fine because every protected route is gated by the
// GitHub Bearer auth middleware. Set PROTEGE_CORS_ORIGINS in production
// to lock the browser-callable surface to known origins.
const corsOrigins = process.env.PROTEGE_CORS_ORIGINS
  ?.split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  "*",
  cors({
    origin: corsOrigins && corsOrigins.length > 0 ? corsOrigins : "*",
    allowHeaders: ["Authorization", "Content-Type", "X-Protege-Reason"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    exposeHeaders: ["X-Protege-Tts"],
  })
);

app.onError((err, c) => {
  console.error("[protege] error:", err);
  const message =
    err instanceof Error ? err.message : "Unknown error";
  return c.json({ error: message }, 500);
});

app.get("/", (c) => c.json({ name: "protege-backend", status: "ok" }));
app.get("/healthz", (c) => c.json({ status: "ok" }));

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
app.route("/classify", classifyRoute);
app.route("/verify", verifyRoute);
app.route("/concept-tips", conceptTipsRoute);
app.route("/walk", walkRoute);
app.route("/notes", notesRoute);
app.route("/chat-history", chatHistoryRoute);

// Echo nightly jobs — rollup, archetypeClassifier.
// Scaffolding only; widget agents fill in the real aggregation logic.
registerEchoJobs();

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port });
console.log(`[protege] backend listening on :${port}`);

// Quota subsystem startup probe. Logs explicitly whether Supabase is
// reachable, whether the `user_quotas` table exists, and whether
// enforcement is on. Without this, a misconfigured beta deployment
// fails silently — every panel shows 0/100 forever and the operator
// has to grep for clues. Now it's one log line on startup.
void (async () => {
  const { probeQuotaTable } = await import("./quotas.js");
  await probeQuotaTable();
})();
