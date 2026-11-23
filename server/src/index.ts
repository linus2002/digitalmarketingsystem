import fs from "node:fs";
import path from "node:path";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import { env, isProd } from "./config/env.js";
import { pool } from "./lib/db.js";
import { log, errMsg } from "./lib/logger.js";
import { authenticate } from "./middleware/auth.js";
import { errorHandler } from "./middleware/error.js";
import { migrate } from "./db/migrate.js";
import { startJobs, stopJobs } from "./services/jobs.js";
import { authRouter } from "./routes/auth.js";
import { usersRouter } from "./routes/users.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { trendsRouter } from "./routes/trends.js";
import { analyticsRouter } from "./routes/analytics.js";
import { studioRouter } from "./routes/studio.js";
import { postsRouter } from "./routes/posts.js";
import { campaignsRouter } from "./routes/campaigns.js";
import { reportsRouter } from "./routes/reports.js";
import { logsRouter } from "./routes/logs.js";
import { leadsRouter } from "./routes/leads.js";
import { templatesRouter } from "./routes/templates.js";
import { settingsRouter } from "./routes/settings.js";
import { publicRouter } from "./routes/public.js";
import { metaWebhookRouter } from "./routes/webhooks.js";
import { botsRouter } from "./routes/bots.js";
import { notesRouter, notificationsRouter } from "./routes/notifications.js";
import { statusRouter } from "./routes/status.js";

const app = express();
if (env.TRUST_PROXY) app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(
  helmet({
    contentSecurityPolicy: isProd
      ? {
          directives: {
            "default-src": ["'self'"],
            "img-src": ["'self'", "data:", "https:"],
            "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            "font-src": ["'self'", "https://fonts.gstatic.com"],
            "connect-src": ["'self'"],
          },
        }
      : false,
  }),
);

// Messenger webhook needs the raw body for signature checks, so it's mounted before the JSON parser.
app.use("/api/webhooks/meta", express.raw({ type: "*/*", limit: "1mb" }), metaWebhookRouter);

app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

app.use("/api/public", cors({ origin: env.PUBLIC_FORM_ORIGINS, methods: ["GET", "POST"] }), publicRouter);

app.get("/api/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, db: "up" });
  } catch {
    res.status(503).json({ ok: false, db: "down" });
  }
});

app.use("/api/auth", authRouter);

// Everything below requires a signed-in user.
app.use("/api", authenticate);
app.use("/api/status", statusRouter);
app.use("/api/dashboard", dashboardRouter);
app.use("/api/users", usersRouter);
app.use("/api/trends", trendsRouter);
app.use("/api/analytics", analyticsRouter);
app.use("/api/studio", studioRouter);
app.use("/api/posts", postsRouter);
app.use("/api/campaigns", campaignsRouter);
app.use("/api/reports", reportsRouter);
app.use("/api/logs", logsRouter);
app.use("/api/leads", leadsRouter);
app.use("/api/templates", templatesRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/bots", botsRouter);
app.use("/api/notifications", notificationsRouter);
app.use("/api/notes", notesRouter);
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "No such API endpoint." });
});

// In production the API also serves the built React app.
const clientDist = path.resolve(import.meta.dirname, "../../client/dist");
if (isProd && fs.existsSync(clientDist)) {
  app.use(express.static(clientDist, { index: false, maxAge: "1h" }));
  app.get("/{*splat}", (_req, res) => res.sendFile(path.join(clientDist, "index.html")));
}

app.use(errorHandler);

async function main() {
  try {
    await pool.query("SELECT 1");
  } catch (err) {
    log.error("Can't connect to PostgreSQL. Check DATABASE_URL in .env and that PostgreSQL is running.", { error: errMsg(err) });
    process.exit(1);
  }
  await migrate();
  const server = app.listen(env.PORT, env.HOST, () => {
    log.info(`API listening on http://${env.HOST}:${env.PORT}`, { env: env.NODE_ENV });
  });
  startJobs();
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    log.info("Shutting down");
    stopJobs(); // also cancels the one-off startup runs that haven't fired yet
    server.close(() => pool.end().then(() => process.exit(0)));
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

process.on("unhandledRejection", (err) => log.error("Unhandled promise rejection", { error: errMsg(err) }));

void main();
