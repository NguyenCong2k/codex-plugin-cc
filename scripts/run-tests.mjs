import fs from "node:fs";
import { spawn } from "node:child_process";
import process from "node:process";
const files = fs.readdirSync("tests").filter(name => name.endsWith(".test.mjs")).map(name => `tests/${name}`);
const child = spawn(process.execPath, ["--test", ...files], { stdio: "inherit", shell: false, windowsHide: true });
const budget = setTimeout(() => { child.kill(); process.stderr.write("Test suite exceeded its ten-minute budget.\n"); process.exitCode = 1; }, 10 * 60 * 1000);
child.on("exit", code => { clearTimeout(budget); process.exitCode = code ?? 1; });
