import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { githubAuth, logAuthModeOnce } from "./middleware/auth.js";
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
import iqRouter, { setIq3UserStateRepo } from "./iq3/routes/iq.js";
import selfRatingRouter from "./iq3/routes/selfRating.js";
import feedbackRouter from "./iq3/routes/feedback.js";
import { autoRepo } from "./iq3/persistence.js";

const app = new Hono();

// CORS allowlist via env (comma-separated). Optional.
//
// Why optional: every authenticated route requires a valid GitHub Bearer
// token. The VS Code extension is a Node process and ignores CORS
// entirely, so its own calls work either way. The only unauthenticated
// routes are `GET /` (banner JSON) and `GET /healthz` (Railway probe) —
// neither leaks anything. So a wildcard `Access-Control-Allow-Origin`
// here doesn't grant a malicious page meaningful access; the auth gate
// is the real boundary.
//
// If a browser-side caller is ever added (marketing site, dashboard,
// etc.), set `PROTEGE_CORS_ORIGINS=https://foo.com,https://bar.com` in
// the Railway dashboard to lock the wildcard down to those origins. Add
// new unauthenticated routes only after thinking through this stance.
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

// Defensive backstop body cap. Per-route caps tighten this down where the
// real ceiling is smaller (e.g. /log at 32 KB, /tts at 64 KB). Sized to
// match Whisper's 25 MB upload ceiling so /stt audio uploads pass
// through; smaller caps on /stt + /chat enforce the actual limits.
//
// Hono runs app-level middleware before route-level, so this MUST stay
// >= the largest legitimate per-route cap (currently /stt at 10 MB).
// Setting it lower than a per-route cap silently shadows the route's
// override and 413s legitimate traffic.
app.use("*", bodyLimit({ maxSize: 25 * 1024 * 1024 }));

app.onError((err, c) => {
  console.error("[protege] error:", err);
  const message =
    err instanceof Error ? err.message : "Unknown error";
  return c.json({ error: message }, 500);
});

app.get("/", (c) => c.json({ name: "protege-backend", status: "ok" }));
app.get("/healthz", (c) => c.json({ status: "ok" }));

// Client log shipping — gated behind auth so anonymous callers can't
// flood our log stream or forge entries that look like real user
// activity. The handler stays small on purpose; everything else lives
// in the route-specific files.
app.post(
  "/log",
  bodyLimit({ maxSize: 32 * 1024 }),
  githubAuth(),
  async (c) => {
    const { tag, msg } = (await c.req.json()) as {
      tag?: string;
      msg?: string;
    };
    console.log(`[${tag ?? "ext"}] ${msg ?? ""}`);
    return c.json({ ok: true });
  }
);

// Wire the iq3 user-state repo before mounting routes. Without this,
// the first call to `/iq/me` throws "iq3 user-state repo not initialized".
// `autoRepo` picks Supabase when SUPABASE_URL + SUPABASE_SERVICE_KEY are
// set, else falls back to a local JSON store at the backend cwd
// (`.protege-store-iq3.json`, gitignored).
setIq3UserStateRepo(autoRepo());

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
app.route("/iq", iqRouter);
app.route("/iq/self-rating", selfRatingRouter);
app.route("/iq/feedback", feedbackRouter);

// Echo nightly jobs — rollup, archetypeClassifier.
// Scaffolding only; widget agents fill in the real aggregation logic.
registerEchoJobs();

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port });
console.log(`[protege] backend listening on :${port}`);
// Log auth mode so a misconfigured prod deploy with auth disabled
// shows up in startup logs (rather than silently flipping into
// open-IDOR mode). Production hard-codes auth=ON regardless of env,
// so this is informational there; the warning only fires in dev.
logAuthModeOnce();

// Quota subsystem startup probe. Logs explicitly whether Supabase is
// reachable, whether the `user_quotas` table exists, and whether
// enforcement is on. Without this, a misconfigured beta deployment
// fails silently — every panel shows 0/100 forever and the operator
// has to grep for clues. Now it's one log line on startup.
void (async () => {
  const { probeQuotaTable } = await import("./quotas.js");
  await probeQuotaTable();
})();
