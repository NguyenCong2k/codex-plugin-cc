#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
    buildPersistentTaskThreadName,
    DEFAULT_CONTINUE_PROMPT,
    findLatestTaskThread,
    getCodexAuthStatus,
    getCodexAvailability,
    getSessionRuntimeStatus,
    importExternalAgentSession,
    parseStructuredOutput,
    readOutputSchema,
    runAppServerReview,
    runAppServerTurn
  } from "./lib/codex.mjs";
import { resolveClaudeSessionPath } from "./lib/claude-session-transfer.mjs";
import {
  buildCheapStatus,
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import {
  buildDigest,
  buildDigestFromStoredJob,
  buildErrorDigest,
  inferRunStatus
} from "./lib/digest.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, getChangedFilesSince, getHeadCommit, getWorkingTreeState, resolveReviewTarget } from "./lib/git.mjs";
import { appendIncident } from "./lib/incidents.mjs";
import { resolveFullAccess, resolveIncidentLog } from "./lib/plugin-config.mjs";
import { binaryAvailable } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  generateJobId,
  getConfig,
  listJobs,
  setConfig,
  upsertJob,
  writeJobFile,
  requestJobCancellation,
  updateJob,
  reconcileJobs
} from "./lib/state.mjs";
import { createJobWorktree } from "./lib/worktree.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob,
  SESSION_ID_ENV
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  renderNativeReviewResult,
  renderReviewResult,
  renderStoredJobResult,
  renderCancelReport,
  renderJobStatusReport,
  renderSetupReport,
  renderStatusReport,
  renderTaskResult
} from "./lib/render.mjs";
import { writeInteractionResponse, readPendingInteraction } from "./lib/interaction.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const MODEL_ALIASES = new Map([["spark", "gpt-5.3-codex-spark"]]);
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/codex-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--json]",
      "  node scripts/codex-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--digest] [--incident-log <path>]",
      "  node scripts/codex-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--digest] [--incident-log <path>] [focus text]",
      "  node scripts/codex-companion.mjs task [--background] [--write] [--full-access] [--worktree <branch>] [--incident-log <path>] [--digest] [--resume-last|--resume|--fresh] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh>] [prompt]",
      "  node scripts/codex-companion.mjs transfer [--source <claude-jsonl>] [--json]",
      "  node scripts/codex-companion.mjs status [job-id] [--all] [--json|--digest]",
      "  node scripts/codex-companion.mjs result [job-id] [--json|--digest]",
      "  node scripts/codex-companion.mjs respond <job-id> [--action <accept|acceptForSession|decline|cancel>] [--response-file <json>] [--response-stdin] [--json]",
      "  node scripts/codex-companion.mjs cancel [job-id] [--json]"
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeRequestedModel(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  if (!normalized) {
    return null;
  }
  return MODEL_ALIASES.get(normalized.toLowerCase()) ?? normalized;
}

