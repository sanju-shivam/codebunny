const axios = require("axios");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const simpleGit = require("simple-git");
const logger = require("../utils/logger");

// ── GitHub Diff Fetching ─────────────────────────────────────────────────────

/**
 * Parse owner and repo name from a GitHub URL.
 */
function parseGitHubRepo(repoUrl) {
  const match = repoUrl.match(
    /github\.com[/:]+([\w.-]+)\/([\w.-]+?)(?:\.git)?$/,
  );
  if (!match)
    throw new Error(`Cannot parse GitHub owner/repo from: ${repoUrl}`);
  return { owner: match[1], repo: match[2] };
}

/**
 * Parse project path from a GitLab URL.
 */
function parseGitLabRepo(repoUrl) {
  const match = repoUrl.match(/gitlab\.com[/:]+([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
  if (!match) throw new Error(`Cannot parse GitLab project from: ${repoUrl}`);
  return { projectPath: match[1] };
}

/**
 * Fetch the unified diff for a branch compared to a base branch from GitHub.
 *
 * @param {string} repoUrl       Repository URL
 * @param {string} branchName    The feature/head branch
 * @param {string} baseBranch    The base branch (e.g. "main")
 * @returns {Promise<string>}    Unified diff as text
 */
async function fetchGitHubDiff(repoUrl, branchName, baseBranch) {
  const { owner, repo } = parseGitHubRepo(repoUrl);
  logger.info(
    `[Reviewer] Fetching GitHub diff: ${baseBranch}...${branchName} for ${owner}/${repo}`,
  );

  const gh = axios.create({
    baseURL: "https://api.github.com",
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github.v3.diff", // Request raw diff format
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  const { data } = await gh.get(
    `/repos/${owner}/${repo}/compare/${baseBranch}...${branchName}`,
  );
  return data; // raw diff string when using .diff Accept header
}

/**
 * Fetch the unified diff for a branch compared to a base branch from GitLab.
 *
 * @param {string} repoUrl       Repository URL
 * @param {string} branchName    The feature/head branch
 * @param {string} baseBranch    The base branch (e.g. "main")
 * @returns {Promise<string>}    Unified diff as text
 */
async function fetchGitLabDiff(repoUrl, branchName, baseBranch) {
  const { projectPath } = parseGitLabRepo(repoUrl);
  const encodedProject = encodeURIComponent(projectPath);
  logger.info(
    `[Reviewer] Fetching GitLab diff: ${baseBranch}...${branchName} for ${projectPath}`,
  );

  const gl = axios.create({
    baseURL: "https://gitlab.com/api/v4",
    headers: {
      "PRIVATE-TOKEN": process.env.GITLAB_TOKEN,
    },
  });

  // GitLab compare endpoint returns diffs
  const { data } = await gl.get(
    `/projects/${encodedProject}/repository/compare`,
    { params: { from: baseBranch, to: branchName } },
  );

  // Build a unified-diff-like string from the compare response
  if (!data.diffs || data.diffs.length === 0) {
    return "No changes found.";
  }

  let unifiedDiff = "";
  for (const diff of data.diffs) {
    unifiedDiff += `diff --git a/${diff.old_path} b/${diff.new_path}\n`;
    if (diff.new_file) unifiedDiff += `new file\n`;
    if (diff.deleted_file) unifiedDiff += `deleted file\n`;
    if (diff.renamed_file) unifiedDiff += `renamed from ${diff.old_path}\n`;
    unifiedDiff += `${diff.diff}\n`;
  }

  return unifiedDiff;
}

/**
 * Fetch the diff for a branch vs its base, auto-detecting the provider.
 *
 * @param {string} repoUrl       Repository URL
 * @param {string} branchName    Head branch
 * @param {string} baseBranch    Base branch
 * @returns {Promise<string>}    Unified diff text
 */
async function fetchDiff(repoUrl, branchName, baseBranch) {
  if (repoUrl.includes("gitlab.com")) {
    return fetchGitLabDiff(repoUrl, branchName, baseBranch);
  }
  return fetchGitHubDiff(repoUrl, branchName, baseBranch);
}

// ── Local Diff (pre-push) ────────────────────────────────────────────────────

/**
 * Fetch the diff from a local repo against the base branch.
 * This runs BEFORE push, so it captures all local changes (committed and staged)
 * on the current branch that are not yet on the base branch.
 *
 * @param {string} localPath    Absolute path to the local repo clone
 * @param {string} baseBranch   Base branch to compare against (e.g. "main")
 * @returns {Promise<string>}   Unified diff text
 */
async function fetchLocalDiff(localPath, baseBranch) {
  const git = simpleGit(localPath);
  const base = baseBranch || process.env.GIT_DEFAULT_BRANCH || "main";

  logger.info(`[Reviewer] Fetching local diff: ${base}..HEAD in ${localPath}`);

  // First, stage any unstaged changes so they show up in the diff
  // (the builder agent may not have staged everything yet)
  try {
    await git.add(".");
  } catch (_) {
    // non-fatal — there might be nothing to stage
  }

  // Diff all commits + staged changes on current branch vs base branch
  const diff = await git.diff([`origin/${base}...HEAD`]);

  // Also capture any remaining unstaged changes on top
  const stagedDiff = await git.diff(["--cached"]);

  const fullDiff = [diff, stagedDiff].filter(Boolean).join("\n");

  if (!fullDiff || fullDiff.trim().length === 0) {
    return "No changes found.";
  }

  return fullDiff;
}

// ── LLM Review Analysis ─────────────────────────────────────────────────────

/**
 * Build the review prompt for the LLM.
 *
 * @param {object} opts
 * @param {string} opts.diff           The unified diff text
 * @param {string} opts.taskSummary    ClickUp task context (markdown)
 * @param {string} opts.branchName     Branch being reviewed
 * @returns {string}                   Full prompt text
 */
function buildReviewPrompt({ diff, taskSummary, branchName }) {
  return `You are an expert senior code reviewer. Your job is to analyze the
code changes (diff) below and identify ONLY potential issues, bugs, security
vulnerabilities, performance problems, or logic errors introduced by these changes.

## Rules

1. **Only review the changed lines** — do NOT comment on pre-existing code that
   was not modified.
2. **Do NOT rewrite or fix the code.** Only describe the issue and why it is
   problematic.
3. Categorise each finding as one of: 🐛 Bug, ⚠️ Warning, 🔒 Security,
   🚀 Performance, 💡 Suggestion.
4. For each finding, include:
   - The file name and approximate line number(s).
   - A clear, concise description of the issue.
   - The potential impact if left unfixed.
5. If there are NO issues, respond with: "✅ No issues found — the changes look clean."
6. Format your output as a numbered markdown list. Keep it concise and actionable.

---

## Task Context

${taskSummary}

---

## Branch Under Review

\`${branchName}\`

---

## Code Changes (Diff)

\`\`\`diff
${diff}
\`\`\`

---

Begin your review now.
`.trim();
}

/**
 * Run the review prompt through the configured LLM agent CLI and capture output.
 *
 * @param {object} opts
 * @param {string} opts.prompt     The review prompt
 * @param {string} opts.taskId     ClickUp task ID (for logging)
 * @returns {Promise<string>}      The LLM's review output
 */
function runReviewAgent({ prompt, taskId }) {
  return new Promise((resolve, reject) => {
    const logsDir = path.join(process.cwd(), "logs", "reviewer");
    fs.mkdirSync(logsDir, { recursive: true });

    // Write the prompt to a temp file
    const promptFile = path.join(logsDir, `review-prompt-${taskId}.md`);
    fs.writeFileSync(promptFile, prompt, "utf8");

    const agentCli = process.env.AGENT_CLI || "opencode";
    let cmd, args;

    if (agentCli === "opencode") {
      cmd = process.env.OPENCODE_PATH || "opencode";
      const model = process.env.OPENCODE_MODEL || "opencode/minimax-m2.5-free";
      args = [
        "run",
        "Read the review instructions from the attached file and output your code review findings.",
        "--model",
        model,
        "--file",
        promptFile,
      ];
    } else if (agentCli === "claude") {
      cmd = "claude";
      args = ["-p", promptFile];
    } else if (agentCli === "gemini") {
      cmd = "gemini";
      args = ["-p", promptFile];
    } else {
      return reject(new Error(`Unknown AGENT_CLI: ${agentCli}`));
    }

    logger.info(`[Reviewer] Spawning LLM: ${cmd} ${args.join(" ")}`);

    const logStream = fs.createWriteStream(
      path.join(logsDir, `review-session-${taskId}.log`),
      { flags: "a" },
    );

    let output = "";

    const child = spawn(cmd, args, {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.pipe(logStream);
    child.stderr.pipe(logStream);

    child.stdout.on("data", (d) => {
      output += d.toString();
    });

    child.stderr.on("data", (d) => {
      logger.warn(`[Reviewer stderr] ${d.toString().trim()}`);
    });

    child.on("close", (code) => {
      logStream.close();
      if (code === 0) {
        logger.info(`[Reviewer] LLM process exited cleanly for task ${taskId}`);
        resolve(output.trim());
      } else {
        reject(
          new Error(`Reviewer LLM exited with code ${code} for task ${taskId}`),
        );
      }
    });

    child.on("error", (err) => {
      logStream.close();
      reject(err);
    });
  });
}

/**
 * Format the LLM review output into a ClickUp-friendly comment.
 *
 * @param {string} reviewOutput    Raw LLM output
 * @param {string} branchName      Branch that was reviewed
 * @returns {string}               Formatted comment text
 */
function formatReviewComment(reviewOutput, branchName) {
  const lines = [
    `🔍 **Automated Code Review** — Branch: \`${branchName}\``,
    ``,
    `---`,
    ``,
    reviewOutput,
    ``,
    `---`,
    ``,
    `_This review was generated automatically by CodeBunny Reviewer Agent._`,
  ];
  return lines.join("\n");
}

module.exports = {
  fetchDiff,
  fetchLocalDiff,
  buildReviewPrompt,
  runReviewAgent,
  formatReviewComment,
};
