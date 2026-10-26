import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { atomicWrite } from "./storage.mjs";
import { resolveJobFile, updateJob } from "./state.mjs";

const INTERACTION_TIMEOUT_MS = 30 * 60 * 1000;
const POLL_INTERVAL_MS = 100;
const RESPONSE_SUFFIX = ".interaction-response.json";

function interactionResponseFile(workspaceRoot, jobId, requestId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  const token = crypto.createHash("sha256").update(String(requestId)).digest("hex").slice(0, 32);
  return `${jobFile.slice(0, -path.extname(jobFile).length)}.${token}${RESPONSE_SUFFIX}`;
}

function text(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function requestKind(method) {
  switch (method) {
    case "item/commandExecution/requestApproval":
      return "command-approval";
    case "item/fileChange/requestApproval":
      return "file-change-approval";
    case "item/permissions/requestApproval":
      return "permissions-approval";
    case "mcpServer/elicitation/request":
      return "mcp-elicitation";
    case "item/tool/requestUserInput":
      return "user-input";
    case "tool/requestUserInput":
      return "user-input";
    default:
      return "server-request";
  }
}

function cloneJson(value) {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function sanitize(value, key = "") {
  if (/token|secret|password|credential|authorization|api[_-]?key/i.test(key)) return "[redacted]";
  if (Array.isArray(value)) return value.slice(0, 100).map(entry => sanitize(entry));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).slice(0, 200).map(([name, entry]) => [name, sanitize(entry, name)]));
}

export function normalizeInteractionRequest(message, options = {}) {
  const params = message?.params && typeof message.params === "object" ? message.params : {};
  const method = text(message?.method, "unknown");
  const requestId = message?.id;
  if (requestId === undefined || requestId === null) throw new Error("Interactive server request is missing its JSON-RPC id.");
  const createdAt = new Date().toISOString();
  return {
    requestId,
    method,
    kind: requestKind(method),
    threadId: text(params.threadId) || null,
    turnId: text(params.turnId) || null,
    itemId: text(params.itemId) || null,
    createdAt,
    expiresAt: new Date(Date.now() + (options.timeoutMs ?? INTERACTION_TIMEOUT_MS)).toISOString(),
    params: sanitize(cloneJson(params))
  };
}

export function describeApprovalRequest(message) {
  const params = message?.params && typeof message.params === "object" ? message.params : {};
  return {
    method: text(message?.method, "unknown"),
    kind: requestKind(message?.method),
    requestId: message?.id ?? null,
    command: text(params.command) || null,
    cwd: text(params.cwd) || null,
    reason: text(params.reason) || null,
    itemId: text(params.itemId) || null
  };
}

export function autoApprovalResponse(message) {
  const kind = requestKind(message?.method);
  const params = message?.params && typeof message.params === "object" ? message.params : {};
  if (kind === "command-approval" || kind === "file-change-approval") {
    return { decision: "accept" };
  }
  if (kind === "permissions-approval") {
    return {
      permissions: params.permissions ?? params.requestedPermissions ?? {},
      scope: "turn"
    };
  }
  return null;
}

