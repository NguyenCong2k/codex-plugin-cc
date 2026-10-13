import { spawnSync } from "node:child_process";
import process from "node:process";
import fs from "node:fs";
import path from "node:path";

export function executableInvocation(command, args = [], env = process.env) {
  if (command === "node") return { command: process.execPath, args };
  if (process.platform !== "win32") return { command, args };
  const envPath = Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "";
  const candidates = path.isAbsolute(command) ? [command] : String(envPath).split(path.delimiter).flatMap(dir =>
    [command, `${command}.exe`, `${command}.com`, `${command}.cmd`].map(name => path.join(dir, name)));
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) continue;
    if (/\.(exe|com)$/i.test(candidate)) return { command: candidate, args };
    const base = candidate.replace(/\.cmd$/i, "");
    if (fs.existsSync(base) && /^#!.*\bnode\b/.test(fs.readFileSync(base, "utf8").slice(0, 160))) {
      return { command: process.execPath, args: [base, ...args] };
    }
    const knownShim = command === "npm" ? "npm/bin/npm-cli.js" : command === "codex" ? "@openai/codex/bin/codex.js" : null;
    if (knownShim) {
      const script = path.join(path.dirname(candidate), "node_modules", knownShim);
      if (fs.existsSync(script)) return { command: process.execPath, args: [script, ...args] };
    }
  }
  throw Object.assign(new Error(`Executable not found (use a native executable or Node shim): ${command}`), { code: "ENOENT" });
}

export function runCommand(command, args = [], options = {}) {
  let invocation;
  try { invocation = executableInvocation(command, args, options.env ?? process.env); }
  catch (error) { return { command, args, status: 1, signal: null, stdout: "", stderr: "", error }; }
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? "pipe",
    shell: false,
    timeout: options.timeout ?? 15000,
    windowsHide: true
  });

  return {
    command,
    args,
    status: result.status ?? 1,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, options);
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

function looksLikeMissingProcessMessage(text) {
  return /not found|no running instance|cannot find|does not exist|no such process/i.test(text);
}

export function terminateProcessTree(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { attempted: false, delivered: false, method: null };
  }

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);

  if (platform === "win32") {
    const result = runCommandImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
      cwd: options.cwd,
      env: options.env,
      shell: false
    });

    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill", result };
    }

    const combinedOutput = `${result.stderr}\n${result.stdout}`.trim();
    try { killImpl(pid, 0); }
    catch (error) { if (error.code === "ESRCH") return { attempted: true, delivered: false, method: "taskkill", result }; }
    if (!result.error && looksLikeMissingProcessMessage(combinedOutput)) {
      return { attempted: true, delivered: false, method: "taskkill", result };
    }

    if (result.error?.code === "ENOENT") {
      try {
        killImpl(pid);
        return { attempted: true, delivered: true, method: "kill" };
      } catch (error) {
        if (error?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "kill" };
        }
        throw error;
      }
    }

    if (result.error) {
      throw result.error;
    }

    throw new Error(formatCommandFailure(result));
  }

  try {
    killImpl(-pid, "SIGTERM");
    return { attempted: true, delivered: true, method: "process-group" };
  } catch (error) {
    {
      try {
        killImpl(pid, "SIGTERM");
        return { attempted: true, delivered: true, method: "process" };
      } catch (innerError) {
        if (innerError?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "process" };
        }
        throw innerError;
      }
    }

    return { attempted: true, delivered: false, method: "process-group" };
  }
}

export function formatCommandFailure(result) {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}
