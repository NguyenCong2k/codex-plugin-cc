import fs from "node:fs";
import process from "node:process";

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
  if (["cancelled", "completed", "failed"].includes(running.status)) throw new Error("Job is already terminal.");
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
    let completionStatus;
    updateJob(job.workspaceRoot, job.id, current => {
      completionStatus = current.cancelRequestedAt || controller.signal.reason?.code === "JOB_CANCELLED" ? "cancelled"
        : controller.signal.aborted || execution.exitStatus !== 0 ? "failed" : "completed";
      return ({
      ...current, status: completionStatus, phase: completionStatus === "completed" ? "done" : completionStatus,
      threadId: execution.threadId ?? current.threadId, turnId: execution.turnId ?? current.turnId,
      pid: null, completedAt: nowIso(), result: execution.payload, rendered: execution.rendered,
      summary: execution.summary, errorMessage: completionStatus === "cancelled" ? current.cancelReason || "Cancelled by user." : null
    }); });
    appendLogBlock(running.logFile, "Final output", execution.rendered);
    if (completionStatus === "cancelled") throw controller.signal.reason ?? Object.assign(new Error("Cancelled by user."), { code: "JOB_CANCELLED" });
    return execution;
  } catch (error) {
    const cancelled = error.code === "JOB_CANCELLED" || controller.signal.reason?.code === "JOB_CANCELLED";
    updateJob(job.workspaceRoot, job.id, current => ({ ...current, status: cancelled ? "cancelled" : "failed",
      phase: cancelled ? "cancelled" : "failed", pid: null, completedAt: nowIso(),
      threadId: error.threadId ?? current.threadId, turnId: error.turnId ?? current.turnId,
      errorMessage: error instanceof Error ? error.message : String(error) }));
    throw error;
  } finally {
    clearInterval(interval); process.removeListener("SIGTERM", onSignal); process.removeListener("SIGINT", onSignal);
  }
}