function normalizeReasoningEffort(effort) {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  return normalized;
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return [raw];
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  const actual = argv[0] === "--arguments" && argv.length === 2 ? splitRawArgumentString(argv[1])
    : argv[0] === "--arguments-file" && argv.length === 2 ? splitRawArgumentString(fs.readFileSync(argv[1], "utf8"))
    : argv[0] === "--arguments-stdin" && argv.length === 1 ? splitRawArgumentString(readStdinIfPiped()) : normalizeArgv(argv);
  return parseArgs(actual, {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function collectChangedFiles(cwd, touchedFiles = [], options = {}) {
  const files = new Set(Array.isArray(touchedFiles) ? touchedFiles : []);
  try {
    const state = getWorkingTreeState(cwd);
    for (const file of [...state.staged, ...state.unstaged, ...state.untracked]) {
      files.add(file);
    }
    // A Codex turn can commit through the shell, which produces no native
    // fileChange event and leaves the working tree clean. Diff against the
    // HEAD captured when the job started to keep committed work visible.
    for (const file of getChangedFilesSince(cwd, options.baseRef)) {
      files.add(file);
    }
  } catch {
    // A full-access job may run outside a git repository; Codex's fileChange
    // events are then the only evidence available.
  }
  return [...files];
}

function shorten(text, limit = 96) {  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${Array.from(normalized).slice(0, limit - 3).join("")}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

async function buildSetupReport(cwd, actionsTaken = []) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd });
  const codexStatus = getCodexAvailability(cwd);
  const authStatus = await getCodexAuthStatus(cwd);
  const config = getConfig(workspaceRoot);
  const fullAccess = resolveFullAccess({ cwd: workspaceRoot });
  const incidentLog = resolveIncidentLog({ cwd: workspaceRoot });

  const nextSteps = [];
  if (!codexStatus.available) {
    nextSteps.push("Install Codex with `npm install -g @openai/codex`.");
  }
  if (codexStatus.available && !authStatus.loggedIn && authStatus.requiresOpenaiAuth) {
    nextSteps.push("Run `!codex login`.");
    nextSteps.push("If browser login is blocked, retry with `!codex login --device-auth` or `!codex login --with-api-key`.");
  }
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: run `/codex:setup --enable-review-gate` to require a fresh review before stop.");
  }

  return {
    ready: nodeStatus.available && codexStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    npm: npmStatus,
    codex: codexStatus,
    auth: authStatus,
    sessionRuntime: getSessionRuntimeStatus(),
    reviewGateEnabled: Boolean(config.stopReviewGate),
    fullAccess,
    incidentLog,
    actionsTaken,
    nextSteps
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  const finalReport = await buildSetupReport(cwd, actionsTaken);
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}

function buildAdversarialReviewPrompt(context, focusText) {
  const template = loadPromptTemplate(ROOT_DIR, "adversarial-review");
  return interpolateTemplate(template, {
    REVIEW_KIND: "Adversarial Review",
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content
  });
}

function buildReviewDigestPrompt(context, focusText) {
  const template = loadPromptTemplate(ROOT_DIR, "review-digest");
  return interpolateTemplate(template, {
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content
  });
}

function reviewDigestStatus(parsed, result) {
  if (!parsed.parsed) {
    return "error";
  }
  if (result.status !== 0) {
    return "failed";
  }
  const findings = Array.isArray(parsed.parsed.findings) ? parsed.parsed.findings : [];
  return parsed.parsed.verdict === "approve" && findings.length === 0 ? "passed" : "failed";
}

function ensureCodexAvailable(cwd) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }
}

function buildNativeReviewTarget(target) {
  if (target.mode === "working-tree") {
    return { type: "uncommittedChanges" };
  }

  if (target.mode === "branch") {
    return { type: "baseBranch", branch: target.baseRef };
  }

  return null;
}

function validateNativeReviewRequest(target, focusText) {
  if (focusText.trim()) {
    throw new Error(
      `\`/codex:review\` now maps directly to the built-in reviewer and does not support custom focus text. Retry with \`/codex:adversarial-review ${focusText.trim()}\` for focused review instructions.`
    );
  }

  const nativeTarget = buildNativeReviewTarget(target);
  if (!nativeTarget) {
    throw new Error("This `/codex:review` target is not supported by the built-in reviewer. Retry with `/codex:adversarial-review` for custom targeting.");
  }

  return nativeTarget;
}

