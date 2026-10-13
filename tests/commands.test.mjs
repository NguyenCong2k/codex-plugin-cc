import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
const root = path.resolve("plugins/codex");
const read = file => fs.readFileSync(path.join(root, file), "utf8");

test("review commands explicitly separate slash argument transport from task text", () => {
  for (const command of ["review", "adversarial-review"]) {
    const source = read(`commands/${command}.md`);
    assert.match(source, /review-only/i);
    assert.match(source, new RegExp(`${command} --arguments-stdin`));
    assert.match(source, /Do not fix issues/i);
    assert.match(source, /run_in_background:\s*true/);
    assert.match(source, /return Codex's output verbatim/i);
  }
});
test("rescue contract preserves text and cannot silently fail or grant write access for diagnosis", () => {
  const agent = read("agents/codex-rescue.md"), skill = read("skills/codex-cli-runtime/SKILL.md");
  for (const source of [agent, skill]) {
    assert.match(source, /--prompt-file/);
    assert.match(source, /authorized.*(edit|fix)/i);
    assert.doesNotMatch(source, /return nothing/i);
    assert.doesNotMatch(source, /Default to.*write-capable/i);
  }
  assert.doesNotMatch(agent, /^model: sonnet$/m);
  const command = read("commands/rescue.md");
  assert.match(command, /subagent_type: "codex:codex-rescue"/);
  assert.doesNotMatch(command, /^context:\s*fork/m);
  assert.match(command, /do not call `Skill\(codex:codex-rescue\)`/);
});
test("lifecycle and deterministic commands remain exposed", () => {
  const names = fs.readdirSync(path.join(root, "commands")).sort();
  assert.deepEqual(names, ["adversarial-review.md", "cancel.md", "rescue.md", "result.md", "review.md", "setup.md", "status.md", "transfer.md"]);
  const hooks = JSON.parse(read("hooks/hooks.json"));
  assert.ok(hooks.hooks.SessionStart && hooks.hooks.SessionEnd && hooks.hooks.Stop);
  for (const name of ["transfer", "result", "cancel", "status"]) assert.match(read(`commands/${name}.md`), /--arguments-stdin/);
  assert.match(read("commands/setup.md"), /npm install -g @openai\/codex/);
});
