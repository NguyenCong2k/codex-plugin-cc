import assert from "node:assert/strict";
import test from "node:test";

import { inferRunStatus, summarizeTests } from "../plugins/codex/scripts/lib/digest.mjs";

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