function renderStatusPayload(report, asJson) {
  return asJson ? report : renderStatusReport(report);
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

function getCurrentClaudeSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentClaudeSession(jobs) {
  const sessionId = getCurrentClaudeSessionId();
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function findLatestResumableTaskJob(jobs) {
  return (
    jobs.find(
      (job) =>
        job.jobClass === "task" &&
        job.threadId &&
        job.status !== "queued" &&
        job.status !== "running"
    ) ?? null
  );
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

async function resolveLatestTrackedTaskThread(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter((job) => job.id !== options.excludeJobId);
  const visibleJobs = filterJobsForCurrentClaudeSession(jobs);
  const activeTask = visibleJobs.find((job) => job.jobClass === "task" && (job.status === "queued" || job.status === "running"));
  if (activeTask) {
    throw new Error(`Task ${activeTask.id} is still running. Use /codex:status before continuing it.`);
  }

  const trackedTask = findLatestResumableTaskJob(visibleJobs);
  if (trackedTask) {
    return { id: trackedTask.threadId };
  }

  if (sessionId) {
    return null;
  }

  return findLatestTaskThread(workspaceRoot);
}

export async function executeReviewRun(request) {
  ensureCodexAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";
  const digestRequested = Boolean(request.digest);
  if (reviewName === "Review" && !digestRequested) {
    const reviewTarget = validateNativeReviewRequest(target, focusText);
    const result = await runAppServerReview(request.cwd, {
      target: reviewTarget,
      model: request.model,
      onProgress: request.onProgress,
      signal: request.signal,
      jobId: request.jobId,
      workspaceRoot: request.workspaceRoot ?? resolveWorkspaceRoot(request.cwd),
      incidentLog: request.incidentLog
    });
    const payload = {
      review: reviewName,
      target,
      threadId: result.threadId,
      sourceThreadId: result.sourceThreadId,
      codex: {
        status: result.status,
        stderr: result.stderr,
        stdout: result.reviewText,
        reasoning: result.reasoningSummary
      }
    };
    const rendered = renderNativeReviewResult(
      {
        status: result.status,
        stdout: result.reviewText,
        stderr: result.stderr
      },
      { reviewLabel: reviewName, targetLabel: target.label, reasoningSummary: result.reasoningSummary }
    );
    const digest = buildDigest({
      status: result.status === 0 ? "passed" : "error",
      jobId: request.jobId ?? null,
      threadId: result.threadId,
      turnId: result.turnId,
      summary: firstMeaningfulLine(result.reviewText, `${reviewName} completed.`),
      failureTexts: result.error?.message ?? result.stderr,
      worktree: request.worktreePath ?? null
    });

    return {
      exitStatus: result.status,
      threadId: result.threadId,
      turnId: result.turnId,
      payload,
      rendered,
      digest,
      summary: firstMeaningfulLine(result.reviewText, `${reviewName} completed.`),
      jobTitle: `Codex ${reviewName}`,
      jobClass: "review",
      targetLabel: target.label
    };
  }

  const context = collectReviewContext(request.cwd, target);
  const prompt = reviewName === "Review"
    ? buildReviewDigestPrompt(context, focusText)
    : buildAdversarialReviewPrompt(context, focusText);
  const result = await runAppServerTurn(context.repoRoot, {
    prompt,
    model: request.model,
    sandbox: "read-only",
    approvalPolicy: null,
    outputSchema: readOutputSchema(REVIEW_SCHEMA),
    onProgress: request.onProgress,
    signal: request.signal,
    jobId: request.jobId,
    workspaceRoot: request.workspaceRoot ?? resolveWorkspaceRoot(context.repoRoot),
    incidentLog: request.incidentLog
  });
  const parsed = parseStructuredOutput(result.finalMessage, {
    status: result.status,
    failureMessage: result.error?.message ?? result.stderr
  });
  const payload = {
    review: reviewName,
    target,
    threadId: result.threadId,
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary
    },
    codex: {
      status: result.status,
      stderr: result.stderr,
      stdout: result.finalMessage,
      reasoning: result.reasoningSummary
    },
    result: parsed.parsed,
    rawOutput: parsed.rawOutput,
    parseError: parsed.parseError,
    reasoningSummary: result.reasoningSummary
  };
  const digest = buildDigest({
    status: reviewDigestStatus(parsed, result),
    jobId: request.jobId ?? null,
    threadId: result.threadId,
    turnId: result.turnId,
    filesChanged: context.changedFiles,
    commandExecutions: result.commandExecutions,
    findings: parsed.parsed?.findings,
    summary: parsed.parsed?.summary,
    errorText: parsed.parseError ?? result.error?.message ?? result.stderr,
    failureTexts: parsed.parsed ? [] : [parsed.rawOutput],
    worktree: request.worktreePath ?? null
  });

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered: renderReviewResult(parsed, {
      reviewLabel: reviewName,
      targetLabel: context.target.label,
      reasoningSummary: result.reasoningSummary
    }),
    digest,
    summary: parsed.parsed?.summary ?? parsed.parseError ?? firstMeaningfulLine(result.finalMessage, `${reviewName} finished.`),
    jobTitle: `Codex ${reviewName}`,
    jobClass: "review",
    targetLabel: context.target.label
  };
}


export async function executeTaskRun(request) {
  const workspaceRoot = request.workspaceRoot ?? resolveWorkspaceRoot(request.cwd);
  const executionCwd = request.worktreePath ?? request.cwd;
  ensureCodexAvailable(executionCwd);

  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    resumeLast: request.resumeLast
  });

  let resumeThreadId = null;
  if (request.resumeLast) {
    const latestThread = await resolveLatestTrackedTaskThread(workspaceRoot, {
      excludeJobId: request.jobId
    });
    if (!latestThread) {
      throw new Error("No previous Codex task thread was found for this repository.");
    }
    resumeThreadId = latestThread.id;
  }

  if (!request.prompt && !resumeThreadId) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  const fullAccess = Boolean(request.fullAccess);
  const result = await runAppServerTurn(executionCwd, {
    resumeThreadId,
    prompt: request.prompt,
    defaultPrompt: resumeThreadId ? DEFAULT_CONTINUE_PROMPT : "",
    model: request.model,
    effort: request.effort,
    sandbox: fullAccess ? "danger-full-access" : request.write ? "workspace-write" : "read-only",
    approvalPolicy: fullAccess ? "never" : null,
    fullAccess,
    incidentLog: request.incidentLog ?? null,
    onProgress: request.onProgress,
    signal: request.signal,
    jobId: request.jobId,
    workspaceRoot,
    persistThread: true,
    threadName: resumeThreadId ? null : buildPersistentTaskThreadName(request.prompt || DEFAULT_CONTINUE_PROMPT)
  });

  const rawOutput = typeof result.finalMessage === "string" ? result.finalMessage : "";
  const failureMessage = result.error?.message ?? result.stderr ?? "";
  const rendered = renderTaskResult(
    {
      rawOutput,
      failureMessage,
      reasoningSummary: result.reasoningSummary
    },
    {
      title: taskMetadata.title,
      jobId: request.jobId ?? null,
      write: Boolean(request.write)
    }
  );
  const digest = buildDigest({
    status: inferRunStatus(result.status, result.commandExecutions),
    jobId: request.jobId ?? null,
    threadId: result.threadId,
    turnId: result.turnId,
    filesChanged: collectChangedFiles(executionCwd, result.touchedFiles, { baseRef: request.baseRef ?? null }),
    commandExecutions: result.commandExecutions ?? [],
    errorText: failureMessage,
    worktree: request.worktreePath ?? null
  });
  const payload = {
    status: result.status,
    threadId: result.threadId,
    rawOutput,
    touchedFiles: result.touchedFiles,
    commandExecutions: result.commandExecutions,
    reasoningSummary: result.reasoningSummary,
    digest
  };

  for (const execution of result.commandExecutions ?? []) {
    if (execution?.status === "failed" || execution?.status === "declined" || (Number.isInteger(execution?.exitCode) && execution.exitCode !== 0)) {
      appendIncident({
        logPath: request.incidentLog ?? null,
        type: "other",
        task: taskMetadata.title,
        did: execution.command ?? "Codex command",
        result: execution.aggregatedOutput || `exit ${execution.exitCode ?? "unknown"}`,
        resolution: "Kept running; the failure is also reported in the job digest."
      });
    }
  }

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered,
    digest,
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
    jobTitle: taskMetadata.title,
    jobClass: "task",
    write: Boolean(request.write)
  };
}

