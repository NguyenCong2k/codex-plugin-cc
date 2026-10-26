import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const HEADER = [
  "# Agent incidents (Codex plugin)",
  "",
  "Mỗi lần Codex bị chặn, bị hỏi xác nhận, lệnh lỗi, timeout hoặc phải kill process: thêm một mục vào cuối file này.",
  ""
].join("\n");

const INCIDENT_TYPES = new Set([
  "blocked",
  "permission_denied",
  "wrong_command",
  "false_report",
  "env_tampering",
  "killed_process",
  "timeout",
  "command_failure",
  "other"
]);

function oneLine(value, limit = 1200) {
  const text = String(value ?? "").replace(/\r\n/g, "\n").trim();
  if (text.length <= limit) {
    return text.replace(/\n/g, " / ");
  }
  return `${text.slice(0, limit - 3).replace(/\n/g, " / ")}...`;
}

function clippedBlock(value, maxLines = 12, maxChars = 1200) {
  const lines = String(value ?? "").replace(/\r\n/g, "\n").split("\n").filter((line) => line.trim() !== "");
  const clipped = lines.slice(0, maxLines).join("\n");
  return clipped.length > maxChars ? `${clipped.slice(0, maxChars - 3)}...` : clipped;
}

/**
 * Append one markdown incident to the configured log. Incident logging must
 * never take down the job that is already in trouble, so failures are reported
 * on stderr and swallowed.
 */
export function appendIncident(options = {}) {
  const logPath = options.logPath ? path.resolve(String(options.logPath)) : "";
  if (!logPath) {
    return false;
  }
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    if (!fs.existsSync(logPath) || fs.statSync(logPath).size === 0) {
      fs.writeFileSync(logPath, HEADER, "utf8");
    }
    const timestamp = options.timestamp ?? new Date().toISOString();
    const type = INCIDENT_TYPES.has(options.type) ? options.type : "other";
    const lines = [
      "",
      `## ${timestamp} — ${oneLine(options.agent ?? "codex", 40)} — ${oneLine(options.task ?? "Codex plugin job", 120)}`,
      `- Loại: ${type}`,
      `- Đã làm: ${oneLine(options.did ?? "unknown")}`,
      `- Kết quả: ${oneLine(clippedBlock(options.result ?? ""))}`,
      `- Xử lý: ${oneLine(options.resolution ?? "unknown")}`
    ];
    if (options.suggestion) {
      lines.push(`- Gợi ý sửa: ${oneLine(options.suggestion)}`);
    }
    fs.appendFileSync(logPath, `${lines.join("\n")}\n`, "utf8");
    return true;
  } catch (error) {
    process.stderr.write(`[codex] incident log write failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return false;
  }
}

export function incidentLogFromRequest(request = {}) {
  return request.incidentLog ?? request.incident_log ?? null;
}
