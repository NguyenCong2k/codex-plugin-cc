---
description: Show the stored final output for a finished Codex job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Transport: pass the raw slash arguments through the quoted heredoc below. Choose a fresh delimiter if CODEX_ARGS appears as a complete line in the arguments. Never interpolate raw user text into shell quotes or a JavaScript expression.


Run this command once with Bash:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" result --arguments-stdin <<'CODEX_ARGS'
$ARGUMENTS
CODEX_ARGS
```

Present the full command output to the user. Do not summarize or condense it. Preserve all details including:
- Job ID and status
- The complete result payload, including verdict, summary, findings, details, artifacts, and next steps
- File paths and line numbers exactly as reported
- Any error messages or parse errors
- Follow-up commands such as `/codex:status <id>` and `/codex:review`
