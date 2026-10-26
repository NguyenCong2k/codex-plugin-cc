import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");
const SPECIAL_PROMPT = 'a "b" & c | d % é tiếng Việt';

function makeRepo(prefix = "codex-plugin-ux-") {
  const repo = makeTempDir(prefix);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  return repo;
}

function readFakeState(binDir) {
  return JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
}

function runTask(repo, binDir, args, options = {}) {
  return run("node", [SCRIPT, "task", ...args], {
    cwd: repo,
    env: options.env ?? buildEnv(binDir),
    input: options.input,
    timeout: options.timeout ?? 30000
  });
}

function parseDigest(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("task --full-access maps to danger-full-access and approval never", () => {
  const repo = makeRepo();
  const bin = makeTempDir();
  installFakeCodex(bin);

  const result = runTask(repo, bin, ["--full-access", "--digest", "inspect the AutoCAD loopback bridge"]);
  const digest = parseDigest(result);
  assert.equal(digest.status, "passed");

  const state = readFakeState(bin);
  assert.equal(state.lastThreadStart.sandbox, "danger-full-access");
  assert.equal(state.lastThreadStart.approvalPolicy, "never");
  assert.equal(state.lastTurnStart.sandboxPolicy.type, "dangerFullAccess");
  assert.equal(state.lastTurnStart.approvalPolicy, "never");
});

test("task keeps the existing read-only and workspace-write defaults when full access is off", () => {
  const repo = makeRepo();
  const bin = makeTempDir();
  installFakeCodex(bin);

  const readOnly = runTask(repo, bin, ["--digest", "diagnose only"]);
  parseDigest(readOnly);
  let state = readFakeState(bin);
  assert.equal(state.lastThreadStart.sandbox, "read-only");
  assert.equal(state.lastThreadStart.approvalPolicy, null);
  assert.equal(state.lastTurnStart.sandboxPolicy.type, "readOnly");

  const write = runTask(repo, bin, ["--write", "--digest", "fix the test"]);
  parseDigest(write);
  state = readFakeState(bin);
  assert.equal(state.lastThreadStart.sandbox, "workspace-write");
  assert.equal(state.lastThreadStart.approvalPolicy, null);
  assert.equal(state.lastTurnStart.sandboxPolicy.type, "workspaceWrite");
});

test("userConfig full_access=true enables full access without a flag", () => {
  const repo = makeRepo();
  const bin = makeTempDir();
  const home = makeTempDir();
  const configDir = path.join(home, ".claude");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "settings.json"),
    JSON.stringify(
      {
        pluginConfigs: {
          "codex@nguyencong-codex": {
            options: { full_access: true }
          }
        }
      },
      null,
      2
    )
  );
  installFakeCodex(bin);

  const env = {
    ...buildEnv(bin),
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: configDir
  };
  const result = runTask(repo, bin, ["--digest", "use the configured full access"], { env });
  const digest = parseDigest(result);
  assert.equal(digest.status, "passed");

  const state = readFakeState(bin);
  assert.equal(state.lastThreadStart.sandbox, "danger-full-access");
  assert.equal(state.lastThreadStart.approvalPolicy, "never");
});

test("a normal-mode approval request becomes a blocked digest and an incident entry", () => {
  const repo = makeRepo();
  const bin = makeTempDir();
  const incidentLog = path.join(repo, "incidents", "agent-incidents.md");
  installFakeCodex(bin, "approval-request");

  const result = runTask(repo, bin, ["--digest", "--incident-log", incidentLog, "run the test suite"], {
    env: {
      ...buildEnv(bin),
      CODEX_COMPANION_INTERACTION_TIMEOUT_MS: "150"
    },
    timeout: 30000
  });

  assert.equal(result.status, 1, result.stderr);
  const digest = JSON.parse(result.stdout);
  assert.equal(digest.status, "blocked");
  assert.match(digest.blockedCommand, /npm test/);
  assert.ok(digest.failures.length > 0);

  const incident = fs.readFileSync(incidentLog, "utf8");
  assert.match(incident, /Loại: blocked/);
  assert.match(incident, /npm test/);
});

test("full access auto-accepts an unexpected approval instead of hanging the job", () => {
  const repo = makeRepo();
  const bin = makeTempDir();
  const incidentLog = path.join(repo, "incidents.md");
  installFakeCodex(bin, "approval-request");

  const result = runTask(repo, bin, ["--full-access", "--digest", "--incident-log", incidentLog, "run the test suite"]);
  const digest = parseDigest(result);
  assert.equal(digest.status, "passed");

  const incident = fs.readFileSync(incidentLog, "utf8");
  assert.match(incident, /Auto-accepted because full_access is enabled/);
});

