---
description: Run a Codex code review against local git state
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--digest]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Transport: pass the raw slash arguments through the quoted heredoc below. Choose a fresh delimiter if CODEX_ARGS appears as a complete line in the arguments. Never interpolate raw user text into shell quotes or a JavaScript expression.


Run a Codex review through the built-in reviewer through an owned runtime.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return the compact digest verbatim to the user.
- The digest is JSON: `status`, `findings[]` (file, line, severity, description), `filesChanged[]`, `commandsRun[]`, `testsSummary`, `failures[]`, and `logPath`. Do not expand it into prose or read the full log unless the user asks.

Execution mode rules:
- If the raw arguments include `--wait`, do not ask. Run the review in the foreground.
- If the raw arguments include `--background`, do not ask. Run the review in a Claude background task.
- Otherwise, estimate the review size before asking:
  - For working-tree review, start with `git status --short --untracked-files=all`.
  - For working-tree review, also inspect both `git diff --shortstat --cached` and `git diff --shortstat`.
  - For base-branch review, use `git diff --shortstat <base>...HEAD`.
  - Treat untracked files or directories as reviewable work even when `git diff --shortstat` is empty.
  - Only conclude there is nothing to review when the relevant working-tree status is empty or the explicit branch diff is empty.
  - Recommend waiting only when the review is clearly tiny, roughly 1-2 files total and no sign of a broader directory-sized change.
  - In every other case, including unclear size, recommend background.
  - When in doubt, run the review instead of declaring that there is nothing to review.
- Then use `AskUserQuestion` exactly once with two options, putting the recommended option first and suffixing its label with `(Recommended)`:
  - `Wait for results`
  - `Run in background`

Argument handling:
- Preserve the user's arguments exactly.
- Do not strip `--wait` or `--background` yourself.
- Do not add extra review instructions or rewrite the user's intent.
- The companion script parses `--wait` and `--background`, but Claude Code's `Bash(..., run_in_background: true)` is what actually detaches the run.
- `/codex:review` defaults to the native reviewer and returns its compact digest. It does not support staged-only review, unstaged-only review, or extra focus text.
- If the user needs custom review instructions or more adversarial framing, they should use `/codex:adversarial-review`.

Foreground flow:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" review --arguments-stdin <<'CODEX_ARGS'
--digest
$ARGUMENTS
CODEX_ARGS
```
- Return Codex's output verbatim, exactly as-is (the compact digest JSON).
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the review output.

Background flow:
- Launch the review with `Bash` in the background:
Use the foreground command above in a Bash call with `run_in_background: true`. Pass the heredoc as a literal tool argument, not a JavaScript expression assembled from user text.
- Return the background job ID immediately; retrieve its result when the user asks.
- After launching the command, tell the user: "Codex review started in the background. Check `/codex:status` for progress."
