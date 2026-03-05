const logger = require("../utils/logger");
const clickupService = require("./clickupService");
const reviewerService = require("./reviewerService");

// In-memory lock to prevent duplicate reviews for the same task
const activeReviews = new Set();

/**
 * Main review pipeline handler.
 *
 * Fetches the ClickUp task, retrieves the diff from the git provider,
 * runs the LLM reviewer, and posts the findings back to the ClickUp ticket.
 * It does NOT modify any code in the repo.
 *
 * @param {object} opts
 * @param {string} opts.taskId       ClickUp task ID
 * @param {string} opts.branchName   Branch to review
 * @param {string} [opts.baseBranch] Base branch to compare against (default: from env)
 * @param {string} [opts.repoUrl]    Repo URL (default: from env)
 */
async function processReview({ taskId, branchName, baseBranch, repoUrl }) {
  if (activeReviews.has(taskId)) {
    logger.warn(
      `[ReviewProcessor] Review for task ${taskId} is already in progress – skipping`,
    );
    return;
  }

  activeReviews.add(taskId);
  logger.info(`\n${"═".repeat(60)}`);
  logger.info(`[ReviewProcessor] Startin g review pipeline for task ${taskId}`);

  try {
    // ── Step 1: Resolve configuration ──────────────────────────────────────
    const repo =
      repoUrl || process.env.GIT_REPO_URL || process.env.GITHUB_REPO_URL;
    if (!repo) {
      throw new Error("Missing GIT_REPO_URL (or GITHUB_REPO_URL) in env");
    }

    const base = baseBranch || process.env.GIT_DEFAULT_BRANCH || "main";
    logger.info(`[ReviewProcessor] Repo: ${repo}`);
    logger.info(`[ReviewProcessor] Comparing: ${base}...${branchName}`);

    // ── Step 2: Fetch ClickUp task context ─────────────────────────────────
    const [task, comments] = await Promise.all([
      clickupService.getTask(taskId),
      clickupService.getTaskComments(taskId),
    ]);
    const taskSummary = clickupService.buildTaskSummary(task, comments);
    logger.info(`[ReviewProcessor] Task: "${task.name}"`);

    // ── Step 3: Fetch the diff from git provider ──────────────────────────
    logger.info(`[ReviewProcessor] Fetching diff…`);
    const diff = await reviewerService.fetchDiff(repo, branchName, base);

    if (!diff || diff === "No changes found.") {
      logger.info(
        `[ReviewProcessor] No changes detected between ${base} and ${branchName}`,
      );
      await clickupService.postComment(
        taskId,
        `🔍 **Automated Code Review**\n\nNo code changes detected between \`${base}\` and \`${branchName}\`. Nothing to review.`,
      );
      return;
    }

    logger.info(`[ReviewProcessor] Diff fetched (${diff.length} chars)`);

    // ── Step 4: Build the review prompt ───────────────────────────────────
    const prompt = reviewerService.buildReviewPrompt({
      diff,
      taskSummary,
      branchName,
    });

    // ── Step 5: Run the LLM reviewer ──────────────────────────────────────
    logger.info(`[ReviewProcessor] Running LLM reviewer…`);
    const reviewOutput = await reviewerService.runReviewAgent({
      prompt,
      taskId,
    });
    logger.info(
      `[ReviewProcessor] Review complete (${reviewOutput.length} chars)`,
    );

    // ── Step 6: Post findings to ClickUp ──────────────────────────────────
    const comment = reviewerService.formatReviewComment(
      reviewOutput,
      branchName,
    );
    await clickupService.postComment(taskId, comment);
    logger.info(`[ReviewProcessor] Review posted to ClickUp task ${taskId} ✅`);
  } catch (err) {
    logger.error(
      `[ReviewProcessor] Review failed for task ${taskId}: ${err.message}`,
      err,
    );

    // Try to leave a failure comment so the team knows
    try {
      await clickupService.postComment(
        taskId,
        `⚠️ **Code Review Agent** encountered an error:\n\`\`\`\n${err.message}\n\`\`\``,
      );
    } catch (_) {
      /* best-effort */
    }
  } finally {
    activeReviews.delete(taskId);
  }
}

/**
 * Local review pipeline — runs on the local repo BEFORE commit/push.
 *
 * Called by taskProcessor between the agent run and the push step.
 * Uses simple-git to diff locally, avoiding an extra round-trip to the remote.
 *
 * @param {object} opts
 * @param {string} opts.taskId       ClickUp task ID
 * @param {string} opts.localPath    Absolute path to the local repo clone
 * @param {string} opts.branchName   Current feature branch
 * @param {string} opts.baseBranch   Base branch (e.g. "main")
 * @param {string} opts.taskSummary  ClickUp task summary (markdown)
 * @returns {Promise<string|null>}   The review output, or null if nothing to review
 */
async function processLocalReview({
  taskId,
  localPath,
  branchName,
  baseBranch,
  taskSummary,
}) {
  logger.info(
    `[ReviewProcessor] Running local pre-push review for task ${taskId}`,
  );

  try {
    // ── Step 1: Get local diff ────────────────────────────────────────────
    const diff = await reviewerService.fetchLocalDiff(localPath, baseBranch);

    if (!diff || diff === "No changes found.") {
      logger.info(
        `[ReviewProcessor] No local changes detected — skipping review`,
      );
      return null;
    }

    logger.info(`[ReviewProcessor] Local diff size: ${diff.length} chars`);

    // ── Step 2: Build the review prompt ───────────────────────────────────
    const prompt = reviewerService.buildReviewPrompt({
      diff,
      taskSummary,
      branchName,
    });

    // ── Step 3: Run the LLM reviewer ──────────────────────────────────────
    logger.info(`[ReviewProcessor] Running LLM reviewer on local changes…`);
    const reviewOutput = await reviewerService.runReviewAgent({
      prompt,
      taskId,
    });
    logger.info(
      `[ReviewProcessor] Local review complete (${reviewOutput.length} chars)`,
    );

    // ── Step 4: Post findings to ClickUp ──────────────────────────────────
    const comment = reviewerService.formatReviewComment(
      reviewOutput,
      branchName,
    );
    await clickupService.postComment(taskId, comment);
    logger.info(
      `[ReviewProcessor] Local review posted to ClickUp task ${taskId} ✅`,
    );

    return reviewOutput;
  } catch (err) {
    logger.error(
      `[ReviewProcessor] Local review failed for task ${taskId}: ${err.message}`,
      err,
    );

    try {
      await clickupService.postComment(
        taskId,
        `⚠️ **Code Review Agent** encountered an error during pre-push review:\n\`\`\`\n${err.message}\n\`\`\``,
      );
    } catch (_) {
      /* best-effort */
    }

    return null;
  }
}

module.exports = { processReview, processLocalReview };
