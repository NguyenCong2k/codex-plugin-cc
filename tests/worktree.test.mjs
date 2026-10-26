import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createJobWorktree, worktreePathFor } from "../plugins/codex/scripts/lib/worktree.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

function makeRepo() {
  const repo = makeTempDir("codex-plugin-worktree-");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  return repo;
}

test("createJobWorktree repairs an empty directory left by an interrupted checkout", () => {
  const repo = makeRepo();
  const branch = "fix/stale-worktree";
  const target = worktreePathFor(repo, branch);
  fs.mkdirSync(target, { recursive: true });
  assert.equal(fs.readdirSync(target).length, 0);

  const worktree = createJobWorktree(repo, branch);

  assert.equal(worktree.created, true);
  assert.equal(worktree.path, target);
  assert.equal(fs.existsSync(path.join(target, ".git")), true);
  assert.equal(run("git", ["branch", "--show-current"], { cwd: target }).stdout.trim(), branch);
});
