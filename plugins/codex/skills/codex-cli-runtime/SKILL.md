---
name: codex-cli-runtime
description: Internal helper contract for calling the codex-companion runtime from Claude Code
user-invocable: false
---

# Codex Runtime

Use this skill only inside the `codex:codex-rescue` subagent.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --background --json [runtime options] --prompt-file <prompt-file>`

Execution rules:
- The rescue subagent is a forwarder with a narrow interactive bridge. It starts one task, answers only that task's pending approval or elicitation requests, and returns its stored result unchanged.
- Prefer the helper over hand-rolled `git`, direct Codex CLI strings, or any other Bash activity.
- Do not call `setup`, `review`, `adversarial-review`, or `cancel` from `codex:codex-rescue`. Status/result calls are allowed only for the one task it started.
- Use `task` for every rescue request, including diagnosis, planning, research, and explicit fix requests.
- You may use the `gpt-5-4-prompting` skill to rewrite the user's request into a tighter Codex prompt before the task call.
- That prompt drafting is the only Claude-side work allowed. Do not inspect the repo, solve the task yourself, or add independent analysis outside the forwarded prompt text.
- Leave `--effort` unset unless the user explicitly requests a specific effort.
- Leave model unset by default. Add `--model` only when the user explicitly asks for one.
- Map `spark` to `--model gpt-5.3-codex-spark`.
- Add `--write` only for an authorized edit or fix request. Diagnosis, review and research run read-only.

Command selection:
- Use exactly one `task` invocation per rescue handoff. That invocation runs in the background so a server request can be surfaced to the user without fabricating consent.
- If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only. Strip it before calling `task`, and do not treat it as part of the natural-language task text.
- If the forwarded request includes `--model`, normalize `spark` to `gpt-5.3-codex-spark` and pass it through to `task`.
- If the forwarded request includes `--effort`, pass it through to `task`.
- If the forwarded request includes `--resume`, strip that token from the task text and add `--resume-last`.
- If the forwarded request includes `--fresh`, strip that token from the task text and do not add `--resume-last`.
- `--resume`: always use `task --resume-last`, even if the request text is ambiguous.
- `--fresh`: always use a fresh `task` run, even if the request sounds like a follow-up.
- `--effort`: accepted values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`.
- `task --resume-last`: internal helper for "keep going", "resume", "apply the top fix", or "dig deeper" after a previous rescue run.

Safety rules:
- Keep diagnosis, review and research read-only; write access requires an authorized edit or fix request.
- Preserve task text using a UTF-8 prompt file. A quoted heredoc may create it in a Bash call; pass only the file path and explicit runtime options to the helper. Never parse prose as options.
- Do not inspect the repository, read files, grep, cancel jobs, summarize output, or do follow-up work. You may poll the one job, ask the user about its pending request, submit a response, and fetch its final result.
- Return the stdout of `result <job-id>` exactly as-is after the job reaches a terminal state.
- If the Bash call fails or Codex cannot be invoked, return the actionable error and known job/session IDs.
