---
description: Transfer the current Claude Code session into a resumable Codex thread
argument-hint: "[--source <claude-jsonl>]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Transport: pass the raw slash arguments through the quoted heredoc below. Choose a fresh delimiter if CODEX_ARGS appears as a complete line in the arguments. Never interpolate raw user text into shell quotes or a JavaScript expression.


Run this command once with Bash:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" transfer --arguments-stdin <<'CODEX_ARGS'
$ARGUMENTS
CODEX_ARGS
```

Present the command output to the user exactly as returned. Preserve the Codex session ID and the `codex resume <session-id>` command.
