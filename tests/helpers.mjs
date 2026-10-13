import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { executableInvocation } from "../plugins/codex/scripts/lib/process.mjs";

// Test workers and spawned companions share an isolated private state root.
process.env.CODEX_COMPANION_STATE_HOME ??= fs.mkdtempSync(path.join(os.tmpdir(), "codex-plugin-state-"));
for (const key of ["CODEX_COMPANION_SESSION_ID", "CODEX_COMPANION_TRANSCRIPT_PATH", "CODEX_COMPANION_APP_SERVER_ENDPOINT", "CLAUDE_ENV_FILE"]) delete process.env[key];

export function makeTempDir(prefix = "codex-plugin-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 0o755 });
}

export function run(command, args, options = {}) {
  let invocation;
  try { invocation = executableInvocation(command, args, options.env ?? process.env); }
  catch (error) { return { status: 1, stderr: error.message, stdout: "", error }; }
  return spawnSync(invocation.command, invocation.args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    shell: false,
    timeout: options.timeout ?? 20000,
    windowsHide: true
  });
}

export function initGitRepo(cwd) {
  run("git", ["init", "-b", "main"], { cwd });
  run("git", ["config", "user.name", "Codex Plugin Tests"], { cwd });
  run("git", ["config", "user.email", "tests@example.com"], { cwd });
  run("git", ["config", "commit.gpgsign", "false"], { cwd });
  run("git", ["config", "tag.gpgsign", "false"], { cwd });
}
