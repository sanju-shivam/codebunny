const logger = require("../utils/logger");
const clickupService = require("./clickupService");
const gitService = require("./gitService");
const agentService = require("./agentService");
const gitProviderService = require("./gitProviderService");
const { processLocalReview } = require("./reviewProcessor");

// In-memory lock to prevent duplicate runs for the same task
const activeTasks = new Set();

/**
 * Main pipeline handler.  Called when a task-assignment event is received.
 *
 * @param {string} taskId
 */
async function processTaskAssignment(taskId) {
  if (activeTasks.has(taskId)) {
    logger.warn(
      `[Processor] Task ${taskId} is already being processed – skipping duplicate`,
    );
    return;
  }

  activeTasks.add(taskId);
  logger.info(`\n${"=".repeat(60)}`);
  logger.info(`[Processor] Starting pipeline for task ${taskId}`);

  try {
    // ── Step 1: Fetch task details ───────────────────────────────────────────
    const [task, comments] = await Promise.all([
      clickupService.getTask(taskId),
      clickupService.getTaskComments(taskId),
    ]);
    logger.info(`[Processor] Task: "${task.name}"`);

    // ── Step 2: Resolve repo URL ─────────────────────────────────────────────
    const repoUrl = process.env.GIT_REPO_URL || process.env.GITHUB_REPO_URL;
    if (!repoUrl) {
      throw new Error(`Missing GIT_REPO_URL (or GITHUB_REPO_URL) in env`);
    }
    logger.info(`[Processor] Repo URL: ${repoUrl}`);

    // ── Step 3: Ensure local clone ───────────────────────────────────────────
    const repoCtx = await gitService.ensureRepo(repoUrl);

    // ── Step 4: Create feature branch ───────────────────────────────────────
    const branchName = gitService.buildBranchName(task);
    await gitService.checkoutBranch(repoCtx, branchName);
    logger.info(`[Processor] On branch: ${branchName}`);

    // ── Step 5: Build prompt ─────────────────────────────────────────────────
    const taskSummary = clickupService.buildTaskSummary(task, comments);
    const baseBranch = process.env.GIT_DEFAULT_BRANCH || "main";
    const prompt = agentService.buildPrompt({
      taskSummary,
      branchName,
      repoUrl,
      baseBranch,
    });

    // ── Step 6: Run Agent ─────────────────────────────────────────────────
    logger.info(`[Processor] Launching Agent…`);
    await agentService.runAgent({
      localPath: repoCtx.localPath,
      prompt,
      taskId,
    });

    // ── Step 6.5: Run local review BEFORE push ──────────────────────────────
    logger.info(`[Processor] Running reviewer agent on local changes…`);
    await processLocalReview({
      taskId,
      localPath: repoCtx.localPath,
      branchName,
      baseBranch,
      taskSummary,
    });

    // ── Step 7: Push branch (if AUTO_CREATE_PR is false, agent didn't push) ─
    const autoPR = process.env.AUTO_CREATE_PR !== "false";
    if (!autoPR) {
      await gitService.pushBranch(repoCtx, branchName);
    }

    // ── Step 8: Create PR/MR (optional – agent may have done it itself) ───────
    let prUrl = null;
    if (autoPR && (process.env.GITHUB_TOKEN || process.env.GITLAB_TOKEN)) {
      try {
        prUrl = await gitProviderService.createPullRequest({
          repoUrl,
          branchName,
          baseBranch,
          title: `[CU-${task.id}] ${task.name}`,
          body: `## ClickUp Task\n\n[${task.name}](${task.url})\n\n## Summary\n\nAutomatically implemented by Agent.\n\n${taskSummary.substring(0, 1000)}`,
        });
      } catch (prErr) {
        // PR may already exist (agent created it) – non-fatal
        logger.warn(`[Processor] PR creation skipped: ${prErr.message}`);
      }
    }

    // ── Step 9: Post comment back to ClickUp ─────────────────────────────────
    const comment = [
      `🤖 **Agent** has processed this task.`,
      ``,
      `- **Branch:** \`${branchName}\``,
      prUrl ? `- **Draft PR:** ${prUrl}` : "",
      `- **Local path:** \`${repoCtx.localPath}\``,
    ]
      .filter(Boolean)
      .join("\n");

    await clickupService.postComment(taskId, comment);
    logger.info(`[Processor] Pipeline complete for task ${taskId} ✅`);
  } catch (err) {
    logger.error(
      `[Processor] Pipeline failed for task ${taskId}: ${err.message}`,
      err,
    );

    // Try to leave a failure comment so the team knows
    try {
      await clickupService.postComment(
        taskId,
        `⚠️ **Agent** encountered an error:\n\`\`\`\n${err.message}\n\`\`\``,
      );
    } catch (_) {
      /* best-effort */
    }
  } finally {
    activeTasks.delete(taskId);
  }
}

module.exports = { processTaskAssignment };
