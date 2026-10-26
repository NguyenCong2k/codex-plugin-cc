import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { ensureGitRepository, getRepoRoot } from "./git.mjs";
import { formatCommandFailure, runCommand } from "./process.mjs";

function branchExists(repoRoot, ref) {
  return runCommand("git", ["show-ref", "--verify", "--quiet", ref], { cwd: repoRoot }).status === 0;
}

export function validateWorktreeBranch(repoRoot, branch) {
  const name = String(branch ?? "").trim();
  if (!name) {
    throw new Error("--worktree requires a branch name.");
  }
  const result = runCommand("git", ["check-ref-format", "--branch", name], { cwd: repoRoot });
  if (result.status !== 0) {
    throw new Error(`Invalid worktree branch name: ${name}`);
  }
  return name;
}

export function worktreePathFor(repoRoot, branch, options = {}) {
  const env = options.env ?? process.env;
  const slug = branch
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "worktree";
  const token = crypto.createHash("sha256").update(branch).digest("hex").slice(0, 8);
  const root = options.root
    ? path.resolve(options.root)
    : env.CODEX_COMPANION_WORKTREE_HOME
      ? path.resolve(env.CODEX_COMPANION_WORKTREE_HOME)
      : path.join(repoRoot, ".claude", "worktrees");
  return path.join(root, `${slug}-${token}`);
}

function existingWorktreeBranch(target) {
  const branch = runCommand("git", ["branch", "--show-current"], { cwd: target });
  return branch.status === 0 ? branch.stdout.trim() : "";
}

function worktreeCheckoutState(target) {
  if (!fs.existsSync(path.join(target, ".git"))) {
    return { valid: false, branch: "" };
  }
  const top = runCommand("git", ["rev-parse", "--show-toplevel"], { cwd: target });
  if (top.status !== 0 || path.resolve(top.stdout.trim()) !== path.resolve(target)) {
    return { valid: false, branch: "" };
  }
  return { valid: true, branch: existingWorktreeBranch(target) };
}

/**
 * Create (or reuse) an isolated git worktree for a write-capable job. The
 * branch name and path are passed as argv, never through a shell, so spaces,
 * ampersands and Vietnamese characters survive on Windows.
 */
export function createJobWorktree(repoRoot, branch, options = {}) {
  ensureGitRepository(repoRoot);
  const root = getRepoRoot(repoRoot);
  const name = validateWorktreeBranch(root, branch);
  const target = worktreePathFor(root, name, options);

  if (fs.existsSync(target)) {
    const checkout = worktreeCheckoutState(target);
    if (checkout.valid) {
      if (checkout.branch !== name) {
        throw new Error(`Worktree path already exists for a different branch: ${target} (current: ${checkout.branch})`);
      }
      return { path: target, branch: name, repoRoot: root, created: false };
    }
    // An interrupted `git worktree add` can leave an empty or partial folder.
    // The path is derived from the branch and token, so it belongs to this job;
    // remove it and prune any stale metadata before creating the checkout.
    fs.rmSync(target, { recursive: true, force: true });
    runCommand("git", ["worktree", "prune"], { cwd: root });
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  let args;
  if (branchExists(root, `refs/heads/${name}`)) {
    args = ["worktree", "add", target, name];
  } else if (branchExists(root, `refs/remotes/origin/${name}`)) {
    args = ["worktree", "add", "--track", "-b", name, target, `origin/${name}`];
  } else {
    args = ["worktree", "add", "-b", name, target, "HEAD"];
  }

  const result = runCommand("git", args, { cwd: root, timeout: 120000 });
  if (result.status !== 0) {
    throw new Error(`git worktree add failed: ${formatCommandFailure(result)}`);
  }
  return { path: target, branch: name, repoRoot: root, created: true };
}
