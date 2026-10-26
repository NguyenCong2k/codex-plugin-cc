import assert from "node:assert/strict";
import test from "node:test";

import { buildDigest, inferRunStatus, normalizeCommandExecutions, summarizeTests } from "../plugins/codex/scripts/lib/digest.mjs";

test("inferRunStatus reports failure when an earlier test failed and a later command passed", () => {
  const commands = [
    {
      command: "npm test",
      status: "failed",
      exitCode: 1,
      aggregatedOutput: "FAIL src/app.test.js\n  Expected 1 to equal 2"
    },
    {
      command: "rm test.tmp",
      status: "completed",
      exitCode: 0,
      aggregatedOutput: ""
    }
  ];

  assert.equal(inferRunStatus(0, commands), "failed");
});

test("inferRunStatus passes when the same failing test is rerun successfully", () => {
  const commands = [
    { command: "npm test -- --runInBand", status: "failed", exitCode: 1, aggregatedOutput: "1 failing" },
    { command: "npm test -- --runInBand", status: "completed", exitCode: 0, aggregatedOutput: "1 passing" }
  ];

  assert.equal(inferRunStatus(0, commands), "passed");
});

test("summarizeTests counts a declined test command as failed", () => {
  const summary = summarizeTests([{ command: "npm test", status: "declined", exitCode: null }]);

  assert.equal(summary, "1 test command(s): 0 passed, 1 failed.");
});

test("digests redact credentials from commands, output and failures", () => {
  const executions = [
    {
      command:
        'curl -H "Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz1234" https://alice:hunter2@example.com/hook --auth-token=npm_secret_123',
      status: "failed",
      exitCode: 1,
      aggregatedOutput: "npm ERR! 401 for OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz"
    }
  ];

  const [command] = normalizeCommandExecutions(executions);
  assert.doesNotMatch(command.command, /ghp_|hunter2|npm_secret_123/);
  assert.match(command.command, /\[REDACTED\]/);
  assert.doesNotMatch(command.output, /sk-abcdefghijklmnopqrstuvwxyz/);
  assert.match(command.output, /\[REDACTED\]/);

  const digest = buildDigest({ status: "failed", commandExecutions: executions });
  assert.doesNotMatch(digest.commandsRun[0].command, /ghp_|hunter2|npm_secret_123/);
  assert.doesNotMatch(digest.failures.join("\n"), /sk-|ghp_|hunter2|npm_secret_123/);
});
