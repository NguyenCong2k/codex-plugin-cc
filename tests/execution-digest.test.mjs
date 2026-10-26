import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import { executeReviewRun, executeTaskRun } from "../plugins/codex/scripts/codex-companion.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

function makeRepo() {
  const repo = makeTempDir("codex-plugin-execution-");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  return repo;
}

async function withFakeCodex(binDir, fn) {
  const previousPath = process.env.PATH;
  process.env.PATH = buildEnv(binDir).PATH;
  try {
    return await fn();
  } finally {
    process.env.PATH = previousPath;
  }
}

test("executeTaskRun keeps the job id in its execution digest", async () => {
  const repo = makeRepo();
  const bin = makeTempDir();
  installFakeCodex(bin);

  const execution = await withFakeCodex(bin, () =>
    executeTaskRun({
      cwd: repo,
      workspaceRoot: repo,
      prompt: "inspect the repository",
      write: false,
      resumeLast: false,
      jobId: "task-execution-1",
      fullAccess: false,
      incidentLog: null,
      worktreePath: null
    })
  );

  assert.equal(execution.digest.jobId, "task-execution-1");
});

test("executeReviewRun keeps the job id in native and digest review digests", async () => {
  const repo = makeRepo();
  const bin = makeTempDir();
  installFakeCodex(bin);
  fs.writeFileSync(path.join(repo, "src.js"), "export const value = items[0];\n");

  await withFakeCodex(bin, async () => {
    const native = await executeReviewRun({
      cwd: repo,
      scope: "working-tree",
      reviewName: "Review",
      digest: false,
      jobId: "review-native-1",
      workspaceRoot: repo,
      incidentLog: null
    });
    assert.equal(native.digest.jobId, "review-native-1");

    const structured = await executeReviewRun({
      cwd: repo,
      scope: "working-tree",
      reviewName: "Review",
      digest: true,
      jobId: "review-digest-1",
      workspaceRoot: repo,
      incidentLog: null
    });
    assert.equal(structured.digest.jobId, "review-digest-1");
  });
});
