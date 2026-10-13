/**
 * @typedef {import("./app-server-protocol").AppServerNotificationHandler} AppServerNotificationHandler
 * @typedef {import("./app-server-protocol").CodexAppServerClientOptions & { rpcTimeoutMs?: number, signal?: AbortSignal, serverRequestHandler?: (message: object) => Promise<object> }} ClientOptions
 */
import fs from "node:fs";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const manifest = JSON.parse(fs.readFileSync(new URL("../../.claude-plugin/plugin.json", import.meta.url), "utf8"));
const capabilities = { experimentalApi: true, mcpServerOpenaiFormElicitation: true, requestAttestation: false,
  optOutNotificationMethods: ["item/agentMessage/delta", "item/reasoning/summaryTextDelta", "item/reasoning/summaryPartAdded", "item/reasoning/textDelta"] };
export function durationSetting(value, fallback) {
  if (value == null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error("Runtime timeouts must be positive milliseconds.");
  return number;
}

export class CodexAppServerClient {
  /** @param {ClientOptions} options */
  constructor(cwd, options = {}) {
    this.cwd = cwd; this.options = options; this.transport = "direct";
    this.pending = new Map(); this.nextId = 1; this.stderr = ""; this.closed = false;
    this.exitError = null; this.exitResolved = false;
    /** @type {AppServerNotificationHandler | null} */
    this.notificationHandler = null;
    this.exitPromise = new Promise(resolve => { this.resolveExit = resolve; });
  }
  static async connect(cwd, options = {}) {
    const client = new CodexAppServerClient(cwd, options);
    try { await client.initialize(); return client; }
    catch (error) { await client.close(); throw error; }
  }
  setNotificationHandler(handler) { this.notificationHandler = handler; }
  async initialize() {
    this.proc = spawn(process.execPath, [fileURLToPath(new URL("../app-server-guardian.mjs", import.meta.url))], {
      cwd: this.cwd, env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"], shell: false,
      // EOF on the parent-owned pipe reaps the isolated group even if the
      // companion is killed by a host timeout or SIGKILL.
      detached: process.platform !== "win32", windowsHide: true
    });
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", chunk => { this.stderr = (this.stderr + chunk).slice(-128 * 1024); });
    this.proc.on("error", error => this.handleExit(error));
    this.proc.on("exit", (code, signal) => this.handleExit(code === 0 ? null :
      new Error(`Codex runtime exited (${signal || code}). ${this.stderr.trim()}`)));
    this.proc.stdin.on("error", error => this.handleExit(error));
    this.readline = readline.createInterface({ input: this.proc.stdout });
    this.readline.on("line", line => this.handleLine(line));
    await this.request("initialize", {
      clientInfo: this.options.clientInfo ?? { title: "Codex Plugin", name: "Claude Code", version: manifest.version },
      capabilities: this.options.capabilities ?? capabilities
    });
    this.notify("initialized", {});
  }
  /**
   * @template {import("./app-server-protocol").AppServerMethod} M
   * @param {M} method
   * @param {import("./app-server-protocol").AppServerRequestParams<M>} params
   * @returns {Promise<import("./app-server-protocol").AppServerResponse<M>>}
   */
  request(method, params) {
    if (this.closed || this.exitResolved) return Promise.reject(this.exitError ?? new Error("Codex runtime is closed."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex RPC ${method} timed out. No request is replayed automatically.`));
      }, durationSetting(this.options.rpcTimeoutMs ?? (this.options.env ?? process.env).CODEX_COMPANION_RPC_TIMEOUT_MS, 30000));
      this.pending.set(id, { resolve, reject, method, timeout });
      try { this.sendMessage({ id, method, params }); }
      catch (error) { clearTimeout(timeout); this.pending.delete(id); reject(error); }
    });
  }
  notify(method, params = {}) { if (!this.closed && !this.exitResolved) this.sendMessage({ method, params }); }
  sendMessage(message) { this.proc.stdin.write(`${JSON.stringify(message)}\n`); }
  handleServerRequest(message) {
    const handler = this.options.serverRequestHandler;
    if (typeof handler !== "function") {
      // A noninteractive client must not manufacture approval or credentials.
      // Surface the requirement and preserve the thread for interactive resume.
      const detail = `Codex requested ${message.method}, which needs interactive input. Resume this thread in Codex to provide approval or input.`;
      try { this.sendMessage({ id: message.id, error: { code: -32005, message: detail } }); }
      catch (error) { this.handleExit(error); return; }
      this.handleExit(new Error(detail));
      return;
    }

    Promise.resolve()
      .then(() => handler(message))
      .then(result => {
        if (result === undefined) throw new Error(`Interactive handler returned no response for ${message.method}.`);
        if (!this.closed && !this.exitResolved) this.sendMessage({ id: message.id, result });
      })
      .catch(error => {
        const code = Number.isInteger(error?.rpcCode) ? error.rpcCode : -32005;
        const detail = error instanceof Error ? error.message : String(error);
        try { if (!this.closed && !this.exitResolved) this.sendMessage({ id: message.id, error: { code, message: detail } }); }
        catch (sendError) { this.handleExit(sendError); return; }
        // A rejected interaction cannot be safely replayed or silently accepted.
        this.handleExit(Object.assign(new Error(detail), { rpcCode: code }));
      });
  }
  handleLine(line) {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); }
    catch (error) { this.handleExit(new Error(`Invalid Codex JSONL: ${error.message}`)); return; }
    if (message.id !== undefined && message.method) {
      this.handleServerRequest(message); return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id); if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timeout);
      if (message.error) {
        const error = Object.assign(new Error(message.error.message ?? `Codex RPC ${pending.method} failed.`), { rpcCode: message.error.code });
        pending.reject(error);
      } else pending.resolve(message.result ?? {});
      return;
    }
    if (message.method && this.notificationHandler) {
      try { this.notificationHandler(message); } catch (error) { this.handleExit(error); }
    }
  }
  handleExit(error) {
    if (this.exitResolved) return;
    this.exitResolved = true; this.closed = true; this.exitError = error ?? null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout); pending.reject(error ?? new Error("Codex runtime connection closed."));
    }
    this.pending.clear(); this.resolveExit(undefined);
  }
  async close() {
    this.closed = true;
    this.proc?.stdin.end();
    if (this.proc && this.proc.exitCode === null && this.proc.signalCode === null) {
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 5000);
        this.proc.once("exit", () => { clearTimeout(timer); resolve(undefined); });
      });
      if (this.proc.exitCode === null && this.proc.signalCode === null) {
        this.proc.kill("SIGKILL");
        throw new Error("Codex guardian did not finish cleanup within five seconds.");
      }
    }
    this.readline?.close(); this.handleExit(this.exitError);
  }
}
