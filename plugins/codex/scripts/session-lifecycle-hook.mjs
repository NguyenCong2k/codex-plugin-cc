#!/usr/bin/env node
import fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { atomicWrite, withFileLock } from "./lib/storage.mjs";
import { readHookInput } from "./lib/hook-input.mjs";
import { listJobs, requestJobCancellation } from "./lib/state.mjs";
import { TRANSCRIPT_PATH_ENV } from "./lib/claude-session-transfer.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
const quote = value => `'${String(value).replace(/'/g, `'"'"'`)}'`;
export function handleSessionStart(input) {
  const envFile = process.env.CLAUDE_ENV_FILE;
  if (!envFile) return;
  const variables = {
    [SESSION_ID_ENV]: input.session_id,
    [TRANSCRIPT_PATH_ENV]: input.transcript_path,
    CODEX_COMPANION_STATE_HOME: process.env.CODEX_COMPANION_STATE_HOME
  };
  withFileLock(`${envFile}.codex-lock`, () => {
    let content = "";
    try { content = fs.readFileSync(envFile, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const lines = content.split(/\r?\n/).filter(line => line && !Object.keys(variables).some(name => line.startsWith(`export ${name}=`)));
    for (const [name, value] of Object.entries(variables)) if (value != null && value !== "") lines.push(`export ${name}=${quote(value)}`);
    atomicWrite(envFile, `${lines.join("\n")}\n`);
  });
}
export function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd(), sessionId = input.session_id || process.env[SESSION_ID_ENV];
  if (!sessionId) return;
  for (const job of listJobs(cwd)) {
    if (job.sessionId === sessionId && ["queued", "running"].includes(job.status)) {
      requestJobCancellation(cwd, job.id, "The owning Claude session ended.");
    }
  }
  // Retain finished results; never touch a workspace-shared broker or signal
  // a process based on a persisted PID. Owners handle their own cleanup.
}
async function main() {
  const input = await readHookInput();
  const event = process.argv[2] ?? input.hook_event_name;
  if (event === "SessionStart") handleSessionStart(input);
  if (event === "SessionEnd") handleSessionEnd(input);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