test("--worktree creates an isolated branch and reports its path in the digest", () => {
  const repo = makeRepo("codex plugin worktree é ");
  const bin = makeTempDir();
  const branch = "fix/ui-é";
  installFakeCodex(bin, "write-file");

  const result = runTask(repo, bin, ["--write", "--worktree", branch, "--digest", "create hello.txt and run git status"]);
  const digest = parseDigest(result);

  assert.ok(digest.worktree, "digest must include the worktree path");
  assert.equal(digest.worktree, path.resolve(digest.worktree));
  assert.ok(fs.existsSync(path.join(digest.worktree, "hello.txt")), "Codex must write inside the worktree");
  assert.equal(fs.existsSync(path.join(repo, "hello.txt")), false, "the main checkout must stay untouched");
  assert.match(digest.filesChanged.join("\n"), /hello\.txt/);

  const branchResult = run("git", ["branch", "--show-current"], { cwd: digest.worktree });
  assert.equal(branchResult.stdout.trim(), branch);
  const state = readFakeState(bin);
  assert.equal(path.resolve(state.lastTurnStart.cwd), path.resolve(digest.worktree));
});

test("workspace-write keeps git metadata writable for a linked worktree", () => {
  const repo = makeRepo();
  const bin = makeTempDir();
  const branch = "fix/git-metadata";
  installFakeCodex(bin, "write-file");

  const result = runTask(repo, bin, ["--write", "--worktree", branch, "--digest", "commit inside the worktree"]);
  const digest = parseDigest(result);
  const state = readFakeState(bin);
  const roots = state.lastTurnStart.sandboxPolicy.writableRoots.map((root) => path.resolve(root));

  assert.ok(roots.includes(path.resolve(digest.worktree)), "the worktree itself must remain writable");
  const gitDir = path.resolve(run("git", ["rev-parse", "--absolute-git-dir"], { cwd: digest.worktree }).stdout.trim());
  const commonDir = path.resolve(
    digest.worktree,
    run("git", ["rev-parse", "--git-common-dir"], { cwd: digest.worktree }).stdout.trim()
  );
  assert.ok(roots.includes(gitDir), `writableRoots must include the worktree git dir ${gitDir}`);
  assert.ok(roots.includes(commonDir), `writableRoots must include the shared git dir ${commonDir}`);
});

test("digest reports commands, a tests summary, failures and the log path", () => {
  const repo = makeRepo();
  const bin = makeTempDir();
  installFakeCodex(bin, "command-failure");

  const result = runTask(repo, bin, ["--digest", "run the tests"]);
  assert.equal(result.status, 0, result.stderr);
  const digest = JSON.parse(result.stdout);

  assert.equal(digest.status, "failed");
  assert.equal(digest.commandsRun.length, 2);
  assert.deepEqual(
    digest.commandsRun.map((command) => [command.command, command.exitCode]),
    [["git status", 0], ["npm test", 1]]
  );
  assert.match(digest.testsSummary, /1 test command\(s\): 0 passed, 1 failed/);
  assert.match(digest.failures.join("\n"), /Expected 1 to equal 2/);
  assert.ok(digest.logPath && fs.existsSync(digest.logPath));
  assert.match(fs.readFileSync(digest.logPath, "utf8"), /Final output/);
});

test("review --base main --digest returns compact structured findings", () => {
  const repo = makeRepo();
  const bin = makeTempDir();
  installFakeCodex(bin);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0];\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "base"], { cwd: repo });
  run("git", ["checkout", "-b", "feature/review-digest"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0].id;\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "feature"], { cwd: repo });

  const result = run("node", [SCRIPT, "review", "--base", "main", "--digest"], {
    cwd: repo,
    env: buildEnv(bin)
  });

  assert.equal(result.status, 0, result.stderr);
  const digest = JSON.parse(result.stdout);
  assert.equal(digest.status, "failed");
  assert.equal(digest.findings.length, 1);
  assert.equal(digest.findings[0].file, "src/app.js");
  assert.equal(digest.findings[0].line, "4-6");
  assert.equal(digest.findings[0].severity, "high");
  assert.match(digest.findings[0].description, /assumes data is always present/);
  assert.match(digest.filesChanged.join("\n"), /src\/app\.js/);
  assert.ok(digest.logPath && fs.existsSync(digest.logPath));
  assert.doesNotMatch(result.stdout, /# Codex Review/);
});

