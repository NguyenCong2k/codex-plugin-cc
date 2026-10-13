# Codex plugin for Claude Code

Use Codex from inside Claude Code for code reviews or to delegate tasks to Codex.

This fork maintains root-cause reliability fixes on the `patched` branch; `main` tracks OpenAI upstream. See [remediation](docs/REMEDIATION.md).

This plugin is for Claude Code users who want an easy way to start using Codex from the workflow
they already have.

<video src="./docs/plugin-demo.webm" controls muted playsinline autoplay></video>

## What You Get

- `/codex:review` for a normal read-only Codex review
- `/codex:adversarial-review` for a steerable challenge review
- `/codex:rescue`, `/codex:transfer`, `/codex:status`, `/codex:result`, and `/codex:cancel` to delegate work, hand off sessions, and manage background jobs

## Requirements

- **ChatGPT subscription (incl. Free) or OpenAI API key.**
  - Usage will contribute to your Codex usage limits. [Learn more](https://developers.openai.com/codex/pricing).
- **Node.js 18.18 or later**

## Reliability changes in this fork

Each job owns an app-server supervised by a guardian. A session ending requests cancellation of its own jobs; it cannot terminate another session's runtime. Job records use private storage and atomic interprocess transactions. Active jobs remain available regardless of the history cap, and finished results survive session exit. RPCs and turns have explicit deadlines, with no automatic replay after an uncertain outcome.

The defaults are a 30-second RPC deadline and a 30-minute turn budget. Override them with positive millisecond values in `CODEX_COMPANION_RPC_TIMEOUT_MS` and `CODEX_COMPANION_TURN_TIMEOUT_MS`. Cancellation is acknowledged by the worker; the helper reports a pending cancellation if the owner has not responded.

State is kept in `~/.codex-plugin-cc`, independent of `CLAUDE_PLUGIN_DATA`. Set `CODEX_COMPANION_STATE_HOME` to a private directory to choose another location. Old temporary state and broker processes are not imported or signalled automatically. Re-enable the review gate with `/codex:setup --enable-review-gate` after migrating; keep the old installation available if you need to retrieve its old job history.

Rescue uses a prompt file and grants write access only for an authorized edit request. Direct CLI task calls parse flags only before the first positional prompt; use `--` or `--prompt-file` to preserve text that begins with a flag. Slash-command wrappers explicitly use `--arguments`; `--arguments-file` is also available for a quoted heredoc or another literal file transport.

Interactive approvals, elicitation and credential refresh callbacks require an interactive Codex client. The helper reports that requirement and the saved thread ID instead of manufacturing consent or claiming a successful run. Model and reasoning-effort values are forwarded to Codex for validation, so new server-supported values do not require a plugin-side allowlist update.

## Receiving upstream updates

`main` tracks OpenAI's repository; `patched` contains the maintained fork. The fork's default branch is `patched` so marketplace installs receive the fixes.

```bash
git fetch upstream
git switch main
git merge --ff-only upstream/main
git push origin main
git switch patched
git merge main
npm ci
npm test
npm run build
git push origin patched
```

Resolve conflicts before testing and publishing. When upstream implements an equivalent fix, remove the duplicate fork implementation while preserving its regression coverage. The upstream remote is `https://github.com/openai/codex-plugin-cc.git`; origin is this fork.

## Install

Add the marketplace in Claude Code:

```bash
/plugin marketplace add NguyenCong2k/codex-plugin-cc
```

Install the plugin:

```bash
/plugin install codex@nguyencong-codex
```

Reload plugins:

```bash
/reload-plugins
```

Then run:

```bash
/codex:setup
```

`/codex:setup` will tell you whether Codex is ready. If Codex is missing and npm is available, it can offer to install Codex for you.

If you prefer to install Codex yourself, use:

```bash
npm install -g @openai/codex
```

If Codex is installed but not logged in yet, run:

```bash
!codex login
```

After install, you should see:

- the slash commands listed below
- the `codex:codex-rescue` subagent in `/agents`

One simple first run is:

```bash
/codex:review --background
/codex:status
/codex:result
```

## Usage

### `/codex:review`

Runs a normal Codex review on your current work. It gives you the same quality of code review as running `/review` inside Codex directly.

> [!NOTE]
> Code review especially for multi-file changes might take a while. It's generally recommended to run it in the background.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch like `main`

Use `--base <ref>` for branch review. It also supports `--wait` and `--background`. It is not steerable and does not take custom focus text. Use [`/codex:adversarial-review`](#codexadversarial-review) when you want to challenge a specific decision or risk area.

Examples:

```bash
/codex:review
/codex:review --base main
/codex:review --background
```

This command is read-only and will not perform any changes. When run in the background you can use [`/codex:status`](#codexstatus) to check on the progress and [`/codex:cancel`](#codexcancel) to cancel the ongoing task.

### `/codex:adversarial-review`

Runs a **steerable** review that questions the chosen implementation and design.

It can be used to pressure-test assumptions, tradeoffs, failure modes, and whether a different approach would have been safer or simpler.

It uses the same review target selection as `/codex:review`, including `--base <ref>` for branch review.
It also supports `--wait` and `--background`. Unlike `/codex:review`, it can take extra focus text after the flags.

Use it when you want:

- a review before shipping that challenges the direction, not just the code details
- review focused on design choices, tradeoffs, hidden assumptions, and alternative approaches
- pressure-testing around specific risk areas like auth, data loss, rollback, race conditions, or reliability

Examples:

```bash
/codex:adversarial-review
/codex:adversarial-review --base main challenge whether this was the right caching and retry design
/codex:adversarial-review --background look for race conditions and question the chosen approach
```

This command is read-only. It does not fix code.

### `/codex:rescue`

Hands a task to Codex through the `codex:codex-rescue` subagent.

Use it when you want Codex to:

- investigate a bug
- try a fix
- continue a previous Codex task
- take a faster or cheaper pass with a smaller model

> [!NOTE]
> Depending on the task and the model you choose these tasks might take a long time and it's generally recommended to force the task to be in the background or move the agent to the background.

It supports `--background`, `--wait`, `--resume`, and `--fresh`. If you omit `--resume` and `--fresh`, the plugin can offer to continue the latest rescue thread for this repo.

Examples:

```bash
/codex:rescue investigate why the tests started failing
/codex:rescue fix the failing test with the smallest safe patch
/codex:rescue --resume apply the top fix from the last run
/codex:rescue --model gpt-5.4-mini --effort medium investigate the flaky integration test
/codex:rescue --model spark fix the issue quickly
/codex:rescue --background investigate the regression
```

You can also just ask for a task to be delegated to Codex:

```text
Ask Codex to redesign the database connection to be more resilient.
```

**Notes:**

- if you do not pass `--model` or `--effort`, Codex chooses its own defaults.
- if you say `spark`, the plugin maps that to `gpt-5.3-codex-spark`
- follow-up rescue requests can continue the latest Codex task in the repo

### `/codex:transfer`

Creates a persistent Codex thread from the current Claude Code session and prints a `codex resume <session-id>` command.

Use it when you started a debugging or implementation conversation in Claude Code and want to continue that same context directly in Codex.

Examples:

```bash
/codex:transfer
/codex:transfer --source ~/.claude/projects/-Users-me-repo/<session-id>.jsonl
```

The plugin's existing `SessionStart` hook supplies the current transcript path automatically; `--source` is available as a manual override. The transfer uses Codex's external-agent session importer, so it follows the same conversion rules as importing Claude history in the Codex App and creates visible turns that can be continued in the App or TUI. The source must be under `~/.claude/projects`, and older Codex versions that do not expose session import must be upgraded before using this command.

### `/codex:status`

Shows running and recent Codex jobs for the current repository.

Examples:

```bash
/codex:status
/codex:status task-abc123
```

Use it to:

- check progress on background work
- see the latest completed job
- confirm whether a task is still running

### `/codex:result`

Shows the final stored Codex output for a finished job.
When available, it also includes the Codex session ID so you can reopen that run directly in Codex with `codex resume <session-id>`.

Examples:

```bash
/codex:result
/codex:result task-abc123
```

### `/codex:cancel`

Cancels an active background Codex job.

Examples:

```bash
/codex:cancel
/codex:cancel task-abc123
```

### `/codex:setup`

Checks whether Codex is installed and authenticated.
If Codex is missing and npm is available, it can offer to install Codex for you.

You can also use `/codex:setup` to manage the optional review gate.

#### Enabling review gate

```bash
/codex:setup --enable-review-gate
/codex:setup --disable-review-gate
```

When the review gate is enabled, the plugin uses a `Stop` hook to run a targeted Codex review based on Claude's response. If that review finds issues, the stop is blocked so Claude can address them first.

> [!WARNING]
> The review gate can create a long-running Claude/Codex loop and may drain usage limits quickly. Only enable it when you plan to actively monitor the session.

## Typical Flows

### Review Before Shipping

```bash
/codex:review
```

### Hand A Problem To Codex

```bash
/codex:rescue investigate why the build is failing in CI
```

### Start Something Long-Running

```bash
/codex:adversarial-review --background
/codex:rescue --background investigate the flaky test
```

Then check in with:

```bash
/codex:status
/codex:result
```

## Codex Integration

The Codex plugin wraps the [Codex app server](https://developers.openai.com/codex/app-server). It uses your installed `codex` executable and configuration. Each job owns a fresh app-server and closes it on completion or interruption. Stored threads remain resumable. Model and approval policy inherit your configuration; the requested read-only/workspace-write sandbox is enforced explicitly per turn. Interactive approval or elicitation requests fail with a resumable thread ID; complete them in interactive Codex.

### Common Configurations

If you want to change the default reasoning effort or the default model that gets used by the plugin, you can define that inside your user-level or project-level `config.toml`. For example to always use `gpt-5.4-mini` on `high` for a specific project you can add the following to a `.codex/config.toml` file at the root of the directory you started Claude in:

```toml
model = "gpt-5.4-mini"
model_reasoning_effort = "high"
```

Your configuration will be picked up based on:

- user-level config in `~/.codex/config.toml`
- project-level overrides in `.codex/config.toml`
- project-level overrides only load when the [project is trusted](https://developers.openai.com/codex/config-advanced#project-config-files-codexconfigtoml)

Check out the Codex docs for more [configuration options](https://developers.openai.com/codex/config-reference).

### Moving The Work Over To Codex

Delegated tasks and any [stop gate](#what-does-the-review-gate-do) run can also be directly resumed inside Codex by running `codex resume` either with the specific session ID you received from running `/codex:result` or `/codex:status` or by selecting it from the list.

This way you can review the Codex work or continue the work there.

## FAQ

### Do I need a separate Codex account for this plugin?

If you are already signed into Codex on this machine, that account should work immediately here too. This plugin uses your local Codex CLI authentication.

If you only use Claude Code today and have not used Codex yet, you will also need to sign in to Codex with either a ChatGPT account or an API key. [Codex is available with your ChatGPT subscription](https://developers.openai.com/codex/pricing/), and [`codex login`](https://developers.openai.com/codex/cli/reference/#codex-login) supports both ChatGPT and API key sign-in. Run `/codex:setup` to check whether Codex is ready, and use `!codex login` if it is not.

### Does the plugin use a separate Codex runtime?

No. This plugin delegates through your local [Codex CLI](https://developers.openai.com/codex/cli/) and [Codex app server](https://developers.openai.com/codex/app-server/) on the same machine.

That means:

- it uses the same Codex install you would use directly
- it uses the same local authentication state
- it uses the same repository checkout and machine-local environment

### Will it use the same Codex config I already have?

Yes. If you already use Codex, the plugin picks up the same [configuration](#common-configurations).

### Can I keep using my current API key or base URL setup?

Yes. Because the plugin uses your local Codex CLI, your existing sign-in method and config still apply.

If you need to point the built-in OpenAI provider at a different endpoint, set `openai_base_url` in your [Codex config](https://developers.openai.com/codex/config-advanced/#config-and-state-locations).
