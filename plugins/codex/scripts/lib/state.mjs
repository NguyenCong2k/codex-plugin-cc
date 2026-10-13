import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { atomicWrite, processAlive, readTextFile, withFileLock } from "./storage.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const active = job => job.status === "queued" || job.status === "running";
const empty = () => ({ version: 2, config: { stopReviewGate: false }, jobs: [] });
const now = () => new Date().toISOString();
export function resolveStateDir(cwd) {
  const workspace = resolveWorkspaceRoot(cwd);
  let canonical = workspace;
  try { canonical = fs.realpathSync.native(workspace); } catch { /* New workspace. */ }
  if (process.platform === "win32") canonical = canonical.toLowerCase();
  const slug = path.basename(workspace).replace(/[^a-zA-Z0-9._-]+/g, "-") || "workspace";
  const root = process.env.CODEX_COMPANION_STATE_HOME || path.join(os.homedir(), ".codex-plugin-cc");
  return path.join(root, `${slug}-${createHash("sha256").update(canonical).digest("hex").slice(0, 16)}`);
}
export const resolveStateFile = cwd => path.join(resolveStateDir(cwd), "state.json");
export const resolveJobsDir = cwd => path.join(resolveStateDir(cwd), "jobs");
export function ensureStateDir(cwd) {
  const dir = resolveStateDir(cwd);
  const root = path.dirname(dir);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const rootStat = fs.lstatSync(root);
  if (rootStat.isSymbolicLink() || (process.getuid && (rootStat.uid !== process.getuid() || (rootStat.mode & 0o077)))) {
    throw new Error(`State root must be private and owned by this user: ${root}`);
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error(`State directory must be private and owned by this user: ${dir}`);
  }
  if (process.getuid && (stat.mode & 0o077)) fs.chmodSync(dir, 0o700);
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true, mode: 0o700 });
}
function validId(id) {
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) throw new Error("Invalid job id.");
  return id;
}
export function resolveJobFile(cwd, id) { return path.join(resolveJobsDir(cwd), `${validId(id)}.json`); }
export function resolveJobLogFile(cwd, id) { ensureStateDir(cwd); return path.join(resolveJobsDir(cwd), `${validId(id)}.log`); }
function readOptional(file) {
  try { return JSON.parse(readTextFile(file)); }
  catch (error) { if (error.code === "ENOENT") return null; throw new Error(`Cannot read state ${file}: ${error.message}`); }
}
function mergeJob(existing, patch) {
  if (existing && TERMINAL.has(existing.status)) return existing;
  if (existing?.status === "running" && patch.status === "queued") return existing;
  return { ...existing, ...patch };
}
export function loadState(cwd) {
  ensureStateDir(cwd);
  const stored = readOptional(resolveStateFile(cwd));
  const result = { ...empty(), ...stored, config: { ...empty().config, ...stored?.config } };
  const byId = new Map((Array.isArray(stored?.jobs) ? stored.jobs : []).map(job => [validId(job.id), job]));
  // Recover files committed before an interrupted index update.
  if (fs.existsSync(resolveJobsDir(cwd))) {
    for (const name of fs.readdirSync(resolveJobsDir(cwd))) {
      if (!name.endsWith(".json")) continue;
      const job = readOptional(path.join(resolveJobsDir(cwd), name));
      if (job?.id) byId.set(validId(job.id), { ...byId.get(job.id), ...job });
    }
  }
  result.jobs = [...byId.values()]; return result;
}
function locked(cwd, action) {
  ensureStateDir(cwd);
  return withFileLock(path.join(resolveStateDir(cwd), ".state-lock"), action);
}
function saveUnlocked(cwd, state) {
  const sorted = [...state.jobs].sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
  const jobs = [...sorted.filter(active), ...sorted.filter(job => !active(job)).slice(0, 50)];
  const retained = new Set(jobs.map(job => job.id));
  for (const job of sorted) {
    if (retained.has(job.id)) continue;
    for (const suffix of ["json", "log"]) {
      try { fs.unlinkSync(path.join(resolveJobsDir(cwd), `${validId(job.id)}.${suffix}`)); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    const prefix = `${validId(job.id)}.`;
    for (const name of fs.readdirSync(resolveJobsDir(cwd)).filter(candidate => candidate.startsWith(prefix) && candidate.endsWith(".interaction-response.json"))) {
      try { fs.unlinkSync(path.join(resolveJobsDir(cwd), name)); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
  const next = { version: 2, config: { ...empty().config, ...state.config }, jobs };
  atomicWrite(resolveStateFile(cwd), `${JSON.stringify(next, null, 2)}\n`); return next;
}
function commitJobChanges(cwd, previous, jobs) {
  const byId = new Map(previous.map(job => [job.id, job]));
  return jobs.map(job => {
    const before = byId.get(validId(job.id));
    const next = mergeJob(before, job);
    if (JSON.stringify(before) !== JSON.stringify(next)) {
      atomicWrite(resolveJobFile(cwd, job.id), `${JSON.stringify(next, null, 2)}\n`);
    }
    return next;
  });
}
export function saveState(cwd, snapshot) {
  return locked(cwd, () => {
    const current = loadState(cwd), jobs = new Map(current.jobs.map(job => [job.id, job]));
    for (const job of snapshot.jobs ?? []) jobs.set(validId(job.id), mergeJob(jobs.get(job.id), job));
    const config = fs.existsSync(resolveStateFile(cwd)) ? current.config : { ...current.config, ...snapshot.config };
    return saveUnlocked(cwd, { ...current, config, jobs: commitJobChanges(cwd, current.jobs, [...jobs.values()]) });
  });
}
export function updateState(cwd, mutate) {
  return locked(cwd, () => {
    const state = loadState(cwd), previous = structuredClone(state.jobs);
    mutate(state); state.jobs = commitJobChanges(cwd, previous, state.jobs);
    return saveUnlocked(cwd, state);
  });
}
export function updateJob(cwd, id, mutate) {
  return locked(cwd, () => {
    const state = loadState(cwd), existing = state.jobs.find(job => job.id === id);
    if (existing && TERMINAL.has(existing.status)) return existing;
    const next = mutate(existing ?? { id: validId(id), createdAt: now() });
    if (!next) return existing;
    const job = { ...next, id, updatedAt: now() };
    atomicWrite(resolveJobFile(cwd, id), `${JSON.stringify(job, null, 2)}\n`);
    state.jobs = [job, ...state.jobs.filter(other => other.id !== id)];
    saveUnlocked(cwd, state); return job;
  });
}
export function upsertJob(cwd, patch) {
  updateJob(cwd, validId(patch.id), existing => ({ ...existing, ...patch })); return loadState(cwd);
}
export const listJobs = cwd => loadState(cwd).jobs;
export const getConfig = cwd => loadState(cwd).config;
export function setConfig(cwd, key, value) { return updateState(cwd, state => { state.config[key] = value; }); }
export const generateJobId = (prefix = "job") => `${prefix}-${randomUUID()}`;
export function writeJobFile(cwd, id, payload) {
  updateJob(cwd, id, existing => ({ ...existing, ...payload })); return resolveJobFile(cwd, id);
}
export const readJobFile = file => JSON.parse(readTextFile(file));
export function requestJobCancellation(cwd, id, reason = "Cancelled by user.") {
  return updateJob(cwd, id, job => ({ ...job, cancelRequestedAt: now(), cancelReason: reason }));
}
export function reconcileJobs(cwd) {
  const expired = job => job.status === "queued" && !job.pid && Date.now() - Date.parse(job.createdAt) > 10000;
  const changed = listJobs(cwd).filter(job => active(job) && ((job.pid && !processAlive(job.pid)) || expired(job)));
  for (const job of changed) updateJob(cwd, job.id, current => {
    if (current.pid !== job.pid || (current.pid && processAlive(current.pid)) || (!current.pid && !expired(current))) return current;
    return { ...current, status: current.cancelRequestedAt ? "cancelled" : "failed", phase: "failed", pid: null,
      interaction: null, interactions: [],
      completedAt: now(), errorMessage: current.cancelReason || "The owning worker exited before recording a result. Resume the saved Codex thread to continue." };
  });
  return listJobs(cwd);
}
