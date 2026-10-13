import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { makeTempDir, initGitRepo, run } from "./helpers.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { captureTurn, importedThreadIdForSource } from "../plugins/codex/scripts/lib/codex.mjs";
import { CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
import { listJobs, updateState, updateJob, upsertJob, writeJobFile, readJobFile, resolveJobFile, setConfig, getConfig, saveState, reconcileJobs, requestJobCancellation } from "../plugins/codex/scripts/lib/state.mjs";
import { runTrackedJob } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";
import { parseArgs, splitRawArgumentString } from "../plugins/codex/scripts/lib/args.mjs";
import { buildPersistentTaskThreadName } from "../plugins/codex/scripts/lib/codex.mjs";
import { renderCancelReport, renderStoredJobResult } from "../plugins/codex/scripts/lib/render.mjs";
import { collectReviewContext } from "../plugins/codex/scripts/lib/git.mjs";
import { handleSessionStart, handleSessionEnd } from "../plugins/codex/scripts/session-lifecycle-hook.mjs";
import { processAlive, withFileLock } from "../plugins/codex/scripts/lib/storage.mjs";
import { evaluateStop } from "../plugins/codex/scripts/stop-review-gate-hook.mjs";
import { waitForInteractionResponse, writeInteractionResponse, readPendingInteraction } from "../plugins/codex/scripts/lib/interaction.mjs";

function fakeClient() {
  let exit;
  return { closed: false, exitPromise: new Promise(r => { exit = r; }), exitError: null,
    notificationHandler: null, setNotificationHandler(handler) { this.notificationHandler = handler; },
    request: async () => ({}), exit(error) { this.closed = true; this.exitError = error; exit(); },
    emit(method, params) { this.notificationHandler?.({ method, params }); } };
}
const delay = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(predicate) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { if (predicate()) return; await delay(50); }
  throw new Error("Condition did not become true.");
}
test("a turn finishes without a start-response ID, even with early events", async () => {
  const client = fakeClient();
  const result = captureTurn(client, "thread", async () => {
    client.emit("turn/started", { threadId: "thread", turn: { id: "turn", status: "inProgress" } });
    setTimeout(() => client.emit("turn/completed", { threadId: "thread", turn: { id: "turn", status: "completed" } }), 10);
    return {};
  }, { timeoutMs: 500 });
  assert.equal((await result).finalTurn.status, "completed");
});
test("disconnect rejects a turn and preserves its resumable identity", async () => {
  const client = fakeClient();
  const result = captureTurn(client, "thread", async () => ({ turn: { id: "turn", status: "inProgress" } }), { timeoutMs: 500 });
  setTimeout(() => client.exit(new Error("transport dropped")), 10);
  await assert.rejects(result, error => error.message === "transport dropped" && error.threadId === "thread");
});
test("terminal errors finish failed; a retrying error alone does not", async () => {
  for (const willRetry of [true, false]) {
    const client = fakeClient();
    const result = captureTurn(client, "thread", async () => ({ turn: { id: "turn", status: "inProgress" } }), { timeoutMs: 500 });
    await delay(1);
    client.emit("error", { threadId: "thread", turnId: "turn", willRetry, error: { message: "failure" } });
    if (willRetry) client.emit("turn/completed", { threadId: "thread", turn: { id: "turn", status: "completed" } });
    assert.equal((await result).finalTurn.status, willRetry ? "completed" : "failed");
  }
});
test("a final answer alone never fabricates successful turn completion", async () => {
  const client = fakeClient();
  const result = captureTurn(client, "thread", async () => ({ turn: { id: "turn", status: "inProgress" } }), { timeoutMs: 30 });
  await delay(1); client.emit("item/completed", { threadId: "thread", turnId: "turn", item: { type: "agentMessage", phase: "final_answer", text: "done" } });
  await assert.rejects(result, error => error.code === "CODEX_TURN_HARD_TIMEOUT" && error.timeout.interruptAcknowledged === true);
});
test("runtime activity resets the idle deadline without extending the hard limit", async () => {
  const client = fakeClient();
  const result = captureTurn(client, "thread", async () => ({ turn: { id: "turn", status: "inProgress" } }), {
    idleTimeoutMs: 40,
    hardTimeoutMs: 500
  });
  const activity = setInterval(() => {
    client.emit("item/started", { threadId: "thread", turnId: "turn", item: { type: "webSearch", query: "still working" } });
  }, 20);
  setTimeout(() => client.emit("turn/completed", { threadId: "thread", turn: { id: "turn", status: "completed" } }), 120);
  try {
    assert.equal((await result).finalTurn.status, "completed");
  } finally {
    clearInterval(activity);
  }
});
test("the hard limit stops a turn even while runtime activity continues", async () => {
  const client = fakeClient();
  const result = captureTurn(client, "thread", async () => ({ turn: { id: "turn", status: "inProgress" } }), {
    idleTimeoutMs: 100,
    hardTimeoutMs: 60
  });
  const activity = setInterval(() => {
    client.emit("item/started", { threadId: "thread", turnId: "turn", item: { type: "webSearch", query: "still working" } });
  }, 15);
  try {
    await assert.rejects(result, error => error.code === "CODEX_TURN_HARD_TIMEOUT" && error.timeout.automaticRestart === false);
  } finally {
    clearInterval(activity);
  }
});
test("interactive waits pause the idle deadline", async () => {
  const client = fakeClient();
  const activity = { touch() {}, pause() {}, resume() {} };
  const result = captureTurn(client, "thread", async () => ({ turn: { id: "turn", status: "inProgress" } }), {
    activity,
    idleTimeoutMs: 30,
    hardTimeoutMs: 300
  });
  await delay(5);
  activity.pause();
  await delay(60);
  activity.resume();
  client.emit("turn/completed", { threadId: "thread", turn: { id: "turn", status: "completed" } });
  assert.equal((await result).finalTurn.status, "completed");
});
test("cancellation before submission has no startRequest side effect", async () => {
  const controller = new AbortController(); controller.abort(new Error("cancelled before submission"));
  let starts = 0;
  await assert.rejects(captureTurn(fakeClient(), "thread", async () => { starts++; return {}; }, { signal: controller.signal }), /before submission/);
  assert.equal(starts, 0);
});
test("RPC deadlines and disconnected clients reject instead of remaining pending", async () => {
  const client = new CodexAppServerClient(process.cwd(), { rpcTimeoutMs: 20 });
  client.sendMessage = () => {};
  await assert.rejects(client.request("account/read", { refreshToken: false }), /timed out/);
  client.handleExit(null);
  await assert.rejects(client.request("account/read", { refreshToken: false }), /closed/);
});
test("interactive requests fail visibly without fabricated consent", async () => {
  const client = new CodexAppServerClient(process.cwd()); let sent;
  client.sendMessage = value => { sent = value; };
  client.handleLine(JSON.stringify({ id: 7, method: "mcpServer/elicitation/request", params: {} }));
  assert.equal(sent.error.code, -32005); assert.match(client.exitError.message, /Resume this thread/);
});
test("interactive server requests wait for and return the exact user response", async () => {
  const cwd = makeTempDir();
  upsertJob(cwd, { id: "interactive", status: "running" });
  const pending = waitForInteractionResponse({
    workspaceRoot: cwd,
    jobId: "interactive",
    message: { id: 19, method: "item/commandExecution/requestApproval", params: { command: "npm test", threadId: "thread", turnId: "turn" } },
    timeoutMs: 2000
  });
  await waitFor(() => readPendingInteraction(cwd, "interactive")?.requestId === 19);
  assert.equal(readPendingInteraction(cwd, "interactive").kind, "command-approval");
  writeInteractionResponse(cwd, "interactive", { requestId: 19, result: { decision: "acceptForSession" } });
  assert.deepEqual(await pending, { decision: "acceptForSession" });
  assert.equal(readPendingInteraction(cwd, "interactive"), null);
});
test("concurrent interactive requests keep distinct request ids", async () => {
  const cwd = makeTempDir();
  upsertJob(cwd, { id: "interactive-many", status: "running" });
  const first = waitForInteractionResponse({ workspaceRoot: cwd, jobId: "interactive-many", message: { id: "a", method: "item/fileChange/requestApproval", params: {} }, timeoutMs: 2000 });
  const second = waitForInteractionResponse({ workspaceRoot: cwd, jobId: "interactive-many", message: { id: "b", method: "mcpServer/elicitation/request", params: {} }, timeoutMs: 2000 });
  await waitFor(() => listJobs(cwd).find(job => job.id === "interactive-many")?.interactions?.length === 2);
  writeInteractionResponse(cwd, "interactive-many", { requestId: "b", result: { action: "decline", content: null } });
  writeInteractionResponse(cwd, "interactive-many", { requestId: "a", result: { decision: "accept" } });
  assert.deepEqual(await first, { decision: "accept" });
  assert.deepEqual(await second, { action: "decline", content: null });
  assert.equal(readPendingInteraction(cwd, "interactive-many"), null);
});
test("concurrent processes retain every job and configuration", async () => {
  const cwd = makeTempDir(); setConfig(cwd, "stopReviewGate", true);
  const url = pathToFileURL(path.resolve("plugins/codex/scripts/lib/state.mjs")).href;
  await Promise.all(Array.from({ length: 8 }, (_, i) => new Promise((resolve, reject) => {
    const script = `import {upsertJob,updateState} from ${JSON.stringify(url)};upsertJob(${JSON.stringify(cwd)},{id:'parallel-${i}',status:'running',summary:'${i}'});for(let n=0;n<10;n++)updateState(${JSON.stringify(cwd)},s=>{s.config.counter=(s.config.counter||0)+1});`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = ""; child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject); child.on("exit", code => code === 0 ? resolve() : reject(new Error(stderr)));
  })));
  assert.equal(listJobs(cwd).length, 8); assert.equal(getConfig(cwd).stopReviewGate, true);
  assert.equal(getConfig(cwd).counter, 80);
});
test("a killed lock owner cannot wedge its successor or delete another owner's ticket", async t => {
  const dir = makeTempDir(), marker = path.join(dir, "acquired"), lock = path.join(dir, "lock");
  const url = pathToFileURL(path.resolve("plugins/codex/scripts/lib/storage.mjs")).href;
  const script = `import fs from 'node:fs';import {withFileLock} from ${JSON.stringify(url)};withFileLock(${JSON.stringify(lock)},()=>{fs.writeFileSync(${JSON.stringify(marker)},'ready');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30000)});`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { windowsHide: true, stdio: "ignore" });
  t.after(() => child.kill()); await waitFor(() => fs.existsSync(marker));
  const exited = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGKILL"); await exited;
  let acquired = false; withFileLock(lock, () => { acquired = true; }); assert.equal(acquired, true);
});
test("terminal evidence survives late progress, cancellation, and stale snapshots", () => {
  const cwd = makeTempDir();
  writeJobFile(cwd, "done", { id: "done", status: "completed", result: { text: "durable" } });
  upsertJob(cwd, { id: "done", status: "running" }); requestJobCancellation(cwd, "done");
  saveState(cwd, { jobs: [{ id: "other", status: "running" }] });
  const job = readJobFile(resolveJobFile(cwd, "done"));
  assert.equal(job.status, "completed"); assert.equal(job.result.text, "durable");
  assert.deepEqual(listJobs(cwd).map(j => j.id).sort(), ["done", "other"]);
});
test("bulk state changes and per-job records share one transition authority", () => {
  const cwd = makeTempDir(); upsertJob(cwd, { id: "bulk", status: "running" });
  updateState(cwd, state => { state.jobs[0].status = "completed"; state.jobs[0].result = { durable: true }; });
  assert.equal(readJobFile(resolveJobFile(cwd, "bulk")).status, "completed");
  updateState(cwd, state => { state.jobs[0].status = "running"; });
  assert.equal(listJobs(cwd)[0].status, "completed");
});
test("history cap retains all active jobs and only caps terminal history", () => {
  const cwd = makeTempDir();
  saveState(cwd, { jobs: Array.from({ length: 65 }, (_, i) => ({ id: `cap-${i}`, status: i < 5 ? "running" : "completed", updatedAt: new Date(i * 1000).toISOString() })) });
  assert.equal(listJobs(cwd).filter(j => j.status === "running").length, 5);
  assert.equal(listJobs(cwd).filter(j => j.status === "completed").length, 50);
});
test("the owner acknowledges cancellation and late results cannot revive the job", async () => {
  const cwd = makeTempDir(), job = { id: "cancel-owner", workspaceRoot: cwd };
  const result = runTrackedJob(job, async signal => {
    requestJobCancellation(cwd, job.id);
    await delay(350);
    if (signal.aborted) throw signal.reason;
    return { exitStatus: 0, payload: {}, rendered: "late" };
  });
  await assert.rejects(result, /Cancelled/);
  upsertJob(cwd, { id: job.id, status: "completed" });
  assert.equal(listJobs(cwd)[0].status, "cancelled");
});
test("dead workers are terminal and SessionEnd never signals another session", () => {
  const cwd = makeTempDir();
  upsertJob(cwd, { id: "dead", status: "running", pid: 2147483647 });
  assert.equal(reconcileJobs(cwd).find(j => j.id === "dead").status, "failed");
  upsertJob(cwd, { id: "a", status: "running", sessionId: "A", pid: process.pid });
  upsertJob(cwd, { id: "b", status: "running", sessionId: "B", pid: process.pid });
  handleSessionEnd({ cwd, session_id: "A" });
  assert.ok(listJobs(cwd).find(j => j.id === "a").cancelRequestedAt);
  assert.equal(listJobs(cwd).find(j => j.id === "b").cancelRequestedAt, undefined);
});
test("literal task text stops option parsing and inline values retain equals signs", () => {
  const result = parseArgs(["--model=a=b", "explain C:\\temp\\file", "--write"], { valueOptions: ["model"], booleanOptions: ["write"], stopAtPositional: true });
  assert.equal(result.options.model, "a=b"); assert.equal(result.options.write, undefined);
  assert.deepEqual(result.positionals, ["explain C:\\temp\\file", "--write"]);
});
test("explicit raw slash transport preserves Windows paths and rejects broken quoting", () => {
  assert.deepEqual(splitRawArgumentString('--cwd "C:\\work\\a=b" --model a=b'), ["--cwd", "C:\\work\\a=b", "--model", "a=b"]);
  assert.throws(() => splitRawArgumentString('--cwd "unfinished'), /Unterminated quote/);
  const name = buildPersistentTaskThreadName("a".repeat(52) + "😀" + "long remaining prompt");
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(name));
});
test("quoted stdin transport never evaluates shell metacharacters in review arguments", { skip: process.platform === "win32" }, () => {
  const cwd = makeTempDir(), bin = makeTempDir(); initGitRepo(cwd); installFakeCodex(bin);
  const marker = path.join(cwd, "must-not-exist"), script = path.resolve("plugins/codex/scripts/codex-companion.mjs");
  const shell = `node "${script}" review --arguments-stdin <<'CODEX_ARGS'\n--base "feature$(touch ${marker})"\nCODEX_ARGS`;
  const result = run("sh", ["-c", shell], { cwd, env: buildEnv(bin) });
  assert.equal(result.status, 0, result.stderr); assert.equal(fs.existsSync(marker), false);
  assert.ok(result.stdout.includes(`feature$(touch ${marker})`));
});
test("import correlation tolerates a growing source and Windows canonical prefixes without accepting stale records", () => {
  const dir = makeTempDir(), source = path.join(dir, "session.jsonl"), previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = dir; fs.writeFileSync(source, "before\n");
  const hash = text => crypto.createHash("sha256").update(text).digest("hex");
  const before = hash("before\n"), canonical = fs.realpathSync(source);
  const ledger = path.join(dir, "external_agent_session_imports.json");
  const prefix = process.platform === "win32" ? "\\\\?\\" : "";
  try {
    fs.writeFileSync(ledger, JSON.stringify({ records: [{ source_path: prefix + canonical, content_sha256: "unrelated", imported_thread_id: "old" }] }));
    assert.equal(importedThreadIdForSource(source, before, new Set(["old"])), null);
    fs.appendFileSync(source, "during import\n");
    fs.writeFileSync(ledger, JSON.stringify({ records: [{ source_path: prefix + canonical, content_sha256: hash(fs.readFileSync(source)), imported_thread_id: "new" }] }));
    assert.equal(importedThreadIdForSource(source, before, new Set(["old"])), "new");
  } finally { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; }
});
test("cancel/completion races and partial failed output are never rendered as a success", () => {
  assert.doesNotMatch(renderCancelReport({ id: "job", status: "completed" }), /Cancelled job/);
  const output = renderStoredJobResult({ id: "job", status: "failed" }, { result: { rawOutput: "partial" }, errorMessage: "lost connection" });
  assert.match(output, /Status: failed/); assert.match(output, /lost connection/); assert.match(output, /partial/);
});
test("turn timeouts remain terminal and tell Claude to decide about resuming", async () => {
  const cwd = makeTempDir();
  const timeoutError = Object.assign(new Error("Codex turn timed out."), {
    code: "CODEX_TURN_IDLE_TIMEOUT",
    threadId: "thread-timeout",
    turnId: "turn-timeout",
    timeout: { kind: "idle", limitMs: 900000, elapsedMs: 901000, inactiveMs: 900000, interruptAcknowledged: true, automaticRestart: false }
  });
  await assert.rejects(
    runTrackedJob({ id: "timed", workspaceRoot: cwd, title: "Timed task", status: "queued" }, async () => { throw timeoutError; }),
    /timed out/
  );
  const stored = listJobs(cwd).find(job => job.id === "timed");
  assert.equal(stored.status, "timed_out");
  assert.equal(stored.timeout.kind, "idle");
  assert.equal(stored.resume.decisionOwner, "claude");
  assert.equal(stored.resume.automatic, false);
  const output = renderStoredJobResult(stored, stored);
  assert.match(output, /Status: timed_out/);
  assert.match(output, /Automatic restart: disabled/);
  assert.match(output, /\/codex:rescue --resume/);
});
test("SessionStart updates keys rather than growing exports, preserving other plugins", () => {
  const dir = makeTempDir(), file = path.join(dir, "env"), previous = process.env.CLAUDE_ENV_FILE;
  fs.writeFileSync(file, "export OTHER='keep'\n"); process.env.CLAUDE_ENV_FILE = file;
  try {
    for (let i = 0; i < 20; i++) handleSessionStart({ session_id: "A", transcript_path: "C:\\a.jsonl" });
    handleSessionStart({ session_id: "B", transcript_path: "C:\\b.jsonl" });
    const text = fs.readFileSync(file, "utf8");
    assert.equal(text.split("export CODEX_COMPANION_SESSION_ID=").length - 1, 1);
    assert.match(text, /SESSION_ID='B'/); assert.match(text, /OTHER='keep'/);
  } finally { if (previous === undefined) delete process.env.CLAUDE_ENV_FILE; else process.env.CLAUDE_ENV_FILE = previous; }
});
test("Stop re-entry returns before launching another review", async () => {
  const cwd = makeTempDir(); setConfig(cwd, "stopReviewGate", true);
  let calls = 0;
  assert.equal(await evaluateStop({ cwd, stop_hook_active: true }, async () => { calls++; }), null);
  assert.equal(calls, 0);
});
test("a disabled hook exits even when the host never closes stdin", async t => {
  const cwd = makeTempDir();
  const child = spawn(process.execPath, [path.resolve("plugins/codex/scripts/stop-review-gate-hook.mjs")], { cwd, windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
  t.after(() => { child.stdin.destroy(); child.kill(); });
  const done = new Promise(resolve => child.once("exit", resolve));
  assert.equal(await Promise.race([done, delay(4000).then(() => "hung")]), 0);
});
test("Git collector preserves Unicode content and unstaged status whitespace", () => {
  const cwd = makeTempDir(); initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "a.js"), "old\n"); run("git", ["add", "a.js"], { cwd }); run("git", ["commit", "-m", "initial"], { cwd });
  fs.writeFileSync(path.join(cwd, "a.js"), "new\n"); fs.writeFileSync(path.join(cwd, "café.js"), "UNICODE_CONTENT\n");
  const context = collectReviewContext(cwd, { mode: "working-tree" });
  assert.match(context.content, /UNICODE_CONTENT/); assert.match(context.content, /\n M a\.js/);
});
test("guardian reaps its app-server when the owning parent dies", async t => {
  const dir = makeTempDir(), bin = makeTempDir(); installFakeCodex(bin);
  const file = path.join(dir, "owner.mjs"), pidFile = path.join(dir, "pid");
  const url = pathToFileURL(path.resolve("plugins/codex/scripts/lib/app-server.mjs")).href;
  fs.writeFileSync(file, `import fs from 'node:fs';import {CodexAppServerClient} from ${JSON.stringify(url)};const c=await CodexAppServerClient.connect(process.cwd());fs.writeFileSync(${JSON.stringify(pidFile)},String(c.proc.pid));setInterval(()=>{},1000);`);
  const child = spawn(process.execPath, [file], { env: buildEnv(bin), cwd: dir, windowsHide: true, stdio: "ignore" });
  t.after(() => child.kill());
  await waitFor(() => fs.existsSync(pidFile));
  const guardianPid = Number(fs.readFileSync(pidFile, "utf8"));
  child.kill("SIGKILL");
  await waitFor(() => !processAlive(guardianPid));
  const fake = JSON.parse(fs.readFileSync(path.join(bin, "fake-codex-state.json"), "utf8"));
  assert.equal(processAlive(fake.appServerPid), false);
});