test("task --prompt-stdin preserves shell metacharacters and Vietnamese text", () => {
  const repo = makeRepo();
  const bin = makeTempDir();
  installFakeCodex(bin);

  const result = runTask(repo, bin, ["--digest", "--prompt-stdin"], { input: SPECIAL_PROMPT });
  parseDigest(result);

  const state = readFakeState(bin);
  assert.equal(state.lastTurnStart.prompt, SPECIAL_PROMPT);
});

test("Git Bash preserves the same prompt literally", { skip: process.platform === "win32" && !fs.existsSync("C:\\Program Files\\Git\\usr\\bin\\bash.exe") }, () => {
  const repo = makeRepo();
  const bin = makeTempDir();
  installFakeCodex(bin);
  const script = `node "${SCRIPT.replace(/\\/g, "/")}" task --prompt-stdin --digest <<'CODEX_PROMPT'\n${SPECIAL_PROMPT}\nCODEX_PROMPT`;
  const result = run("bash", ["-c", script], { cwd: repo, env: buildEnv(bin) });

  assert.equal(result.status, 0, result.stderr);
  const state = readFakeState(bin);
  assert.equal(state.lastTurnStart.prompt, SPECIAL_PROMPT);
});

test("PowerShell preserves the same prompt literally", { skip: process.platform !== "win32" }, () => {
  const repo = makeRepo();
  const bin = makeTempDir();
  installFakeCodex(bin);
  const ps1 = path.join(makeTempDir(), "run.ps1");
  const escapedScript = SCRIPT.replace(/'/g, "''");
  fs.writeFileSync(
    ps1,
    `[Console]::InputEncoding = [System.Text.Encoding]::UTF8\n[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n$OutputEncoding = [System.Text.Encoding]::UTF8\n$text = [Console]::In.ReadToEnd()\n$text | & node '${escapedScript}' task --prompt-stdin --digest\n`,
    "utf8"
  );
  const result = run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1], {
    cwd: repo,
    env: buildEnv(bin),
    input: SPECIAL_PROMPT
  });

  assert.equal(result.status, 0, result.stderr);
  const state = readFakeState(bin);
  assert.equal(state.lastTurnStart.prompt.trim(), SPECIAL_PROMPT);
});

test("status <job> --digest stays cheap and result --digest returns the stored digest", async () => {
  const repo = makeRepo();
  const bin = makeTempDir();
  installFakeCodex(bin, "slow-task");
  const env = buildEnv(bin);

  const launch = runTask(repo, bin, ["--background", "--json", "investigate the flaky test"], { env });
  assert.equal(launch.status, 0, launch.stderr);
  const jobId = JSON.parse(launch.stdout).jobId;

  const waited = run("node", [SCRIPT, "status", jobId, "--wait", "--timeout-ms", "15000", "--digest"], {
    cwd: repo,
    env
  });
  assert.equal(waited.status, 0, waited.stderr);
  const status = JSON.parse(waited.stdout);
  assert.equal(status.jobId, jobId);
  assert.equal(status.state, "done");
  assert.ok(status.lastOutputAt);
  assert.equal(status.logPath.endsWith(".log"), true);
  assert.doesNotMatch(waited.stdout, /Handled the requested task/);

  const stored = run("node", [SCRIPT, "result", jobId, "--digest"], { cwd: repo, env });
  assert.equal(stored.status, 0, stored.stderr);
  const digest = JSON.parse(stored.stdout);
  assert.equal(digest.status, "passed");
  assert.equal(digest.jobId, jobId);
  assert.ok(digest.logPath);
});

test("full access fails clearly when the runtime rejects danger-full-access", () => {
  const repo = makeRepo();
  const bin = makeTempDir();
  installFakeCodex(bin, "full-access-unsupported");

  const result = runTask(repo, bin, ["--full-access", "--digest", "try full access"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Full access is not supported by this Codex runtime/);
  assert.match(result.stderr, /danger-full-access/);
});

test("a turn timeout appends an incident entry and keeps an error digest", () => {
  const repo = makeRepo();
  const bin = makeTempDir();
  const incidentLog = path.join(repo, "timeout-incidents.md");
  installFakeCodex(bin, "slow-task");

  const result = runTask(repo, bin, ["--digest", "--incident-log", incidentLog, "run past the hard limit"], {
    env: {
      ...buildEnv(bin),
      CODEX_COMPANION_TURN_HARD_TIMEOUT_MS: "250"
    },
    timeout: 30000
  });

  assert.equal(result.status, 1);
  const digest = JSON.parse(result.stdout);
  assert.equal(digest.status, "error");
  assert.match(digest.failures.join("\n"), /hard runtime limit|timed out/i);

  const incident = fs.readFileSync(incidentLog, "utf8");
  assert.match(incident, /Loại: timeout/);
  assert.match(incident, /automatic restart is disabled|no automatic restart/i);
});
