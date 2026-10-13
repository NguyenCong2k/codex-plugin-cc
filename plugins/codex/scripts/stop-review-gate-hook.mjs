#!/usr/bin/env node
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readHookInput } from "./lib/hook-input.mjs";
import { getConfig, reconcileJobs } from "./lib/state.mjs";
import { getCodexAvailability, runAppServerTurn } from "./lib/codex.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export function parseStopReviewOutput(text) {
  const line = String(text ?? "").trim().split(/\r?\n/, 1)[0];
  if (line.startsWith("ALLOW:")) return { ok: true };
  if (line.startsWith("BLOCK:")) return { ok: false, reason: line.slice(6).trim() || "Codex found a blocking issue." };
  throw new Error("Review did not return an ALLOW/BLOCK verdict.");
}
export async function evaluateStop(input, runReview = runAppServerTurn) {
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  if (input.stop_hook_active) return null;
  if (!getConfig(cwd).stopReviewGate) return null;
  const availability = getCodexAvailability(cwd);
  if (!availability.available) throw new Error(`Codex is not set up for the review gate. Run /codex:setup. ${availability.detail}`);
  const prompt = interpolateTemplate(loadPromptTemplate(ROOT, "stop-review-gate"), {
    CLAUDE_RESPONSE_BLOCK: input.last_assistant_message ? `Previous Claude response:\n${input.last_assistant_message}` : ""
  });
  // Ephemeral, untracked, independently owned review. 13 minutes leaves
  // headroom under the host's 15-minute budget for cleanup and JSON output.
  const result = await runReview(cwd, { prompt, sandbox: "read-only", persistThread: false, timeoutMs: 13 * 60 * 1000 });
  if (result.status !== 0) throw new Error(result.error?.message || result.stderr || "Codex review failed.");
  return parseStopReviewOutput(result.finalMessage);
}
async function main() {
  const input = await readHookInput();
  const cwd = input.cwd || process.cwd();
  const active = reconcileJobs(cwd).filter(job => ["queued", "running"].includes(job.status) && (!input.session_id || job.sessionId === input.session_id));
  for (const job of active) process.stderr.write(`Codex task ${job.id} is still running. Check /codex:status or /codex:cancel ${job.id}.\n`);
  const verdict = await evaluateStop(input);
  if (verdict?.ok === false) process.stdout.write(`${JSON.stringify({ decision: "block", reason: `Codex stop-time review found issues that still need fixes: ${verdict.reason}` })}\n`);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(error => {
  // Infrastructure is not a code finding. Report it once instead of forcing
  // Claude through an unrepairable Stop loop.
  process.stderr.write(`Codex review gate unavailable: ${error.message} Run /codex:review --wait manually, or /codex:setup --disable-review-gate.\n`);
});
