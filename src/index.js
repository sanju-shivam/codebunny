require("dotenv").config();

const express = require("express");
const fs = require("fs");
const logger = require("./utils/logger");
const clickupWebhook = require("./webhooks/clickup");
const tasksRouter = require("./routes/tasks");
const reviewsRouter = require("./routes/reviews");

// Ensure log directories exist
["logs", "logs/agent", "logs/reviewer"].forEach((d) =>
  fs.mkdirSync(d, { recursive: true }),
);

const app = express();
const PORT = process.env.PORT || 3000;
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || "/webhooks/clickup";

// ── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (_req, res) =>
  res.json({ status: "ok", ts: new Date().toISOString() }),
);

// ── ClickUp routes ───────────────────────────────────────────────────────────
app.use(WEBHOOK_PATH, clickupWebhook);
app.use("/tasks", tasksRouter);
app.use("/reviews", reviewsRouter);

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: "Not found" }));

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  logger.error(err);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, async () => {
  logger.info(`╔═══════════════════════════════════════════════════════╗`);
  logger.info(`║           CodeBunny Agent  🚀                         ║`);
  logger.info(`╚═══════════════════════════════════════════════════════╝`);
  logger.info(`Server listening on port ${PORT}`);
  logger.info(`Webhook endpoint: POST ${WEBHOOK_PATH}`);
  logger.info(`Health check:     GET  /health`);

  if (!process.env.CLICKUP_API_TOKEN) {
    logger.warn("⚠  CLICKUP_API_TOKEN is not set – API calls will fail");
  }
  if (!process.env.GITHUB_TOKEN && !process.env.GITLAB_TOKEN) {
    logger.warn(
      "⚠  Neither GITHUB_TOKEN nor GITLAB_TOKEN is set – private repo cloning and PR/MR creation will fail",
    );
  }
});

module.exports = app; // for testing
