# Changelog

## 1.2.0 (maintained fork)

- Replace shared detached brokers with per-job supervised runtimes and durable thread resume.
- Serialize state changes across processes; preserve terminal results and active jobs.
- Request cancellation through the owning worker and recover jobs whose worker exited.
- Separate literal prompt text from flags; preserve equals signs, Windows paths and Unicode.
- Make SessionStart exports idempotent and Stop reviews ephemeral, bounded and re-entry safe.
- Correlate imports using canonical source identity and before-import ledger/hash evidence.
- Respect configured approval policies and bridge interactions through the owning job.
- Bridge app-server command/file/permission approvals and MCP elicitation requests through request-id-scoped job state and `/codex:respond`.
- Use native executable/Node shim resolution, portable build scripts and Windows/Linux CI.

## 1.0.0

- Initial version of the Codex plugin for Claude Code
