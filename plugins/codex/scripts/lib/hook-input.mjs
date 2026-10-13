import process from "node:process";

// Hooks receive one JSON object. Accept the complete object without waiting
// indefinitely for EOF from a host which keeps its pipe open.
export function readHookInput(timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const finish = (error, value = {}) => {
      clearTimeout(timer); process.stdin.removeListener("data", data);
      process.stdin.removeListener("end", end); process.stdin.removeListener("error", fail);
      process.stdin.pause(); process.stdin.destroy();
      error ? reject(error) : resolve(value);
    };
    const parse = () => {
      const value = JSON.parse(buffer);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Hook input must be a JSON object.");
      return value;
    };
    const data = chunk => {
      buffer += chunk;
      if (buffer.length > 1024 * 1024) { finish(new Error("Hook input exceeds 1 MiB.")); return; }
      try { finish(null, parse()); } catch { /* Input may be split across chunks. */ }
    };
    const end = () => { try { finish(null, buffer.trim() ? parse() : {}); } catch (error) { finish(error); } };
    const fail = error => finish(error);
    const timer = setTimeout(() => finish(buffer.trim() ? new Error("Incomplete hook input.") : null), timeoutMs);
    process.stdin.setEncoding("utf8"); process.stdin.on("data", data); process.stdin.once("end", end); process.stdin.once("error", fail);
    process.stdin.resume();
  });
}
