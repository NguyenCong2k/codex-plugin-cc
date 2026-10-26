import fs from "node:fs";
import process from "node:process";

import { buildErrorDigest } from "./digest.mjs";
import { appendIncident } from "./incidents.mjs";
import { readJobFile, resolveJobFile, resolveJobLogFile, upsertJob, writeJobFile, updateJob } from "./state.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";

export function nowIso() {
  return new Date().toISOString();
}

function normalizeProgressEvent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      message: String(value.message ?? "").trim(),
      phase: typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : null,
      threadId: typeof value.threadId === "string" && value.threadId.trim() ? value.threadId.trim() : null,
      turnId: typeof value.turnId === "string" && value.turnId.trim() ? value.turnId.trim() : null,
      stderrMessage: value.stderrMessage == null ? null : String(value.stderrMessage).trim(),
      logTitle: typeof value.logTitle === "string" && value.logTitle.trim() ? value.logTitle.trim() : null,
      logBody: value.logBody == null ? null : String(value.logBody).trimEnd()
    };
  }

  return {
    message: String(value ?? "").trim(),
    phase: null,
    threadId: null,
    turnId: null,
    stderrMessage: String(value ?? "").trim(),
    logTitle: null,
    logBody: null
  };
}

export function appendLogLine(logFile, message) {
  const normalized = String(message ?? "").trim();
  if (!logFile || !normalized) {
    return;
  }
  fs.appendFileSync(logFile, `[${nowIso()}] ${normalized}\n`, "utf8");
}

export function appendLogBlock(logFile, title, body) {
  if (!logFile || !body) {
    return;
  }
  fs.appendFileSync(logFile, `\n[${nowIso()}] ${title}\n${String(body).trimEnd()}\n`, "utf8");
}

export function createJobLogFile(workspaceRoot, jobId, title) {
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  if (title) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}

export function createJobRecord(base, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = env[options.sessionIdEnv ?? SESSION_ID_ENV];
  return {
    ...base,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {})
  };
}

export function createJobProgressUpdater(workspaceRoot, jobId) {
  let lastPhase = null;
  let lastThreadId = null;
  let lastTurnId = null;

  return (event) => {
    const normalized = normalizeProgressEvent(event);
    const patch = { id: jobId };
    let changed = false;

    if (normalized.phase && normalized.phase !== lastPhase) {
      lastPhase = normalized.phase;
      patch.phase = normalized.phase;
      changed = true;
    }

    if (normalized.threadId && normalized.threadId !== lastThreadId) {
      lastThreadId = normalized.threadId;
      patch.threadId = normalized.threadId;
      changed = true;
    }

    if (normalized.turnId && normalized.turnId !== lastTurnId) {
      lastTurnId = normalized.turnId;
      patch.turnId = normalized.turnId;
      changed = true;
    }

    if (!changed) {
      return;
    }

    upsertJob(workspaceRoot, patch);

    const jobFile = resolveJobFile(workspaceRoot, jobId);
    if (!fs.existsSync(jobFile)) {
      return;
    }

    const storedJob = readJobFile(jobFile);
    writeJobFile(workspaceRoot, jobId, {
      ...storedJob,
      ...patch
    });
  };
}

export function createProgressReporter({ stderr = false, logFile = null, onEvent = null } = {}) {
  if (!stderr && !logFile && !onEvent) {
    return null;
  }

  return (eventOrMessage) => {
    const event = normalizeProgressEvent(eventOrMessage);
    const stderrMessage = event.stderrMessage ?? event.message;
    if (stderr && stderrMessage) {
      process.stderr.write(`[codex] ${stderrMessage}\n`);
    }
    appendLogLine(logFile, event.message);
    appendLogBlock(logFile, event.logTitle, event.logBody);
    onEvent?.(event);
  };
}

