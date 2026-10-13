---
description: Answer a pending Codex approval or elicitation request
argument-hint: "<job-id>"
allowed-tools: Bash(node:*), AskUserQuestion
---

Use this command when `/codex:status` says a Codex job is waiting for interactive input.

Pass the raw slash arguments through the quoted heredoc below, then read the pending request as JSON:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" status --arguments-stdin <<'CODEX_ARGS'
$ARGUMENTS --json
CODEX_ARGS
```

Ask the user exactly once using `AskUserQuestion`, showing the command, file change, permission, or MCP elicitation details from `job.interaction`. For command and file-change approvals, offer only the decisions that the request supports: `accept`, `acceptForSession` when available, `decline`, and `cancel`. For an MCP form, collect the requested fields and build the exact JSON object required by `requestedSchema`; for a URL elicitation, ask whether to accept or decline the URL flow. Never invent missing values and never print or store credentials in the prompt.

Submit the server response through stdin so shell quoting cannot change it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" respond <job-id> --response-stdin <<'CODEX_RESPONSE'
{"decision":"accept"}
CODEX_RESPONSE
```

Use the response shape required by the request. Command and file approvals use `{"decision":"accept|acceptForSession|decline|cancel"}`. MCP elicitation uses `{"action":"accept|decline|cancel","content":...}`. Permission approval uses `{"permissions":...,"scope":"turn|session"}`. Return the companion output verbatim after submission.