function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    title: reviewName === "Review" ? "Codex Review" : `Codex ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

function buildTaskRunMetadata({ prompt, resumeLast = false }) {
  if (!resumeLast && String(prompt ?? "").includes(STOP_REVIEW_TASK_MARKER)) {
    return {
      title: "Codex Stop Gate Review",
      summary: "Stop-gate review of previous Claude turn"
    };
  }

  const title = resumeLast ? "Codex Resume" : "Codex Task";
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : "Task";
  return {
    title,
    summary: shorten(prompt || fallbackSummary)
  };
}

function renderQueuedTaskLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}. Check /codex:status ${payload.jobId} for progress.\n`;
}

function getJobKindLabel(kind, jobClass) {
  if (kind === "adversarial-review") {
    return "adversarial-review";
  }
  return jobClass === "review" ? "review" : "rescue";
}

function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false, worktreePath = null, incidentLog = null, fullAccess = false }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: getJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write,
    worktreePath,
    incidentLog,
    fullAccess
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

function buildTaskJob(workspaceRoot, taskMetadata, write, options = {}) {
  return createCompanionJob({
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write,
    worktreePath: options.worktreePath ?? null,
    incidentLog: options.incidentLog ?? null,
    fullAccess: Boolean(options.fullAccess)
  });
}

function buildTaskRequest({ cwd, workspaceRoot, model, effort, prompt, write, resumeLast, jobId, fullAccess = false, incidentLog = null, worktreePath = null, baseRef = null }) {
  return {
    cwd,
    workspaceRoot,
    model,
    effort,
    prompt,
    write,
    resumeLast,
    jobId,
    fullAccess,
    incidentLog,
    worktreePath,
    baseRef
  };
}

