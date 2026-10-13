# Root-cause remediation

Baseline: upstream `db52e28` (1.0.6). Fork: NguyenCong2k/codex-plugin-cc, branch `patched`.

## Ownership decisions

- One run owns one app-server process. Persistent thread IDs preserve resume; a workspace-wide detached broker is no longer the default execution owner. SessionEnd must never terminate another session's runtime.
- Turn supervision uses a resettable inactivity watchdog plus a separate hard limit. A timeout interrupts the exact owned turn, persists resumable evidence, and leaves the continuation decision to Claude instead of replaying work automatically.
- Job state transitions and configuration changes are interprocess transactions. Readers see complete JSON; active jobs are not history eligible for pruning. Terminal state cannot be overwritten by late progress or cancellation races.
- Cancellation is a persisted request consumed by the owning worker, rather than killing an arbitrary PID read from disk. A worker supervises its owned child and records a terminal outcome.
- Prompt text and options are separate transports. Only an explicit raw slash-arguments option is tokenized. Task text is never parsed as runtime flags.
- Headless runs honor configuration but never fabricate interactive consent. Approval and elicitation requests are persisted to the owning job, answered through the response command/agent bridge, and delivered back to the same JSON-RPC request.

## Audit coverage

| Findings | Root cause | Status |
| --- | --- | --- |
| F01, F03, F04, F05 | Missing process/turn ownership and terminal supervision | Implemented; fixture/process regressions |
| F02, F14 | Unlocked mutable index and destructive pruning | Implemented; 8 writers / 80 updates and killed-owner recovery |
| F06, F16 | Ambiguous argument transport | Implemented; literal prompt/flags regression |
| F07, F08 | Hooks lack idempotence and bounded re-entry | Implemented; repeated exports, re-entry and open-stdin regressions |
| F09 | Import correlated to a changing source | Implemented; Windows-path/growing-source fixtures and fake native import |
| F10, F11 | Shell-dependent execution/build | Implemented; Windows tests/build and POSIX kill injection |
| F12, F13, F17 | UTF-16 and line-oriented Git parsing | Implemented; Unicode/Git fixtures |
| F15 and protocol risks | Effective config and unsupported interactive requests | Implemented policy inheritance plus request-id-scoped approval/elicitation bridge; credential refresh still requires interactive Codex |

Tests must exercise concurrent writers, interrupted workers, disconnect/error/missing-ID turns, session isolation, literal prompts, and cleanup. Record hostless and live-host evidence separately. No claims of live Claude Code validation without running it.

## Lineage and tradeoffs

- DELETE: `app-server-broker.mjs`, `broker-lifecycle.mjs`, `broker-endpoint.mjs` and the associated broker-only tests. Shared workspace ownership is removed rather than repaired with additional shutdown guesses.
- REWRITE: app-server client supervision, state persistence and session hooks. State uses unique bakery-lock tickets, atomic registers and immutable terminal transitions. A stale ticket never transfers ownership of a shared lock directory.
- KEEP: native review target selection, structured adversarial review output, persistent task threads, import through the native Codex importer, license and upstream authorship.
- PORT/REWRITE: UTF-16 truncation, equals handling, Git NUL lists and process-group fallback implement the audited behavior without merging third-party PRs wholesale.

The startup cost is one app-server per operation. Stop reviews are ephemeral and untracked. Infrastructure failures report an actionable error without repeatedly blocking Claude; only an actual BLOCK verdict blocks. Cancellation may remain pending if an owner is unresponsive, and its outcome is reported honestly.

State intentionally moved away from temporary or ambient plugin data roots. Old state is preserved in place but not automatically trusted, migrated, or used to signal old PIDs. Manually end an old installation's sessions before replacing it.

## Verification boundaries

Windows Node 25.8.0: full fixture suite, concurrency tests and build. Typecheck covers all plugin runtime JavaScript. A real Codex CLI 0.161.0 initialized, answered `config/read`, and its owned guardian exited after close; no model turn was invoked for this smoke check.

The first committed revision passed 107 local tests and both Ubuntu CI targets. A subsequent transport revision uses quoted stdin for slash commands; its shell-expansion regression runs on POSIX and is explicitly skipped on native Windows.

CI additionally runs Ubuntu Node 18.18/22 and Windows Node 22. Live Claude Code slash-command invocation, real model effects, and abnormal MCP descendant cleanup have not been certified locally. The request bridge is covered by deterministic response and state tests; live Claude Code rendering and user-choice UX still need host validation. PID liveness is diagnostic only; no persisted PID is used as kill authority.
