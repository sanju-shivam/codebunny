const express = require("express");
const { processReview } = require("../services/reviewProcessor");
const logger = require("../utils/logger");

const router = express.Router();

/**
 * POST /reviews/analyze
 *
 * Manually trigger a code review for a specific ClickUp task + branch.
 *
 * Body:
 *   {
 *     "taskId":     "abc123",         // ClickUp task ID (required)
 *     "branchName": "feature/xyz",    // Branch to review (required)
 *     "baseBranch": "main",           // Optional, defaults to GIT_DEFAULT_BRANCH
 *     "repoUrl":    "https://..."     // Optional, defaults to GIT_REPO_URL env
 *   }
 */
router.post("/analyze", express.json(), (req, res) => {
  const {
    taskId,
    task_id,
    branchName,
    branch_name,
    baseBranch,
    base_branch,
    repoUrl,
    repo_url,
  } = req.body;

  const resolvedTaskId = taskId || task_id;
  const resolvedBranch = branchName || branch_name;

  if (!resolvedTaskId) {
    return res.status(400).json({ error: "Missing taskId in request body" });
  }
  if (!resolvedBranch) {
    return res
      .status(400)
      .json({ error: "Missing branchName in request body" });
  }

  logger.info(
    `[API] Review requested for task ${resolvedTaskId}, branch ${resolvedBranch}`,
  );

  // Fire-and-forget the review pipeline
  processReview({
    taskId: resolvedTaskId,
    branchName: resolvedBranch,
    baseBranch: baseBranch || base_branch,
    repoUrl: repoUrl || repo_url,
  }).catch((err) => {
    logger.error(
      `[API] Error reviewing task ${resolvedTaskId}: ${err.message}`,
    );
  });

  res.status(202).json({
    message: "Review started",
    taskId: resolvedTaskId,
    branchName: resolvedBranch,
    status: "accepted",
  });
});

module.exports = router;
