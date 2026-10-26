# Changelog

## 1.3.0 (maintained fork)

- Add explicit `--full-access` / `userConfig.full_access` mapping to Codex `danger-full-access` plus `approvalPolicy=never`; keep read-only and workspace-write defaults when off.
- Return a compact job digest (`status`, `filesChanged`, `commandsRun`, `testsSummary`, `failures`, `logPath`) and add `status <job> --digest` / `result <job> --digest` for cheap polling.
- Turn unanswered approval requests into a `blocked` digest that includes the blocked command instead of a silent job death; auto-answer unexpected approvals only in full-access mode.
- Record approvals, command failures, timeouts and killed runtimes in the optional markdown incident log.
- Add `task --write --worktree <branch>` isolation and report the worktree path in the digest.
- Add `review --digest` / `adversarial-review --digest` findings with file, line, severity and a two-sentence description.

## 1.2.1 (maintained fork)

- Replace the fixed 30-minute turn budget with a progress-aware 15-minute inactivity watchdog and a configurable two-hour hard limit.
- Pause inactivity accounting while a job waits for explicit approval or elicitation input.
- Persist timeouts as `timed_out` with exact thread, turn, limit, elapsed-time and interrupt evidence.
- Keep timeout continuation under Claude's control; the plugin preserves resumable state and never restarts a turn automatically.

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
