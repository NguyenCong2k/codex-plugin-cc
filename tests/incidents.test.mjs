import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { appendIncident } from "../plugins/codex/scripts/lib/incidents.mjs";
import { makeTempDir } from "./helpers.mjs";

test("appendIncident keeps an incident written while the header is being created", () => {
  const logPath = path.join(makeTempDir(), "agent-incidents.md");
  const originalWriteFileSync = fs.writeFileSync;
  let injected = false;

  // Simulate a second process appending between this process's existence
  // check and its header write.
  fs.writeFileSync = (file, data, options) => {
    if (!injected && path.resolve(String(file)) === path.resolve(logPath)) {
      injected = true;
      originalWriteFileSync(logPath, "\n## 2026-01-01T00:00:00.000Z — other — parallel\n- Loại: other\n", "utf8");
    }
    return originalWriteFileSync(file, data, options);
  };

  try {
    assert.equal(appendIncident({ logPath, type: "blocked", did: "first writer" }), true);
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }

  const contents = fs.readFileSync(logPath, "utf8");
  assert.match(contents, /parallel/);
  assert.match(contents, /Loại: blocked/);
});
