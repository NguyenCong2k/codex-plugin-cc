import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

function fileOperation(action) {
  const deadline = Date.now() + 1500;
  for (;;) {
    try { return action(); }
    catch (error) {
      // Windows cannot replace/unlink a file while another process has a
      // non-delete-sharing read handle. The transaction remains locked and
      // the old complete JSON stays authoritative until rename succeeds.
      if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error.code) || Date.now() >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
}
export const readTextFile = file => fileOperation(() => fs.readFileSync(file, "utf8"));

export function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
    fileOperation(() => fs.renameSync(temporary, file));
  } finally {
    try { fileOperation(() => fs.unlinkSync(temporary)); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}
export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}

// Filesystem bakery lock: each contender owns a unique ticket. There is no
// shared owner directory to steal/rename during stale-lock recovery, so a
// crashed owner cannot cause a reclaimer to delete a successor's live lock.
// Ticket files are atomic registers on the same local filesystem as state.
export function withFileLock(lockDir, action, timeoutMs = 10000) {
  fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  const token = crypto.randomUUID(), ownFile = path.join(lockDir, `${token}.json`);
  const started = Date.now();
  const scan = () => fs.readdirSync(lockDir).filter(name => name.endsWith(".json")).flatMap(name => {
    const file = path.join(lockDir, name);
    let ticket;
    try { ticket = JSON.parse(readTextFile(file)); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
    if (!Number.isInteger(ticket.pid) || ticket.pid <= 0 || typeof ticket.choosing !== "boolean" || !Number.isSafeInteger(ticket.number) || ticket.number < 0) {
      throw new Error(`Invalid state lock ticket: ${file}`);
    }
    if (!processAlive(ticket.pid)) {
      try { fileOperation(() => fs.unlinkSync(file)); } catch (error) { if (error.code !== "ENOENT") throw error; }
      return [];
    }
    return [{ ...ticket, token: path.basename(name, ".json") }];
  });
  const owner = { pid: process.pid, choosing: true, number: 0 };
  atomicWrite(ownFile, JSON.stringify(owner));
  try {
    owner.number = Math.max(0, ...scan().map(ticket => ticket.number)) + 1;
    owner.choosing = false;
    atomicWrite(ownFile, JSON.stringify(owner));
    for (;;) {
      const blocked = scan().some(ticket => ticket.token !== token && (ticket.choosing ||
        (ticket.number > 0 && (ticket.number < owner.number || (ticket.number === owner.number && ticket.token < token)))));
      if (!blocked) break;
      if (Date.now() - started >= timeoutMs) throw new Error(`Timed out acquiring state lock: ${lockDir}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    return action();
  } finally { fileOperation(() => fs.unlinkSync(ownFile)); }
}
