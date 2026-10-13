import fs from "node:fs";
import { runCommandChecked } from "../plugins/codex/scripts/lib/process.mjs";
const output = "plugins/codex/.generated/app-server-types";
fs.mkdirSync(output, { recursive: true });
runCommandChecked("codex", ["app-server", "generate-ts", "--out", output], { timeout: 60000 });
