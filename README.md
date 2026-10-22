# AI Log Manager

Module of the AI Ecosystem suite for Obsidian. It keeps the conversation logs of Claude Code in your vault by itself.

Phases 1 (log engine), 2 (logs screen) and 3 (development events and repository graph) of the vault note "Plano de Implementação - AI Log Manager" are implemented.

## What it does

- Watches the Claude Code transcripts (`~/.claude/projects/**/*.jsonl`), creates the log of a new conversation and appends each new request and answer, without duplicates and without changing what is already written.
- Reconciles when Obsidian opens: completes the logs with what happened while it was closed.
- Optional Claude Code hooks (`SessionStart`, `UserPromptSubmit`, `Stop`, `SessionEnd`) are an extra "update now" trigger. The hook only drops a small file in `spool/`; this plugin reads it, also after Obsidian was closed.
- Links a conversation to a development project (note tagged `dev/projeto`) when the prompt cites it, and proposes a new project (after your confirmation) when a conversation starts in a git repository without a project note.
- MCP tools: `logs_status`, `logs_create`, `logs_update`, `logs_sync_all`, `logs_link_project`, `logs_rename`. Route: `POST /api/v1/ai-log-manager/hook`.

Only conversations started inside the vault, inside a project clone, or inside a folder listed in the settings get a log. Log format and entries are the same as the old `scripts/gerar_log_conversa.py`.

## Logs screen

Ribbon icon or the command "Open the logs screen": list of Claude and Antigravity logs with filters (agent, project, status, date) and search, a preview that renders the note and follows the active conversation, and the repository graph of the project of the selected log.

## Development events

For projects with a note tagged `dev/projeto` and a `**Clone local:**` line, the plugin watches the git reflogs of the clone and records commits, pushes (remote-tracking branch moved) and new branches as notes in `<project>/Eventos/`. It rebuilds what happened while Obsidian was closed from `git log`. The first run only stores a baseline. `gh pr create` (Claude Code hook) records the PR. With "Read pull requests and deploys from the remote" on, GitHub and Bitbucket PRs and deployments are read through Environment Keys (only the secret names are stored).

Each event note has an `ai-log-graph` block that draws the repository graph with the branch and commit highlighted. Tools: `dev_sync`, `dev_record_event`, `dev_changelog`, `dev_graph`.

## Migration mode

`Mode: Observe only` computes what would be written and writes nothing, so the plugin can run next to the old `Stop` hook. Switch to `Active` only after comparing with the existing logs. The old hook is not touched by this plugin.

## Development

```bash
npm install
npm run build      # typecheck + bundle
npm test           # vitest
npm run deploy     # build and copy to the folder in .deploy-target (a test vault)
```

Parity with the old script on a real transcript: set `PARITY_JSONL` and `PARITY_JSON` (output of `gerar_log_conversa.py --file <jsonl> --json`) and run `npx vitest run tests/core/parity.test.ts`.

Requires the AI Ecosystem plugin. Desktop only.