export function readPendingInteraction(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) return null;
  try {
    const job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
    return job?.interaction && typeof job.interaction === "object" ? job.interaction : null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function clearPendingInteraction(workspaceRoot, jobId, requestId, patch = {}) {
  updateJob(workspaceRoot, jobId, current => ({
    ...current,
    ...patch,
    interactions: (Array.isArray(current.interactions) ? current.interactions : current.interaction ? [current.interaction] : [])
      .filter(candidate => String(candidate.requestId) !== String(requestId)),
    interaction: ((Array.isArray(current.interactions) ? current.interactions : current.interaction ? [current.interaction] : [])
      .filter(candidate => String(candidate.requestId) !== String(requestId))[0] ?? null)
  }));
}

export function writeInteractionResponse(workspaceRoot, jobId, response) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  let job;
  try { job = JSON.parse(fs.readFileSync(jobFile, "utf8")); }
  catch (error) { if (error.code === "ENOENT") throw new Error(`No job found for ${jobId}.`); throw error; }
  const interactions = Array.isArray(job?.interactions) ? job.interactions : job?.interaction ? [job.interaction] : [];
  const pending = response?.requestId === undefined
    ? interactions[0]
    : interactions.find(candidate => String(candidate.requestId) === String(response.requestId));
  if (!pending) throw new Error(`Job ${jobId} is not waiting for interactive input.`);
  if (!response || typeof response !== "object" || Array.isArray(response)) throw new Error("Interactive response must be a JSON object.");
  if (response.requestId !== undefined && String(response.requestId) !== String(pending.requestId)) {
    throw new Error(`Interactive response belongs to request ${response.requestId}, but job ${jobId} is waiting for ${pending.requestId}.`);
  }
  const payload = {
    requestId: pending.requestId,
    result: Object.prototype.hasOwnProperty.call(response, "result") ? cloneJson(response.result) : null,
    error: Object.prototype.hasOwnProperty.call(response, "error") ? cloneJson(response.error) : null,
    writtenAt: new Date().toISOString()
  };
  atomicWrite(interactionResponseFile(workspaceRoot, jobId, pending.requestId), `${JSON.stringify(payload)}\n`);
  return payload;
}

function readResponse(workspaceRoot, jobId, requestId) {
  const file = interactionResponseFile(workspaceRoot, jobId, requestId);
  if (!fs.existsSync(file)) return null;
  let response;
  try {
    response = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`Cannot read interactive response for ${jobId}: ${error.message}`);
  }
  if (String(response?.requestId) !== String(requestId)) return null;
  try { fs.unlinkSync(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
  return response;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function waitForInteractionResponse({ workspaceRoot, jobId, message, signal, timeoutMs, onProgress }) {
  const request = normalizeInteractionRequest(message, { timeoutMs });
  const responseFile = interactionResponseFile(workspaceRoot, jobId, request.requestId);
  try { fs.unlinkSync(responseFile); } catch (error) { if (error.code !== "ENOENT") throw error; }
  updateJob(workspaceRoot, jobId, current => ({
    ...current,
    interactions: [...(Array.isArray(current.interactions) ? current.interactions : current.interaction ? [current.interaction] : []), request],
    interaction: current.interaction ?? request,
    phase: "waiting-input",
    interactionError: null
  }));
  onProgress?.({
    message: `Codex is waiting for ${request.kind}.`,
    phase: "waiting-input",
    logTitle: "Interactive request",
    logBody: `${request.method} (${request.requestId})`
  });

  const deadline = Date.parse(request.expiresAt);
  try {
    while (Date.now() < deadline) {
      if (signal?.aborted) throw signal.reason ?? new Error("Codex job cancelled while waiting for interactive input.");
      const response = readResponse(workspaceRoot, jobId, request.requestId);
      if (response) {
        if (response.error) throw Object.assign(new Error(text(response.error.message, "Interactive request was rejected.")), { rpcCode: response.error.code ?? -32005 });
        onProgress?.({ message: "Interactive response received; resuming Codex.", phase: "running" });
        clearPendingInteraction(workspaceRoot, jobId, request.requestId, { interactionError: null });
        return response.result ?? {};
      }
      await delay(POLL_INTERVAL_MS);
    }
    throw new Error(`Interactive request ${request.requestId} expired. Resume the saved Codex thread to continue.`);
  } catch (error) {
    clearPendingInteraction(workspaceRoot, jobId, request.requestId, { interactionError: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

export function interactionResponsePath(workspaceRoot, jobId, requestId) {
  return interactionResponseFile(workspaceRoot, jobId, requestId);
}

export const INTERACTION_TIMEOUT_DEFAULT_MS = INTERACTION_TIMEOUT_MS;
