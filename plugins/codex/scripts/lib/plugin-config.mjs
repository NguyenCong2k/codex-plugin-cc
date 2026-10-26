import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

export function parseBooleanOption(value) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  const text = String(value ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on", "y", "enabled"].includes(text)) {
    return true;
  }
  if (["0", "false", "no", "off", "n", "disabled"].includes(text)) {
    return false;
  }
  return null;
}

function readSettings(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    return null;
  }
}

function findPluginEntry(pluginConfigs) {
  if (!pluginConfigs || typeof pluginConfigs !== "object" || Array.isArray(pluginConfigs)) {
    return null;
  }
  if (pluginConfigs.codex && typeof pluginConfigs.codex === "object") {
    return pluginConfigs.codex;
  }
  for (const [key, value] of Object.entries(pluginConfigs)) {
    if (/^codex(@|$)/.test(key) && value && typeof value === "object") {
      return value;
    }
  }
  return null;
}

function pluginOptionsFromSettings(settings) {
  if (!settings || typeof settings !== "object") {
    return null;
  }
  const entry = settings.pluginConfigs ? findPluginEntry(settings.pluginConfigs) : null;
  if (!entry) {
    return null;
  }
  if (entry.options && typeof entry.options === "object" && !Array.isArray(entry.options)) {
    return entry.options;
  }
  return entry;
}

function configDir(env) {
  return env.CLAUDE_CONFIG_DIR
    ? path.resolve(env.CLAUDE_CONFIG_DIR)
    : path.join(env.USERPROFILE || env.HOME || os.homedir(), ".claude");
}

function settingsPaths(env, cwd) {
  const userDir = configDir(env);
  const paths = [
    path.join(userDir, "settings.json")
  ];
  if (cwd) {
    paths.push(path.join(cwd, ".claude", "settings.json"));
    paths.push(path.join(cwd, ".claude", "settings.local.json"));
  }
  return paths;
}

export function readPluginOptions(options = {}) {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  let merged = {};
  for (const file of settingsPaths(env, cwd)) {
    const pluginOptions = pluginOptionsFromSettings(readSettings(file));
    if (pluginOptions) {
      merged = { ...merged, ...pluginOptions };
    }
  }
  return merged;
}

export function resolveFullAccess(options = {}) {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  if (options.flag === true) {
    return { enabled: true, source: "flag" };
  }
  const envValue = parseBooleanOption(env.CLAUDE_PLUGIN_OPTION_FULL_ACCESS);
  if (envValue !== null) {
    return { enabled: envValue, source: "env:CLAUDE_PLUGIN_OPTION_FULL_ACCESS" };
  }
  const pluginOptions = readPluginOptions({ env, cwd });
  const configured = parseBooleanOption(pluginOptions.full_access ?? pluginOptions.fullAccess);
  if (configured !== null) {
    return { enabled: configured, source: "userConfig:full_access" };
  }
  return { enabled: false, source: "default" };
}

export function resolveIncidentLog(options = {}) {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  if (options.flag) {
    return { path: path.resolve(cwd, String(options.flag)), source: "flag" };
  }
  if (env.CODEX_COMPANION_INCIDENT_LOG) {
    return { path: path.resolve(cwd, String(env.CODEX_COMPANION_INCIDENT_LOG)), source: "env:CODEX_COMPANION_INCIDENT_LOG" };
  }
  const pluginOptions = readPluginOptions({ env, cwd });
  const configured = pluginOptions.incident_log ?? pluginOptions.incidentLog;
  if (configured && String(configured).trim()) {
    return { path: path.resolve(cwd, String(configured)), source: "userConfig:incident_log" };
  }
  return { path: null, source: "default" };
}
