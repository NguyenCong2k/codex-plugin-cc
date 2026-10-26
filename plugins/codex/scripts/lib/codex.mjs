/**
 * @typedef {import("./app-server-protocol").AppServerNotification} AppServerNotification
 * @typedef {import("./app-server-protocol").ReviewTarget} ReviewTarget
 * @typedef {import("./app-server-protocol").ThreadItem} ThreadItem
 * @typedef {import("./app-server-protocol").ThreadResumeParams} ThreadResumeParams
 * @typedef {import("./app-server-protocol").ThreadStartParams} ThreadStartParams
 * @typedef {import("./app-server-protocol").Turn} Turn
 * @typedef {import("./app-server-protocol").UserInput} UserInput
 * @typedef {((update: string | { message: string, phase: string | null, threadId?: string | null, turnId?: string | null, stderrMessage?: string | null, logTitle?: string | null, logBody?: string | null }) => void)} ProgressReporter
 * @typedef {{
 *   threadId: string,
 *   rootThreadId: string,
 *   threadIds: Set<string>,
 *   threadTurnIds: Map<string, string>,
 *   threadLabels: Map<string, string>,
 *   turnId: string | null,
 *   bufferedNotifications: AppServerNotification[],
 *   completion: Promise<TurnCaptureState>,
 *   resolveCompletion: (state: TurnCaptureState) => void,
 *   rejectCompletion: (error: unknown) => void,
 *   finalTurn: Turn | null,
 *   completed: boolean,
 *   finalAnswerSeen: boolean,
 *   pendingCollaborations: Set<string>,
 *   activeSubagentTurns: Set<string>,
 *   completionTimer: ReturnType<typeof setTimeout> | null,
 *   lastAgentMessage: string,
 *   reviewText: string,
 *   reasoningSummary: string[],
 *   error: unknown,
 *   messages: Array<{ lifecycle: string, phase: string | null, text: string }>,
 *   fileChanges: ThreadItem[],
 *   commandExecutions: ThreadItem[],
 *   onProgress: ProgressReporter | null
 * }} TurnCaptureState
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readJsonFile } from "./fs.mjs";
import { CodexAppServerClient, durationSetting } from "./app-server.mjs";
import { getGitMetadataDirs } from "./git.mjs";
import { appendIncident } from "./incidents.mjs";
import { autoApprovalResponse, describeApprovalRequest, waitForInteractionResponse } from "./interaction.mjs";
import { binaryAvailable } from "./process.mjs";

const SERVICE_NAME = "claude_code_codex_plugin";
const TASK_THREAD_PREFIX = "Codex Companion Task";
const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current thread state. Pick the next highest-value step and follow through until the task is resolved.";
const EXTERNAL_AGENT_IMPORT_COMPLETED = "externalAgentConfig/import/completed";
const EXTERNAL_AGENT_IMPORT_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_TURN_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_TURN_HARD_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const TURN_TIMEOUT_WARNING_RATIO = 0.8;

function cleanCodexStderr(stderr) {
  return stderr
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line && !line.startsWith("WARNING: proceeding, even though we could not update PATH:"))
    .join("\n");
}

/** @returns {ThreadStartParams} */
function buildThreadParams(cwd, options = {}) {
  return {
    cwd,
    model: options.model ?? null,
    approvalPolicy: options.approvalPolicy ?? null,
    sandbox: options.sandbox ?? "read-only",
    serviceName: SERVICE_NAME,
    ephemeral: options.ephemeral ?? true
  };
}

/** @returns {ThreadResumeParams} */
function buildResumeParams(threadId, cwd, options = {}) {
  return {
    threadId,
    cwd,
    model: options.model ?? null,
    approvalPolicy: options.approvalPolicy ?? null,
    sandbox: options.sandbox ?? "read-only"
  };
}

/** @returns {UserInput[]} */
function buildTurnInput(prompt) {
  return [{ type: "text", text: prompt, text_elements: [] }];
}

function pathWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function buildSandboxPolicy(cwd, sandbox) {
  if (sandbox === "danger-full-access") {
    return { type: "dangerFullAccess" };
  }
  if (sandbox === "workspace-write") {
    const writableRoots = [cwd];
    try {
      for (const dir of getGitMetadataDirs(cwd)) {
        if (!pathWithin(cwd, dir)) {
          writableRoots.push(dir);
        }
      }
    } catch {
      // Keep the checkout root writable even when git metadata cannot be read.
    }
    return { type: "workspaceWrite", writableRoots, networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
  }
  return { type: "readOnly", networkAccess: false };
}

function shorten(text, limit = 72) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${Array.from(normalized).slice(0, limit - 3).join("")}...`;
}

function looksLikeVerificationCommand(command) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    command
  );
}

function buildTaskThreadName(prompt) {
  const excerpt = shorten(prompt, 56);
  return excerpt ? `${TASK_THREAD_PREFIX}: ${excerpt}` : TASK_THREAD_PREFIX;
}

function extractThreadId(message) {
  return message?.params?.threadId ?? null;
}

function extractTurnId(message) {
  if (message?.params?.turnId) {
    return message.params.turnId;
  }
  if (message?.params?.turn?.id) {
    return message.params.turn.id;
  }
  return null;
}

function collectTouchedFiles(fileChanges) {
  const paths = new Set();
  for (const fileChange of fileChanges) {
    for (const change of fileChange.changes ?? []) {
      if (change.path) {
        paths.add(change.path);
      }
    }
  }
  return [...paths];
}

function normalizeReasoningText(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function extractReasoningSections(value) {
  if (!value) {
    return [];
  }

  if (typeof value === "string") {
    const normalized = normalizeReasoningText(value);
    return normalized ? [normalized] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractReasoningSections(entry));
  }

  if (typeof value === "object") {
    if (typeof value.text === "string") {
      return extractReasoningSections(value.text);
    }
    if ("summary" in value) {
      return extractReasoningSections(value.summary);
    }
    if ("content" in value) {
      return extractReasoningSections(value.content);
    }
    if ("parts" in value) {
      return extractReasoningSections(value.parts);
    }
  }

  return [];
}

function mergeReasoningSections(existingSections, nextSections) {
  const merged = [];
  for (const section of [...existingSections, ...nextSections]) {
    const normalized = normalizeReasoningText(section);
    if (!normalized || merged.includes(normalized)) {
      continue;
    }
    merged.push(normalized);
  }
  return merged;
}

/**
 * @param {ProgressReporter | null | undefined} onProgress
 * @param {string | null | undefined} message
 * @param {string | null | undefined} [phase]
 */
function emitProgress(onProgress, message, phase = null, extra = {}) {
  if (!onProgress || !message) {
    return;
  }
  if (!phase && Object.keys(extra).length === 0) {
    onProgress(message);
    return;
  }
  onProgress({ message, phase, ...extra });
}

function emitLogEvent(onProgress, options = {}) {
  if (!onProgress) {
    return;
  }

  onProgress({
    message: options.message ?? "",
    phase: options.phase ?? null,
    stderrMessage: options.stderrMessage ?? null,
    logTitle: options.logTitle ?? null,
    logBody: options.logBody ?? null
  });
}

function labelForThread(state, threadId) {
  if (!threadId || threadId === state.rootThreadId || threadId === state.threadId) {
    return null;
  }
  return state.threadLabels.get(threadId) ?? threadId;
}

function registerThread(state, threadId, options = {}) {
  if (!threadId) {
    return;
  }

  state.threadIds.add(threadId);
  const label =
    options.threadName ??
    options.name ??
    options.agentNickname ??
    options.agentRole ??
    state.threadLabels.get(threadId) ??
    null;
  if (label) {
    state.threadLabels.set(threadId, label);
  }
}

function describeStartedItem(state, item) {
  switch (item.type) {
    case "enteredReviewMode":
      return { message: `Reviewer started: ${item.review}`, phase: "reviewing" };
    case "commandExecution":
      return {
        message: `Running command: ${shorten(item.command, 96)}`,
        phase: looksLikeVerificationCommand(item.command) ? "verifying" : "running"
      };
    case "fileChange":
      return { message: `Applying ${(item.changes ?? []).length} file change(s).`, phase: "editing" };
    case "mcpToolCall":
      return { message: `Calling ${item.server}/${item.tool}.`, phase: "investigating" };
    case "dynamicToolCall":
      return { message: `Running tool: ${item.tool}.`, phase: "investigating" };
    case "collabAgentToolCall": {
      const subagents = (item.receiverThreadIds ?? []).map((threadId) => labelForThread(state, threadId) ?? threadId);
      const summary =
        subagents.length > 0
          ? `Starting subagent ${subagents.join(", ")} via collaboration tool: ${item.tool}.`
          : `Starting collaboration tool: ${item.tool}.`;
      return { message: summary, phase: "investigating" };
    }
    case "webSearch":
      return { message: `Searching: ${shorten(item.query, 96)}`, phase: "investigating" };
    default:
      return null;
  }
}

function describeCompletedItem(state, item) {
  switch (item.type) {
    case "commandExecution": {
      const exitCode = item.exitCode ?? "?";
      const statusLabel = item.status === "completed" ? "completed" : item.status;
      return {
        message: `Command ${statusLabel}: ${shorten(item.command, 96)} (exit ${exitCode})`,
        phase: looksLikeVerificationCommand(item.command) ? "verifying" : "running"
      };
    }
    case "fileChange":
      return { message: `File changes ${item.status}.`, phase: "editing" };
    case "mcpToolCall":
      return { message: `Tool ${item.server}/${item.tool} ${item.status}.`, phase: "investigating" };
    case "dynamicToolCall":
      return { message: `Tool ${item.tool} ${item.status}.`, phase: "investigating" };
    case "collabAgentToolCall": {
      const subagents = (item.receiverThreadIds ?? []).map((threadId) => labelForThread(state, threadId) ?? threadId);
      const summary =
        subagents.length > 0
          ? `Subagent ${subagents.join(", ")} ${item.status}.`
          : `Collaboration tool ${item.tool} ${item.status}.`;
      return { message: summary, phase: "investigating" };
    }
    case "exitedReviewMode":
      return { message: "Reviewer finished.", phase: "finalizing" };
    default:
      return null;
  }
}

/** @returns {TurnCaptureState} */
function createTurnCaptureState(threadId, options = {}) {
  let resolveCompletion;
  let rejectCompletion;
  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  return {
    threadId,
    rootThreadId: threadId,
    threadIds: new Set([threadId]),
    threadTurnIds: new Map(),
    threadLabels: new Map(),
    turnId: null,
    bufferedNotifications: [],
    completion,
    resolveCompletion,
    rejectCompletion,
    finalTurn: null,
    completed: false,
    finalAnswerSeen: false,
    pendingCollaborations: new Set(),
    activeSubagentTurns: new Set(),
    completionTimer: null,
    lastAgentMessage: "",
    reviewText: "",
    reasoningSummary: [],
    error: null,
    messages: [],
    fileChanges: [],
    commandExecutions: [],
    onProgress: options.onProgress ?? null
  };
}

function clearCompletionTimer(state) {
  if (state.completionTimer) {
    clearTimeout(state.completionTimer);
    state.completionTimer = null;
  }
}

function completeTurn(state, turn = null, options = {}) {
  if (state.completed) {
    return;
  }

  clearCompletionTimer(state);
  state.completed = true;

  if (turn) {
    state.finalTurn = turn;
    if (!state.turnId) {
      state.turnId = turn.id;
    }
  } else if (!state.finalTurn) {
    state.finalTurn = {
      id: state.turnId ?? "inferred-turn",
      status: "completed"
    };
  }

  if (options.inferred) {
    emitProgress(state.onProgress, "Turn completion inferred after the main thread finished and subagent work drained.", "finalizing");
  }

  state.resolveCompletion(state);
}

function belongsToTurn(state, message) {
  const messageThreadId = extractThreadId(message);
  if (!messageThreadId || !state.threadIds.has(messageThreadId)) {
    return false;
  }
  const trackedTurnId = state.threadTurnIds.get(messageThreadId) ?? null;
  const messageTurnId = extractTurnId(message);
  return trackedTurnId === null || messageTurnId === null || messageTurnId === trackedTurnId;
}

function recordItem(state, item, lifecycle, threadId = null) {
  if (item.type === "collabAgentToolCall") {
    if (!threadId || threadId === state.threadId) {
      if (lifecycle === "started" || item.status === "inProgress") {
        state.pendingCollaborations.add(item.id);
      } else if (lifecycle === "completed") {
        state.pendingCollaborations.delete(item.id);
        // Completion is authoritative only when the root turn finishes.
      }
    }
    for (const receiverThreadId of item.receiverThreadIds ?? []) {
      registerThread(state, receiverThreadId);
    }
  }

  if (item.type === "agentMessage") {
    state.messages.push({
      lifecycle,
      phase: item.phase ?? null,
      text: item.text ?? ""
    });
    if (item.text) {
      if (!threadId || threadId === state.threadId) {
        state.lastAgentMessage = item.text;
        if (lifecycle === "completed" && item.phase === "final_answer") {
          state.finalAnswerSeen = true;
          // Completion is authoritative only when the root turn finishes.
        }
      }
      if (lifecycle === "completed") {
        const sourceLabel = labelForThread(state, threadId);
        emitLogEvent(state.onProgress, {
          message: sourceLabel ? `Subagent ${sourceLabel}: ${shorten(item.text, 96)}` : `Assistant message captured: ${shorten(item.text, 96)}`,
          stderrMessage: null,
          phase: item.phase === "final_answer" ? "finalizing" : null,
          logTitle: sourceLabel ? `Subagent ${sourceLabel} message` : "Assistant message",
          logBody: item.text
        });
      }
    }
    return;
  }

  if (item.type === "exitedReviewMode") {
    state.reviewText = item.review ?? "";
    if (lifecycle === "completed" && item.review) {
      emitLogEvent(state.onProgress, {
        message: "Review output captured.",
        stderrMessage: null,
        phase: "finalizing",
        logTitle: "Review output",
        logBody: item.review
      });
    }
    return;
  }

  if (item.type === "reasoning" && lifecycle === "completed") {
    const nextSections = extractReasoningSections(item.summary);
    state.reasoningSummary = mergeReasoningSections(state.reasoningSummary, nextSections);
    if (nextSections.length > 0) {
      const sourceLabel = labelForThread(state, threadId);
      emitLogEvent(state.onProgress, {
        message: sourceLabel
          ? `Subagent ${sourceLabel} reasoning: ${shorten(nextSections[0], 96)}`
          : `Reasoning summary captured: ${shorten(nextSections[0], 96)}`,
        stderrMessage: null,
        logTitle: sourceLabel ? `Subagent ${sourceLabel} reasoning summary` : "Reasoning summary",
        logBody: nextSections.map((section) => `- ${section}`).join("\n")
      });
    }
    return;
  }

  if (item.type === "fileChange" && lifecycle === "completed") {
    state.fileChanges.push(item);
    return;
  }

  if (item.type === "commandExecution" && lifecycle === "completed") {
    state.commandExecutions.push(item);
  }
}

function applyTurnNotification(state, message) {
  switch (message.method) {
    case "thread/started":
      registerThread(state, message.params.thread.id, {
        threadName: message.params.thread.name,
        name: message.params.thread.name,
        agentNickname: message.params.thread.agentNickname,
        agentRole: message.params.thread.agentRole
      });
      break;
    case "thread/name/updated":
      registerThread(state, message.params.threadId, {
        threadName: message.params.threadName ?? null
      });
      break;
    case "turn/started":
      registerThread(state, message.params.threadId);
      state.threadTurnIds.set(message.params.threadId, message.params.turn.id);
      if ((message.params.threadId ?? null) !== state.threadId) {
        state.activeSubagentTurns.add(message.params.threadId);
      }
      emitProgress(
        state.onProgress,
        `Turn started (${message.params.turn.id}).`,
        "starting",
        (message.params.threadId ?? null) === state.threadId
          ? {
              threadId: message.params.threadId ?? null,
              turnId: message.params.turn.id ?? null
            }
          : {}
      );
      break;
    case "item/started":
      recordItem(state, message.params.item, "started", message.params.threadId ?? null);
      {
        const update = describeStartedItem(state, message.params.item);
        emitProgress(state.onProgress, update?.message, update?.phase ?? null);
      }
      break;
    case "item/completed":
      recordItem(state, message.params.item, "completed", message.params.threadId ?? null);
      {
        const update = describeCompletedItem(state, message.params.item);
        emitProgress(state.onProgress, update?.message, update?.phase ?? null);
      }
      break;
    case "error":
      state.error = message.params.willRetry === true ? null : message.params.error;
      if (message.params.willRetry !== true && (message.params.threadId ?? state.threadId) === state.threadId) {
        completeTurn(state, { id: state.turnId, status: "failed", items: [], error: message.params.error });
      }
      emitProgress(state.onProgress, `Codex error: ${message.params.error.message}`, "failed");
      break;
    case "turn/completed":
      if ((message.params.threadId ?? null) !== state.threadId) {
        state.activeSubagentTurns.delete(message.params.threadId);
        // Completion is authoritative only when the root turn finishes.
        break;
      }
      emitProgress(
        state.onProgress,
        `Turn ${message.params.turn.status === "completed" ? "completed" : message.params.turn.status}.`,
        "finalizing"
      );
      completeTurn(state, message.params.turn);
      break;
    default:
      break;
  }
}

function formatTimeoutDuration(milliseconds) {
  const seconds = Math.max(1, Math.round(milliseconds / 1000));
  if (seconds % 3600 === 0) return `${seconds / 3600} hour${seconds === 3600 ? "" : "s"}`;
  if (seconds % 60 === 0) return `${seconds / 60} minute${seconds === 60 ? "" : "s"}`;
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

function createTurnTimeoutError(kind, state, startedAt, lastActivityAt, limitMs) {
  const now = Date.now();
  const idle = kind === "idle";
  return Object.assign(
    new Error(
      idle
        ? `Codex turn timed out after ${formatTimeoutDuration(limitMs)} without runtime activity. The saved thread and current working tree were preserved. Claude must decide whether to resume; the plugin did not restart it.`
        : `Codex turn reached its ${formatTimeoutDuration(limitMs)} hard runtime limit. The saved thread and current working tree were preserved. Claude must decide whether to resume; the plugin did not restart it.`
    ),
    {
      name: "CodexTurnTimeoutError",
      code: idle ? "CODEX_TURN_IDLE_TIMEOUT" : "CODEX_TURN_HARD_TIMEOUT",
      timeout: {
        kind,
        limitMs,
        elapsedMs: Math.max(0, now - startedAt),
        inactiveMs: Math.max(0, now - lastActivityAt),
        threadId: state.threadId,
        turnId: state.turnId,
        automaticRestart: false,
        interruptAcknowledged: false
      }
    }
  );
}

function createTurnWatchdog(state, options = {}) {
  const idleTimeoutMs = durationSetting(
    options.idleTimeoutMs ?? process.env.CODEX_COMPANION_TURN_IDLE_TIMEOUT_MS,
    DEFAULT_TURN_IDLE_TIMEOUT_MS
  );
  const hardTimeoutMs = durationSetting(
    options.hardTimeoutMs ?? options.timeoutMs ?? process.env.CODEX_COMPANION_TURN_HARD_TIMEOUT_MS ?? process.env.CODEX_COMPANION_TURN_TIMEOUT_MS,
    DEFAULT_TURN_HARD_TIMEOUT_MS
  );
  const startedAt = Date.now();
  let lastActivityAt = startedAt;
  let pauseDepth = 0;
  let settled = false;
  let idleWarningTimer = null;
  let idleTimer = null;
  let hardWarningTimer = null;
  let hardTimer = null;
  let rejectTimeout;
  const promise = new Promise((_, reject) => { rejectTimeout = reject; });

  const clearIdleTimers = () => {
    clearTimeout(idleWarningTimer);
    clearTimeout(idleTimer);
    idleWarningTimer = null;
    idleTimer = null;
  };
  const warn = (kind, limitMs) => {
    if (settled) return;
    const label = kind === "idle" ? "idle timeout" : "hard runtime limit";
    emitProgress(
      state.onProgress,
      `Codex turn is approaching its ${formatTimeoutDuration(limitMs)} ${label}; the plugin will preserve the thread and let Claude decide whether to resume.`,
      null
    );
  };
  const expire = (kind, limitMs) => {
    if (settled) return;
    settled = true;
    clearIdleTimers();
    clearTimeout(hardWarningTimer);
    clearTimeout(hardTimer);
    rejectTimeout(createTurnTimeoutError(kind, state, startedAt, lastActivityAt, limitMs));
  };
  const armIdleTimers = () => {
    clearIdleTimers();
    if (settled || pauseDepth > 0) return;
    const elapsedIdle = Date.now() - lastActivityAt;
    const warningAt = idleTimeoutMs * TURN_TIMEOUT_WARNING_RATIO;
    if (elapsedIdle < warningAt) {
      idleWarningTimer = setTimeout(() => warn("idle", idleTimeoutMs), warningAt - elapsedIdle);
    }
    idleTimer = setTimeout(() => expire("idle", idleTimeoutMs), Math.max(0, idleTimeoutMs - elapsedIdle));
  };
  const touch = () => {
    if (settled) return;
    lastActivityAt = Date.now();
    armIdleTimers();
  };
  const pause = () => {
    if (settled) return;
    pauseDepth += 1;
    clearIdleTimers();
  };
  const resume = () => {
    if (settled || pauseDepth === 0) return;
    pauseDepth -= 1;
    if (pauseDepth === 0) touch();
  };
  const dispose = () => {
    settled = true;
    clearIdleTimers();
    clearTimeout(hardWarningTimer);
    clearTimeout(hardTimer);
  };

  hardWarningTimer = setTimeout(() => warn("hard", hardTimeoutMs), hardTimeoutMs * TURN_TIMEOUT_WARNING_RATIO);
  hardTimer = setTimeout(() => expire("hard", hardTimeoutMs), hardTimeoutMs);
  armIdleTimers();
  return { promise, touch, pause, resume, dispose, idleTimeoutMs, hardTimeoutMs };
}

export async function captureTurn(client, threadId, startRequest, options = {}) {
  if (options.signal?.aborted) throw options.signal.reason ?? new Error("Codex job cancelled.");
  const state = createTurnCaptureState(threadId, options);
  const previousHandler = client.notificationHandler;
  const watchdog = createTurnWatchdog(state, options);
  const activity = options.activity ?? null;
  if (activity) {
    activity.touch = watchdog.touch;
    activity.pause = watchdog.pause;
    activity.resume = watchdog.resume;
  }
  let startResponded = false;
  const accept = message => {
    if (message.method === "thread/started" || message.method === "thread/name/updated" || belongsToTurn(state, message)) {
      watchdog.touch();
      applyTurnNotification(state, message);
    } else previousHandler?.(message);
  };
  client.setNotificationHandler(message => {
    if (!startResponded) {
      watchdog.touch();
      state.bufferedNotifications.push(message);
    }
    else accept(message);
  });
  const aborted = new Promise((_, reject) => {
    options.signal?.addEventListener("abort", abort, { once: true });
    function abort() { reject(options.signal.reason ?? new Error("Codex job cancelled.")); }
    if (options.signal?.aborted) abort();
    options.cleanupAbort = () => options.signal?.removeEventListener("abort", abort);
  });
  const disconnected = client.exitPromise.then(() => { throw client.exitError ?? new Error("Codex connection closed before turn completion."); });
  const lifecycle = (async () => {
    const response = await startRequest();
    watchdog.touch();
    options.onResponse?.(response, state);
    state.turnId = response.turn?.id ?? null;
    if (state.turnId) state.threadTurnIds.set(state.threadId, state.turnId);
    startResponded = true;
    for (const message of state.bufferedNotifications) accept(message);
    state.bufferedNotifications.length = 0;
    if (response.turn?.status && response.turn.status !== "inProgress") completeTurn(state, response.turn);
    return state.completion;
  })();
  try { return await Promise.race([lifecycle, disconnected, watchdog.promise, aborted]); }
  catch (error) {
    // Do not retry the turn. Interrupt the same owned runtime, then close it.
    let interruptAcknowledged = false;
    if (state.turnId && !client.closed) {
      interruptAcknowledged = await Promise.race([
        client.request("turn/interrupt", { threadId: state.threadId, turnId: state.turnId }).then(() => true).catch(() => false),
        new Promise(resolve => setTimeout(() => resolve(false), 1000))
      ]);
    }
    if (error?.timeout) {
      error.timeout = {
        ...error.timeout,
        threadId: state.threadId,
        turnId: state.turnId,
        interruptAcknowledged
      };
    }
    throw Object.assign(error, { threadId: state.threadId, turnId: state.turnId });
  } finally {
    watchdog.dispose();
    if (activity) {
      activity.touch = () => {};
      activity.pause = () => {};
      activity.resume = () => {};
    }
    options.cleanupAbort?.();
    clearCompletionTimer(state); client.setNotificationHandler(previousHandler ?? null);
  }
}

function buildServerRequestHandler(cwd, options = {}) {
  if (!options.jobId || !options.workspaceRoot) return undefined;
  return async message => {
    const approval = describeApprovalRequest(message);
    const incident = {
      logPath: options.incidentLog ?? process.env.CODEX_COMPANION_INCIDENT_LOG ?? null,
      type: "blocked",
      task: options.incidentTask ?? "Codex task",
      did: approval.command
        ? `Codex requested ${message.method} for: ${approval.command}`
        : `Codex requested ${message.method}.`,
      result: approval.reason ? `Reason: ${approval.reason}` : `Approval kind: ${approval.kind}.`,
      resolution: "Waiting for /codex:respond.",
      suggestion: "Use --full-access for an explicit no-approval job."
    };

    if (options.fullAccess) {
      const response = autoApprovalResponse(message);
      if (response) {
        appendIncident({
          ...incident,
          type: "other",
          did: `${approval.method} (${approval.kind})`,
          resolution: "Auto-accepted because full_access is enabled; no user confirmation was requested."
        });
        return response;
      }
      const detail = `Full access could not answer ${message.method}: this request needs explicit content, not a blanket approval. Resume the saved thread in Codex to provide input.`;
      appendIncident({
        ...incident,
        type: "blocked",
        result: detail,
        resolution: "Job stopped with a blocked digest; no fabricated response was sent."
      });
      throw Object.assign(new Error(detail), { code: "CODEX_APPROVAL_REQUIRED", approval });
    }

    appendIncident(incident);
    options.activity?.pause();
    try {
      return await waitForInteractionResponse({
        workspaceRoot: options.workspaceRoot,
        jobId: options.jobId,
        message,
        signal: options.signal,
        timeoutMs: options.interactionTimeoutMs ?? (Number(process.env.CODEX_COMPANION_INTERACTION_TIMEOUT_MS) || undefined),
        onProgress: options.onProgress
      });
    } catch (error) {
      if (error?.code === "JOB_CANCELLED") {
        throw error;
      }
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
        code: "CODEX_APPROVAL_REQUIRED",
        approval
      });
    } finally {
      options.activity?.resume();
    }
  };
}

async function withAppServer(cwd, fn, options = {}) {
  // A fresh owned process loads the persisted thread and current config. No
  // global runtime, stale credentials, ownership ambiguity, or replay fallback.
  const activity = { touch() {}, pause() {}, resume() {} };
  const client = await CodexAppServerClient.connect(cwd, {
    serverRequestHandler: buildServerRequestHandler(cwd, { ...options, activity })
  });
  try { return await fn(client, activity); } finally { await client.close(); }
}

async function withDirectAppServer(cwd, fn) {
  const client = await CodexAppServerClient.connect(cwd);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

function resolveCodexHome() {
  return path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
}

function sourceContentSha256(sourcePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex");
}

export function importedThreadIdForSource(sourcePath, expectedHash = null, previousIds = null) {
  const ledgerPath = path.join(resolveCodexHome(), "external_agent_session_imports.json");
  if (!fs.existsSync(ledgerPath)) {
    return null;
  }
  const ledger = readJsonFile(ledgerPath);
  const canonicalSource = fs.realpathSync(sourcePath);
  const contentSha256 = expectedHash;
  const records = Array.isArray(ledger?.records) ? ledger.records : [];
  const match = records
    .filter(
      (record) =>
        normalizeImportPath(record?.source_path) === normalizeImportPath(canonicalSource) &&
        (contentSha256 === null || record?.content_sha256 === contentSha256 || (previousIds && !previousIds.has(record.imported_thread_id))) &&
        typeof record?.imported_thread_id === "string"
    )
    .at(-1);
  return match?.imported_thread_id ?? null;
}

function normalizeImportPath(value) {
  if (typeof value !== "string") return "";
  let result = value;
  if (result.toUpperCase().startsWith("\\\\?\\UNC\\")) result = "\\\\" + result.slice(8);
  else if (result.startsWith("\\\\?\\")) result = result.slice(4);
  return process.platform === "win32" ? result.replaceAll("/", "\\").toLowerCase() : result;
}

function externalAgentSessionMigration(sourcePath, cwd) {
  return {
    migrationItems: [
      {
        itemType: "SESSIONS",
        description: `Transfer Claude session ${path.basename(sourcePath)}`,
        cwd: null,
        details: {
          plugins: [],
          sessions: [{ path: sourcePath, cwd, title: null }],
          mcpServers: [],
          hooks: [],
          subagents: [],
          commands: []
        }
      }
    ]
  };
}

async function requestExternalAgentSessionImport(client, params) {
  const previousHandler = client.notificationHandler;
  let timeout = null;
  let resolveCompleted;
  let rejectCompleted;
  const completed = new Promise((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });
  void completed.catch(() => {});

  client.setNotificationHandler((message) => {
    if (message.method === EXTERNAL_AGENT_IMPORT_COMPLETED) {
      resolveCompleted();
      return;
    }
    previousHandler?.(message);
  });
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error("Timed out waiting for Codex to finish importing the Claude session.")), EXTERNAL_AGENT_IMPORT_TIMEOUT_MS);
  });

  try {
    await Promise.race([Promise.all([client.request("externalAgentConfig/import", params), completed]), deadline]);
  } finally {
    clearTimeout(timeout);
    client.setNotificationHandler(previousHandler ?? null);
  }
}

async function startThread(client, cwd, options = {}) {
  const response = await client.request("thread/start", buildThreadParams(cwd, options));
  const threadId = response.thread.id;
  if (options.threadName) {
    try {
      await client.request("thread/name/set", { threadId, name: options.threadName });
    } catch (err) {
      // Only suppress "unknown variant/method" errors from older CLI versions
      // that don't support thread/name/set. Rethrow auth, network, or server errors.
      const msg = String(err?.message ?? err ?? "");
      if (!msg.includes("unknown variant") && !msg.includes("unknown method")) {
        throw Object.assign(err, { threadId });
      }
    }
  }
  return response;
}

async function resumeThread(client, threadId, cwd, options = {}) {
  return client.request("thread/resume", buildResumeParams(threadId, cwd, options));
}

function buildResultStatus(turnState) {
  return turnState.finalTurn?.status === "completed" && !turnState.error ? 0 : 1;
}

const BUILTIN_PROVIDER_LABELS = new Map([
  ["openai", "OpenAI"],
  ["ollama", "Ollama"],
  ["lmstudio", "LM Studio"]
]);

function normalizeProviderId(value) {
  const providerId = typeof value === "string" ? value.trim() : "";
  return providerId || null;
}

function formatProviderLabel(providerId, providerConfig = null) {
  const configuredName = typeof providerConfig?.name === "string" ? providerConfig.name.trim() : "";
  if (configuredName) {
    return configuredName;
  }
  if (!providerId) {
    return "The active provider";
  }
  return BUILTIN_PROVIDER_LABELS.get(providerId) ?? providerId;
}

function buildAuthStatus(fields = {}) {
  return {
    available: true,
    loggedIn: false,
    detail: "not authenticated",
    source: "unknown",
    authMethod: null,
    verified: null,
    requiresOpenaiAuth: null,
    provider: null,
    ...fields
  };
}

function resolveProviderConfig(configResponse) {
  const config = configResponse?.config;
  if (!config || typeof config !== "object") {
    return {
      providerId: null,
      providerConfig: null
    };
  }

  const providerId = normalizeProviderId(config.model_provider);
  const providers =
    config.model_providers && typeof config.model_providers === "object" && !Array.isArray(config.model_providers)
      ? config.model_providers
      : null;
  const providerConfig =
    providerId && providers?.[providerId] && typeof providers[providerId] === "object" ? providers[providerId] : null;

  return {
    providerId,
    providerConfig
  };
}

function buildAppServerAuthStatus(accountResponse, configResponse) {
  const account = accountResponse?.account ?? null;
  const requiresOpenaiAuth =
    typeof accountResponse?.requiresOpenaiAuth === "boolean" ? accountResponse.requiresOpenaiAuth : null;
  const { providerId, providerConfig } = resolveProviderConfig(configResponse);
  const providerLabel = formatProviderLabel(providerId, providerConfig);

  if (account?.type === "chatgpt") {
    const email = typeof account.email === "string" && account.email.trim() ? account.email.trim() : null;
    return buildAuthStatus({
      loggedIn: true,
      detail: email ? `ChatGPT login active for ${email}` : "ChatGPT login active",
      source: "app-server",
      authMethod: "chatgpt",
      verified: true,
      requiresOpenaiAuth,
      provider: providerId
    });
  }

  if (account?.type === "apiKey") {
    return buildAuthStatus({
      loggedIn: true,
      detail: "API key configured (unverified)",
      source: "app-server",
      authMethod: "apiKey",
      verified: false,
      requiresOpenaiAuth,
      provider: providerId
    });
  }

  if (requiresOpenaiAuth === false) {
    return buildAuthStatus({
      loggedIn: true,
      detail: `${providerLabel} is configured and does not require OpenAI authentication`,
      source: "app-server",
      requiresOpenaiAuth,
      provider: providerId
    });
  }

  return buildAuthStatus({
    loggedIn: false,
    detail: `${providerLabel} requires OpenAI authentication`,
    source: "app-server",
    requiresOpenaiAuth,
    provider: providerId
  });
}

async function getCodexAuthStatusFromClient(client, cwd) {
  try {
    const accountResponse = await client.request("account/read", { refreshToken: false });
    const configResponse = await client.request("config/read", {
      includeLayers: false,
      cwd
    });

    return buildAppServerAuthStatus(accountResponse, configResponse);
  } catch (error) {
    return buildAuthStatus({
      loggedIn: false,
      detail: error instanceof Error ? error.message : String(error),
      source: "app-server"
    });
  }
}

export function getCodexAvailability(cwd) {
  const versionStatus = binaryAvailable("codex", ["--version"], { cwd });
  if (!versionStatus.available) {
    return versionStatus;
  }

  const appServerStatus = binaryAvailable("codex", ["app-server", "--help"], { cwd });
  if (!appServerStatus.available) {
    return {
      available: false,
      detail: `${versionStatus.detail}; advanced runtime unavailable: ${appServerStatus.detail}`
    };
  }

  return {
    available: true,
    detail: `${versionStatus.detail}; advanced runtime available`
  };
}

export function getSessionRuntimeStatus() {
  return { mode: "direct", label: "owned runtime", endpoint: null,
    detail: "Each Codex job owns one runtime. Stored thread IDs preserve resume across runs." };
}

export async function getCodexAuthStatus(cwd, options = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    return {
      available: false,
      loggedIn: false,
      detail: availability.detail,
      source: "availability",
      authMethod: null,
      verified: null,
      requiresOpenaiAuth: null,
      provider: null
    };
  }

  let client = null;
  try {
    client = await CodexAppServerClient.connect(cwd, {
      env: options.env
    });
    return await getCodexAuthStatusFromClient(client, cwd);
  } catch (error) {
    return buildAuthStatus({
      loggedIn: false,
      detail: error instanceof Error ? error.message : String(error),
      source: "app-server"
    });
  } finally {
    if (client) {
      await client.close().catch(() => {});
    }
  }
}

export async function runAppServerReview(cwd, options = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }

  return withAppServer(cwd, async (client, activity) => {
    emitProgress(options.onProgress, "Starting Codex review thread.", "starting");
    const thread = await startThread(client, cwd, {
      model: options.model,
      approvalPolicy: options.approvalPolicy ?? null,
      sandbox: options.sandbox ?? "read-only",
      ephemeral: true,
      threadName: options.threadName
    });
    const sourceThreadId = thread.thread.id;
    emitProgress(options.onProgress, `Thread ready (${sourceThreadId}).`, "starting", {
      threadId: sourceThreadId
    });
    const delivery = options.delivery ?? "inline";

    const turnState = await captureTurn(
      client,
      sourceThreadId,
      () =>
        client.request("review/start", {
          threadId: sourceThreadId,
          delivery,
          target: options.target
        }),
      {
        onProgress: options.onProgress,
        signal: options.signal,
        activity,
        idleTimeoutMs: options.idleTimeoutMs,
        hardTimeoutMs: options.hardTimeoutMs,
        timeoutMs: options.timeoutMs,
        onResponse(response, state) {
          if (response.reviewThreadId) {
            state.threadIds.add(response.reviewThreadId);
            if (delivery === "detached") {
              state.threadId = response.reviewThreadId;
            }
          }
        }
      }
    );

    return {
      status: buildResultStatus(turnState),
      threadId: turnState.threadId,
      sourceThreadId,
      turnId: turnState.turnId,
      reviewText: turnState.reviewText,
      reasoningSummary: turnState.reasoningSummary,
      turn: turnState.finalTurn,
      error: turnState.error,
      stderr: cleanCodexStderr(client.stderr)
    };
  }, options);
}

export async function importExternalAgentSession(cwd, options = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }
  if (!options.sourcePath) {
    throw new Error("A Claude session source path is required.");
  }

  const expectedHash = sourceContentSha256(options.sourcePath);
  const ledgerPath = path.join(resolveCodexHome(), "external_agent_session_imports.json");
  const previousIds = new Set((fs.existsSync(ledgerPath) ? readJsonFile(ledgerPath).records ?? [] : []).map(record => record.imported_thread_id));

  return withDirectAppServer(cwd, async (client) => {
    emitProgress(options.onProgress, "Importing Claude session into Codex.", "transferring");
    try {
      await requestExternalAgentSessionImport(client, externalAgentSessionMigration(options.sourcePath, cwd));
    } catch (error) {
      if (error?.rpcCode === -32601) {
        throw new Error(
          "This Codex version does not support Claude session transfer. Update Codex with `npm install -g @openai/codex@latest`, then retry.",
          { cause: error }
        );
      }
      throw error;
    }
    const threadId = importedThreadIdForSource(options.sourcePath, expectedHash, previousIds);
    if (!threadId) {
      const stderr = cleanCodexStderr(client.stderr);
      throw new Error(
        `Codex reported that the Claude import completed, but did not record an imported thread.${stderr ? `\n${stderr}` : " Check the Codex app-server logs for the underlying import error."}`
      );
    }
    emitProgress(options.onProgress, `Claude session imported (${threadId}).`, "completed", { threadId });
    return {
      threadId,
      stderr: cleanCodexStderr(client.stderr)
    };
  });
}

export async function runAppServerTurn(cwd, options = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }

  try {
    return await withAppServer(cwd, async (client, activity) => {
      let threadId;

      if (options.resumeThreadId) {
        emitProgress(options.onProgress, `Resuming thread ${options.resumeThreadId}.`, "starting");
        const response = await resumeThread(client, options.resumeThreadId, cwd, {
          model: options.model,
          approvalPolicy: options.approvalPolicy ?? null,
          sandbox: options.sandbox,
          ephemeral: false
        });
        threadId = response.thread.id;
      } else {
        emitProgress(options.onProgress, "Starting Codex task thread.", "starting");
        const response = await startThread(client, cwd, {
          model: options.model,
          approvalPolicy: options.approvalPolicy ?? null,
          sandbox: options.sandbox,
          ephemeral: options.persistThread ? false : true,
          threadName: options.persistThread ? options.threadName : options.threadName ?? null
        });
        threadId = response.thread.id;
      }

      emitProgress(options.onProgress, `Thread ready (${threadId}).`, "starting", {
        threadId
      });

      const prompt = options.prompt?.trim() || options.defaultPrompt || "";
      if (!prompt) {
        throw new Error("A prompt is required for this Codex run.");
      }

      const turnState = await captureTurn(
        client,
        threadId,
        () =>
          client.request("turn/start", {
            threadId,
            input: buildTurnInput(prompt),
            model: options.model ?? null,
            effort: options.effort ?? null,
            approvalPolicy: options.approvalPolicy ?? null,
            outputSchema: options.outputSchema ?? null,
            sandboxPolicy: buildSandboxPolicy(cwd, options.sandbox)
          }),
        {
          onProgress: options.onProgress,
          signal: options.signal,
          activity,
          idleTimeoutMs: options.idleTimeoutMs,
          hardTimeoutMs: options.hardTimeoutMs,
          timeoutMs: options.timeoutMs
        }
      );

      return {
        status: buildResultStatus(turnState),
        threadId,
        turnId: turnState.turnId,
        finalMessage: turnState.lastAgentMessage,
        reasoningSummary: turnState.reasoningSummary,
        turn: turnState.finalTurn,
        error: turnState.error,
        stderr: cleanCodexStderr(client.stderr),
        fileChanges: turnState.fileChanges,
        touchedFiles: collectTouchedFiles(turnState.fileChanges),
        commandExecutions: turnState.commandExecutions
      };
    }, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.fullAccess && /sandbox|approval|danger|full.access/i.test(message)) {
      throw new Error(
        `Full access is not supported by this Codex runtime: ${message}\nUpgrade Codex with \`npm install -g @openai/codex@latest\`, or rerun without --full-access.`,
        { cause: error }
      );
    }
    throw error;
  }
}

export async function findLatestTaskThread(cwd) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }

  return withAppServer(cwd, async (client) => {
    const response = await client.request("thread/list", {
      cwd,
      limit: 20,
      sortKey: "updated_at",
      sourceKinds: ["appServer"],
      searchTerm: TASK_THREAD_PREFIX
    });

    return (
      response.data.find((thread) => typeof thread.name === "string" && thread.name.startsWith(TASK_THREAD_PREFIX)) ??
      null
    );
  });
}

export function buildPersistentTaskThreadName(prompt) {
  return buildTaskThreadName(prompt);
}

export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      parsed: null,
      parseError: fallback.failureMessage ?? "Codex did not return a final structured message.",
      rawOutput: rawOutput ?? "",
      ...fallback
    };
  }

  try {
    return {
      parsed: JSON.parse(rawOutput),
      parseError: null,
      rawOutput,
      ...fallback
    };
  } catch (error) {
    return {
      parsed: null,
      parseError: error.message,
      rawOutput,
      ...fallback
    };
  }
}

export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}

export { DEFAULT_CONTINUE_PROMPT, TASK_THREAD_PREFIX };