function readStoredJobOrNull(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

export async function runTrackedJob(job, runner, options = {}) {
  const controller = new AbortController();
  const running = updateJob(job.workspaceRoot, job.id, existing => ({
    ...existing, ...job, status: "running", phase: "starting", pid: process.pid,
    startedAt: nowIso(), heartbeatAt: nowIso(), logFile: options.logFile ?? job.logFile ?? null
  }));
  if (["cancelled", "completed", "failed", "timed_out"].includes(running.status)) throw new Error("Job is already terminal.");
  const cancel = reason => controller.abort(Object.assign(new Error(reason), { code: "JOB_CANCELLED" }));
  const poll = () => {
    const stored = readStoredJobOrNull(job.workspaceRoot, job.id);
    if (stored?.cancelRequestedAt) cancel(stored.cancelReason || "Cancelled by user.");
    else updateJob(job.workspaceRoot, job.id, current => ({ ...current, heartbeatAt: nowIso() }));
  };
  const interval = setInterval(() => { try { poll(); } catch (error) { controller.abort(error); } }, 250);
  const onSignal = () => cancel("The owning worker was interrupted by the host.");
  process.once("SIGTERM", onSignal); process.once("SIGINT", onSignal);
  try {
    poll();
    if (controller.signal.aborted) throw controller.signal.reason;
    const execution = await runner(controller.signal);
    const digest = execution.digest
      ? {
          ...execution.digest,
          jobId: job.id,
          logPath: running.logFile,
          worktree: execution.digest.worktree ?? job.worktreePath ?? null
        }
      : null;
    let completionStatus;
    updateJob(job.workspaceRoot, job.id, current => {
      completionStatus = current.cancelRequestedAt || controller.signal.reason?.code === "JOB_CANCELLED" ? "cancelled"
        : controller.signal.aborted || execution.exitStatus !== 0 ? "failed" : "completed";
      return ({
      ...current, status: completionStatus, phase: completionStatus === "completed" ? "done" : completionStatus,
      threadId: execution.threadId ?? current.threadId, turnId: execution.turnId ?? current.turnId,
      pid: null, completedAt: nowIso(), result: execution.payload, rendered: execution.rendered,
      digest, summary: execution.summary, interaction: null, interactions: [],
      errorMessage: completionStatus === "cancelled" ? current.cancelReason || "Cancelled by user." : null
    }); });
    appendLogBlock(running.logFile, "Final output", execution.rendered);
    if (completionStatus === "cancelled") throw controller.signal.reason ?? Object.assign(new Error("Cancelled by user."), { code: "JOB_CANCELLED" });
    return execution;
  } catch (error) {
    const cancelled = error.code === "JOB_CANCELLED" || controller.signal.reason?.code === "JOB_CANCELLED";
    const timedOut = error?.code === "CODEX_TURN_IDLE_TIMEOUT" || error?.code === "CODEX_TURN_HARD_TIMEOUT";
    const terminalStatus = cancelled ? "cancelled" : timedOut ? "timed_out" : "failed";
    const threadId = error.threadId ?? null;
    const turnId = error.turnId ?? null;
    const digest = buildErrorDigest(error, {
      jobId: job.id,
      logPath: running.logFile,
      worktree: job.worktreePath ?? null,
      threadId,
      turnId
    });
    updateJob(job.workspaceRoot, job.id, current => ({
      ...current,
      status: terminalStatus,
      phase: terminalStatus,
      pid: null,
      completedAt: nowIso(),
      threadId: threadId ?? current.threadId,
      turnId: turnId ?? current.turnId,
      interaction: null,
      interactions: [],
      errorCode: typeof error?.code === "string" ? error.code : null,
      digest,
      timeout: timedOut ? { ...error.timeout, automaticRestart: false } : null,
      resume: timedOut && (threadId ?? current.threadId)
        ? {
            automatic: false,
            decisionOwner: "claude",
            threadId: threadId ?? current.threadId,
            command: "/codex:rescue --resume"
          }
        : null,
      errorMessage: error instanceof Error ? error.message : String(error)
    }));
    if (timedOut) {
      appendIncident({
        logPath: job.incidentLog ?? null,
        type: "timeout",
        task: job.title ?? "Codex job",
        did: `Codex turn ${error.timeout?.kind ?? "runtime"} timeout for job ${job.id}.`,
        result: error.message,
        resolution: "Interrupted the owned runtime and preserved a resumable thread; no automatic restart."
      });
      appendLogLine(running.logFile, `Timed out (${error.timeout?.kind ?? "turn"}); automatic restart is disabled.`);
    } else if (cancelled) {
      appendIncident({
        logPath: job.incidentLog ?? null,
        type: "killed_process",
        task: job.title ?? "Codex job",
        did: `Cancelled job ${job.id}; stopped the owned Codex runtime.`,
        result: error instanceof Error ? error.message : String(error),
        resolution: "Cancellation acknowledged by the owner; thread state remains resumable."
      });
    }
    throw error;
  } finally {
    clearInterval(interval); process.removeListener("SIGTERM", onSignal); process.removeListener("SIGINT", onSignal);
  }
}
