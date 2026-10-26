import fs from "node:fs";

const MAX_FAILURE_LINES = 40;
const MAX_FILES = 200;
const MAX_COMMANDS = 100;
const MAX_FINDINGS = 100;
const MAX_TEXT = 4000;

export const TEST_COMMAND_PATTERN =
  /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i;

const REDACTED = "[REDACTED]";
/** @type {Array<[RegExp, string]>} */
const SECRET_PATTERNS = [
  // Credentials embedded in a URL: https://user:password@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)([^\s/@]+)(@)/gi, `$1${REDACTED}$3`],
  // Authorization headers, including quoted curl -H arguments.
  [/(\bauthorization\s*:\s*)(?:(?:bearer|basic|token)\s+)?([^\s"',;]+)/gi, `$1${REDACTED}`],
  [/\b(bearer\s+)([A-Za-z0-9._~+/=-]{8,})/gi, `$1${REDACTED}`],
  [/(\b(?:x-api-key|api-key)\s*:\s*)([^\s"',;]+)/gi, `$1${REDACTED}`],
  [/(\bcookie\s*:\s*)([^\r\n]+)/gi, `$1${REDACTED}`],
  // Command-line credential flags: --token=..., --password ..., --auth-token ...
  [/(--?(?:auth[-_]?token|token|password|passwd|api[-_]?key|apikey|access[-_]?token|client[-_]?secret|secret)(?:=|\s+))([^\s"'`]+)/gi, `$1${REDACTED}`],
  // Environment assignments such as OPENAI_API_KEY=...
  [/\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|CREDENTIALS?)[A-Z0-9_]*\s*=\s*)([^\s"'`]+)/g, `$1${REDACTED}`],
  // Well-known token shapes without a label.
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16})\b/g, REDACTED]
];

export function redactSecrets(value) {
  let text = String(value ?? "");
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

export function isTestCommand(command) {
  return TEST_COMMAND_PATTERN.test(String(command ?? ""));
}

function clipText(value, limit = MAX_TEXT) {
  const text = String(value ?? "").trimEnd();
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit - 3)}...`;
}

function uniqueStrings(values, limit) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const normalized = String(value ?? "").trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= limit) {
      break;
    }
  }
  return result;
}

/**
 * Keep the first `maxLines` raw lines. A marker is appended only when the
 * original output was longer, so the digest stays bounded without rewriting
 * the lines that are kept.
 */
export function truncateFailureLines(texts, maxLines = MAX_FAILURE_LINES) {
  const lines = [];
  for (const text of texts) {
    const value = String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (!value.trim()) {
      continue;
    }
    for (const line of value.split("\n")) {
      if (line.trim() === "") {
        continue;
      }
      lines.push(line);
    }
  }
  if (lines.length <= maxLines) {
    return lines;
  }
  return [...lines.slice(0, Math.max(0, maxLines - 1)), `... ${lines.length - (maxLines - 1)} line(s) omitted`];
}

export function normalizeCommandExecutions(commandExecutions = []) {
  const commands = [];
  for (const item of commandExecutions) {
    if (!item || typeof item !== "object") {
      continue;
    }
    commands.push({
      command: clipText(redactSecrets(item.command ?? ""), 1000),
      exitCode: Number.isInteger(item.exitCode) ? item.exitCode : null,
      status: typeof item.status === "string" ? item.status : null,
      output: clipText(redactSecrets(item.aggregatedOutput ?? item.output ?? ""))
    });
    if (commands.length >= MAX_COMMANDS) {
      break;
    }
  }
  return commands;
}

export function summarizeTests(commandsRun) {
  const tests = commandsRun.filter((entry) => isTestCommand(entry.command));
  if (tests.length === 0) {
    return "No test commands detected.";
  }
  const failed = tests.filter((entry) => commandFailed(entry));
  return `${tests.length} test command(s): ${tests.length - failed.length} passed, ${failed.length} failed.`;
}

function commandFailed(entry) {
  return entry.status === "failed" || entry.status === "declined" || (entry.exitCode !== null && entry.exitCode !== 0);
}

export function inferRunStatus(exitStatus, commandExecutions = []) {
  if (exitStatus !== 0) {
    return "failed";
  }
  const commandsRun = normalizeCommandExecutions(commandExecutions);
  const unresolvedFailures = new Map();
  for (const entry of commandsRun) {
    if (!isTestCommand(entry.command)) {
      continue;
    }
    const command = String(entry.command ?? "").trim();
    if (commandFailed(entry)) {
      unresolvedFailures.set(command, entry);
    } else {
      unresolvedFailures.delete(command);
    }
  }
  return unresolvedFailures.size > 0 ? "failed" : "passed";
}

function commandFailures(commandsRun) {
  return commandsRun
    .filter((entry) => entry.status === "failed" || entry.status === "declined" || (entry.exitCode !== null && entry.exitCode !== 0))
    .map((entry) => entry.output)
    .filter(Boolean);
}

function twoSentences(value) {
  const text = clipText(value, 2000);
  if (!text) {
    return "";
  }
  const sentences = text.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g);
  if (!sentences || sentences.length <= 2) {
    return text;
  }
  return sentences.slice(0, 2).join(" ").trim();
}

export function normalizeDigestFinding(finding, index = 0) {
  const source = finding && typeof finding === "object" ? finding : {};
  const lineStart = Number.isInteger(source.lineStart)
    ? source.lineStart
    : Number.isInteger(source.line_start) && source.line_start > 0
      ? source.line_start
      : null;
  const lineEnd = Number.isInteger(source.lineEnd)
    ? source.lineEnd
    : Number.isInteger(source.line_end) && source.line_end > 0
      ? source.line_end
      : lineStart;
  const description = twoSentences(source.description ?? source.body ?? source.summary ?? "");
  return {
    file: typeof source.file === "string" && source.file.trim() ? source.file.trim() : "unknown",
    line: lineStart ? (lineEnd && lineEnd !== lineStart ? `${lineStart}-${lineEnd}` : `${lineStart}`) : null,
    lineStart,
    lineEnd,
    severity: typeof source.severity === "string" && source.severity.trim() ? source.severity.trim() : "low",
    title: typeof source.title === "string" && source.title.trim() ? source.title.trim() : `Finding ${index + 1}`,
    description: description || "No description provided.",
    recommendation: twoSentences(source.recommendation ?? "")
  };
}

export function normalizeFindings(findings, limit = MAX_FINDINGS) {
  if (!Array.isArray(findings)) {
    return [];
  }
  return findings.slice(0, limit).map((finding, index) => normalizeDigestFinding(finding, index));
}

export function normalizeDigestStatus(status) {
  const value = String(status ?? "").toLowerCase();
  if (value === "passed" || value === "failed" || value === "blocked" || value === "error") {
    return value;
  }
  if (value === "completed" || value === "done" || value === "success") {
    return "passed";
  }
  if (value === "queued" || value === "running" || value === "in_progress") {
    return "running";
  }
  if (value === "cancelled" || value === "timed_out" || value === "timeout") {
    return "error";
  }
  return value ? "failed" : "error";
}

export function digestStateForJobStatus(status) {
  if (status === "queued" || status === "running") {
    return "running";
  }
  if (status === "completed") {
    return "done";
  }
  return "failed";
}

export function buildDigest(options = {}) {
  const commandsRun = normalizeCommandExecutions(options.commandExecutions ?? []);
  const failureTexts = Array.isArray(options.failureTexts)
    ? options.failureTexts
    : options.failureTexts
      ? [options.failureTexts]
      : [];
  const failures = truncateFailureLines([
    ...commandFailures(commandsRun),
    ...failureTexts.map((text) => redactSecrets(text)),
    redactSecrets(options.errorText ?? "")
  ]);
  const digest = {
    status: normalizeDigestStatus(options.status),
    jobId: options.jobId ?? null,
    threadId: options.threadId ?? null,
    turnId: options.turnId ?? null,
    filesChanged: uniqueStrings(options.filesChanged ?? [], MAX_FILES),
    commandsRun: commandsRun.map(({ command, exitCode, status }) => ({ command, exitCode, status })),
    testsSummary: options.testsSummary ?? summarizeTests(commandsRun),
    failures,
    logPath: options.logPath ?? null,
    worktree: options.worktree ?? null
  };
  if (options.findings !== undefined) {
    digest.findings = normalizeFindings(options.findings);
  }
  if (options.blockedCommand) {
    digest.blockedCommand = redactSecrets(options.blockedCommand);
  }
  if (options.blockedReason) {
    digest.blockedReason = redactSecrets(options.blockedReason);
  }
  if (options.summary) {
    digest.summary = twoSentences(options.summary);
  }
  return digest;
}

export function buildErrorDigest(error, options = {}) {
  const code = typeof error?.code === "string" ? error.code : "";
  const approval = error?.approval ?? null;
  const blocked = code === "CODEX_APPROVAL_REQUIRED" || code === "CODEX_APPROVAL_DENIED";
  const message = error instanceof Error ? error.message : String(error ?? "");
  return buildDigest({
    status: blocked ? "blocked" : "error",
    jobId: options.jobId ?? null,
    threadId: error?.threadId ?? options.threadId ?? null,
    turnId: error?.turnId ?? options.turnId ?? null,
    filesChanged: options.filesChanged ?? [],
    commandExecutions: options.commandExecutions ?? [],
    errorText: message,
    logPath: options.logPath ?? null,
    worktree: options.worktree ?? null,
    blockedCommand: blocked ? (approval?.command ?? options.blockedCommand ?? null) : null,
    blockedReason: blocked ? (approval?.reason ?? message) : null
  });
}

export function buildDigestFromStoredJob(job, storedJob) {
  if (storedJob?.digest && typeof storedJob.digest === "object") {
    return storedJob.digest;
  }
  const result = storedJob?.result ?? {};
  const status = job?.status === "completed"
    ? "passed"
    : job?.status === "failed"
      ? "failed"
      : job?.status === "cancelled" || job?.status === "timed_out"
        ? "error"
        : "error";
  return buildDigest({
    status,
    jobId: job?.id ?? null,
    threadId: storedJob?.threadId ?? job?.threadId ?? null,
    turnId: storedJob?.turnId ?? job?.turnId ?? null,
    filesChanged: result.touchedFiles ?? [],
    commandExecutions: result.commandExecutions ?? [],
    errorText: storedJob?.errorMessage ?? job?.errorMessage ?? "",
    logPath: storedJob?.logFile ?? job?.logFile ?? null,
    worktree: storedJob?.worktreePath ?? job?.worktreePath ?? null,
    findings: result.result?.findings,
    summary: result.result?.summary
  });
}

export function readLastOutputAt(logFile) {
  if (!logFile) {
    return null;
  }
  try {
    return fs.statSync(logFile).mtime.toISOString();
  } catch {
    return null;
  }
}

export { MAX_FAILURE_LINES };