function renderTransferResult(payload) {
  const lines = [
    "Transferred the Claude session into a Codex thread with visible turn history.",
    `Codex session ID: ${payload.threadId}`,
    `Resume in Codex: ${payload.resumeCommand}`
  ];
  return `${lines.join("\n")}\n`;
}

async function executeTransfer(cwd, options = {}) {
  const sourcePath = resolveClaudeSessionPath(cwd, {
    source: options.source
  });
  const result = await importExternalAgentSession(cwd, { sourcePath });
  const payload = {
    threadId: result.threadId,
    resumeCommand: `codex resume ${result.threadId}`,
    sourcePath,
    sessionId: path.basename(sourcePath, ".jsonl")
  };

  return {
    payload,
    rendered: renderTransferResult(payload)
  };
}

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-stdin"]) {
    return readStdinIfPiped();
  }
  if (options["prompt-file"]) {
    if (options["prompt-file"] === "-") {
      return readStdinIfPiped();
    }
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }

  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}

function requireTaskRequest(prompt, resumeLast) {
  if (!prompt && !resumeLast) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: !options.json && !options.digest
  });
  let execution;
  try {
    execution = await runTrackedJob(job, signal => runner(progress, signal), { logFile });
  } catch (error) {
    const stored = readStoredJob(job.workspaceRoot, job.id) ?? {};
    const digest = stored.digest ?? buildErrorDigest(error, {
      jobId: job.id,
      logPath: logFile,
      worktree: job.worktreePath ?? null
    });
    if (options.digest || error?.code === "CODEX_APPROVAL_REQUIRED" || error?.code === "CODEX_APPROVAL_DENIED") {
      if (error?.code !== "CODEX_APPROVAL_REQUIRED" && error?.code !== "CODEX_APPROVAL_DENIED") {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      }
      outputResult(digest, true);
      process.exitCode = 1;
      return { exitStatus: 1, payload: stored.result ?? null, rendered: stored.rendered ?? "", digest };
    }
    throw error;
  }
  const stored = readStoredJob(job.workspaceRoot, job.id) ?? {};
  const digest = stored.digest ?? execution.digest;
  outputResult(options.digest ? digest : options.json ? execution.payload : execution.rendered, Boolean(options.json || options.digest));
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

function spawnDetachedTaskWorker(workspaceRoot, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "codex-companion.mjs");
  const child = spawn(process.execPath, [scriptPath, "task-worker", "--cwd", workspaceRoot, "--workspace-root", workspaceRoot, "--job-id", jobId], {
    cwd: workspaceRoot,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

function enqueueBackgroundTask(cwd, job, request) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: null,
    logFile,
    request
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  const child = spawnDetachedTaskWorker(job.workspaceRoot, job.id);
  child.on("error", error => updateJob(job.workspaceRoot, job.id, current => ({
    ...current,
    status: "failed",
    phase: "failed",
    errorMessage: error.message,
    pid: null,
    completedAt: nowIso(),
    digest: buildErrorDigest(error, { jobId: job.id, logPath: logFile, worktree: job.worktreePath ?? null })
  })));
  updateJob(job.workspaceRoot, job.id, current => ({ ...current, pid: child.pid ?? null }));

  return {
    payload: {
      jobId: job.id,
      status: "queued",
      title: job.title,
      summary: job.summary,
      logFile,
      worktree: job.worktreePath ?? null
    },
    logFile
  };
}

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "cwd", "incident-log"],
    booleanOptions: ["json", "background", "wait", "digest"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const incidentLog = resolveIncidentLog({ flag: options["incident-log"], cwd: workspaceRoot }).path;
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });

  config.validateRequest?.(target, focusText);
  const metadata = buildReviewJobMetadata(config.reviewName, target);
  const job = createCompanionJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary,
    incidentLog
  });
  await runForegroundCommand(
    job,
    (progress, signal) =>
      executeReviewRun({
        signal,
        cwd,
        base: options.base,
        scope: options.scope,
        model: options.model,
        focusText,
        reviewName: config.reviewName,
        digest: Boolean(options.digest),
        incidentLog,
        onProgress: progress,
        jobId: job.id,
        workspaceRoot
      }),
    { json: options.json, digest: Boolean(options.digest) }
  );
}

