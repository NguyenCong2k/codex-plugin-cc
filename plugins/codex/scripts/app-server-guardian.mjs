#!/usr/bin/env node
import { spawn } from "node:child_process";
import process from "node:process";
import { executableInvocation, terminateProcessTree } from "./lib/process.mjs";

let child;
let stopping = false;
let killTimer;
function reap() {
  if (!child?.pid) return;
  try { terminateProcessTree(child.pid); }
  catch (error) { process.stderr.write(`Runtime cleanup: ${error.message}\n`); }
}
function stop() {
  if (stopping) return;
  stopping = true;
  child?.stdin.end();
  // A process handle, not an unvalidated persisted PID, owns this cleanup.
  reap();
  killTimer = setTimeout(() => {
    if (child?.exitCode === null) {
      if (process.platform !== "win32") { try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ } }
      else reap();
    }
    process.exit(1);
  }, 3000);
}
try {
  const invocation = executableInvocation("codex", ["app-server"]);
  child = spawn(invocation.command, invocation.args, { shell: false,
    detached: process.platform !== "win32", windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
  process.stdin.pipe(child.stdin);
  process.stdin.on("end", stop); process.stdin.on("error", stop);
  process.stdout.on("error", stop); child.stdin.on("error", stop);
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
  child.on("error", error => { process.stderr.write(`${error.message}\n`); stop(); });
  child.on("exit", () => {
    // Reap the owned process group, including MCP children, before exiting.
    reap(); clearTimeout(killTimer);
  });
  child.on("close", code => { process.stdin.destroy(); process.exitCode = stopping ? 0 : (code ?? 1); });
} catch (error) { process.stderr.write(`${error.message}\n`); process.exit(1); }