async function handleReview(argv) {
  return handleReviewCommand(argv, {
    reviewName: "Review",
    validateRequest: validateNativeReviewRequest
  });
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file", "worktree", "incident-log"],
    booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background", "full-access", "digest", "prompt-stdin"],
    stopAtPositional: true,
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = normalizeRequestedModel(options.model);
  const effort = normalizeReasoningEffort(options.effort);
  const prompt = readTaskPrompt(cwd, options, positionals);

  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  if (resumeLast && fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  const fullAccess = resolveFullAccess({ flag: Boolean(options["full-access"]), cwd: workspaceRoot });
  const write = Boolean(options.write) || fullAccess.enabled;
  const incidentLog = resolveIncidentLog({ flag: options["incident-log"], cwd: workspaceRoot }).path;
  const worktreeBranch = options.worktree ? String(options.worktree) : null;
  if (worktreeBranch && !write) {
    throw new Error("--worktree requires --write or --full-access because it isolates a code-changing job.");
  }
  const worktree = worktreeBranch ? createJobWorktree(workspaceRoot, worktreeBranch) : null;
  const executionCwd = worktree?.path ?? cwd;
  const baseRef = getHeadCommit(executionCwd);
  const taskMetadata = buildTaskRunMetadata({
    prompt,
    resumeLast
  });
  if (worktree) {
    taskMetadata.summary = `${taskMetadata.summary} [worktree ${worktree.branch}]`;
  }
  const jobOptions = {
    worktreePath: worktree?.path ?? null,
    incidentLog,
    fullAccess: fullAccess.enabled
  };

  if (options.background) {
    ensureCodexAvailable(executionCwd);
    requireTaskRequest(prompt, resumeLast);

    const job = buildTaskJob(workspaceRoot, taskMetadata, write, jobOptions);
    const request = buildTaskRequest({
      cwd: executionCwd,
      workspaceRoot,
      model,
      effort,
      prompt,
      write,
      resumeLast,
      jobId: job.id,
      fullAccess: fullAccess.enabled,
      incidentLog,
      worktreePath: worktree?.path ?? null,
      baseRef
    });
    const { payload } = enqueueBackgroundTask(workspaceRoot, job, request);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), Boolean(options.json || options.digest));
    return;
  }

  const job = buildTaskJob(workspaceRoot, taskMetadata, write, jobOptions);
  await runForegroundCommand(
    job,
    (progress, signal) =>
      executeTaskRun({
        signal,
        cwd: executionCwd,
        workspaceRoot,
        model,
        effort,
        prompt,
        write,
        resumeLast,
        fullAccess: fullAccess.enabled,
        incidentLog,
        worktreePath: worktree?.path ?? null,
        baseRef,
        jobId: job.id,
        onProgress: progress
      }),
    { json: options.json, digest: Boolean(options.digest) }
  );
}

async function handleTransfer(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "source"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const { payload, rendered } = await executeTransfer(cwd, {
    source: options.source
  });
  outputCommandResult(payload, rendered, options.json);
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id", "workspace-root"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = options["workspace-root"]
    ? path.resolve(cwd, options["workspace-root"])
    : resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its task request payload.`);
  }

  const { logFile, progress } = createTrackedProgress(
    {
      ...storedJob,
      workspaceRoot
    },
    {
      logFile: storedJob.logFile ?? null
    }
  );
  await runTrackedJob(
    {
      ...storedJob,
      workspaceRoot,
      logFile
    },
    signal =>
      executeTaskRun({
        signal,
        ...request,
        onProgress: progress
      }),
    { logFile }
  );
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait", "digest"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    if (options.digest) {
      outputResult(buildCheapStatus(snapshot.job), true);
    } else {
      outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    }
    if (snapshot.waitTimedOut) { if (!options.json && !options.digest) process.stderr.write("Status wait timed out while the job is still active.\n"); process.exitCode = 1; }
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  if (options.digest) {
    outputResult({ jobs: [...report.running, ...(report.latestFinished ? [report.latestFinished] : []), ...report.recent].map(buildCheapStatus) }, true);
    return;
  }
  outputResult(renderStatusPayload(report, options.json), options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "digest"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const digest = buildDigestFromStoredJob(job, storedJob);
  if (options.digest) {
    outputResult(digest, true);
    return;
  }
  const payload = {
    job,
    storedJob,
    digest
  };

  outputCommandResult(payload, renderStoredJobResult(job, storedJob), options.json);
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(listJobs(workspaceRoot)));
  const candidate = findLatestResumableTaskJob(jobs);

  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            threadId: candidate.threadId,
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null
          }
  };

  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable task found for this session.\n";
  outputCommandResult(payload, rendered, options.json);
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, { valueOptions: ["cwd"], booleanOptions: ["json"] });
  const cwd = resolveCommandCwd(options);
  reconcileJobs(cwd);
  const { workspaceRoot, job } = resolveCancelableJob(cwd, positionals[0] ?? "", { env: process.env });
  requestJobCancellation(workspaceRoot, job.id);
  const deadline = Date.now() + 7000;
  let latest = job;
  while (Date.now() < deadline) {
    reconcileJobs(workspaceRoot);
    latest = listJobs(workspaceRoot).find(candidate => candidate.id === job.id);
    if (latest && !isActiveJobStatus(latest.status)) break;
    await sleep(100);
  }
  const payload = { jobId: job.id, status: latest.status, cancellationRequested: true };
  if (isActiveJobStatus(latest.status)) {
    outputCommandResult(payload, `Cancellation requested for ${job.id}; the owner has not acknowledged it. Check /codex:status ${job.id}.\n`, options.json);
    process.exitCode = 1;
  } else outputCommandResult(payload, renderCancelReport(latest), options.json);
}

function readInteractionResponse(cwd, options) {
  const sources = [Boolean(options["response-file"]), Boolean(options["response-stdin"]), Boolean(options["result-json"]), Boolean(options.action)];
  if (sources.filter(Boolean).length !== 1) {
    throw new Error("Choose exactly one of --action, --response-file, --response-stdin, or --result-json.");
  }
  if (options["response-file"]) {
    return JSON.parse(fs.readFileSync(path.resolve(cwd, options["response-file"]), "utf8"));
  }
  if (options["response-stdin"]) {
    return JSON.parse(readStdinIfPiped());
  }
  if (options["result-json"]) {
    return JSON.parse(options["result-json"]);
  }
  return null;
}

function responseForAction(pending, action) {
  const allowed = new Set(["accept", "acceptForSession", "decline", "cancel"]);
  if (!allowed.has(action)) throw new Error(`Unsupported interactive action: ${action}`);
  switch (pending.kind) {
    case "command-approval":
    case "file-change-approval":
      return { decision: action };
    case "permissions-approval": {
      const requested = pending.params?.permissions ?? pending.params?.requestedPermissions ?? {};
      return {
        permissions: action === "accept" || action === "acceptForSession" ? requested : {},
        scope: action === "acceptForSession" ? "session" : "turn"
      };
    }
    case "mcp-elicitation":
      if (action === "accept") throw new Error("MCP elicitation acceptance requires --response-file, --response-stdin, or --result-json so its content is explicit.");
      return { action, content: null };
    case "user-input":
      throw new Error("User-input requests require --response-file, --response-stdin, or --result-json.");
    default:
      return { action };
  }
}

async function handleRespond(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "response-file", "result-json", "action"],
    booleanOptions: ["json", "response-stdin"]
  });
  const reference = positionals[0];
  if (!reference) throw new Error("A job id is required for an interactive response.");
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const selected = buildSingleJobSnapshot(cwd, reference).job;
  const pending = readPendingInteraction(workspaceRoot, selected.id);
  if (!pending) throw new Error(`Job ${selected.id} is not waiting for interactive input.`);
  const supplied = readInteractionResponse(cwd, options);
  const response = options.action ? responseForAction(pending, options.action) : supplied;
  if (!response || typeof response !== "object" || Array.isArray(response)) throw new Error("Interactive response must be a JSON object.");
  const payload = writeInteractionResponse(workspaceRoot, selected.id, {
    requestId: pending.requestId,
    result: response
  });
  outputCommandResult({ jobId: selected.id, requestId: pending.requestId, submitted: true, response: payload.result },
    `Interactive response submitted for ${selected.id}; Codex will continue the turn.\n`, options.json);
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "adversarial-review":
      await handleReviewCommand(argv, {
        reviewName: "Adversarial Review"
      });
      break;
    case "task":
      await handleTask(argv);
      break;
    case "transfer":
      await handleTransfer(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "respond":
      await handleRespond(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
