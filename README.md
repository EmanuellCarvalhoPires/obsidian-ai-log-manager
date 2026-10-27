# AI Log Manager

Module of the AI Ecosystem suite for Obsidian. It keeps the conversation logs of Claude Code in your vault by itself.

Phases 1 (log engine) and 2 (logs screen) of the vault note "Plano de Implementação - AI Log Manager" are implemented. Development events (commits, pushes, branches, pull requests, deploys) and the repository graph belong to the AI Git Tools plugin.

## What it does

- Watches the Claude Code transcripts (`~/.claude/projects/**/*.jsonl`), creates the log of a new conversation and appends each new request and answer, without duplicates and without changing what is already written.
- Reconciles when Obsidian opens: completes the logs with what happened while it was closed.
- Optional Claude Code hooks (`SessionStart`, `UserPromptSubmit`, `Stop`, `SessionEnd`) are an extra "update now" trigger. The hook only drops a small file in `spool/`; this plugin reads it, also after Obsidian was closed.
- Links a conversation to a development project (note tagged `dev/projeto`) when the prompt cites it, and proposes a new project (after your confirmation) when a conversation starts in a git repository without a project note.
- MCP tools: `logs_status`, `logs_set`, `logs_update`, `logs_sync_all`, `logs_link_project`, `logs_rename`. Route: `POST /api/v1/ai-log-manager/hook`. Tools that act on one conversation take "sessao"; without it they accept only a single active conversation (changed in the last 5 minutes) and ask for the id otherwise.

Only conversations started inside the vault, inside a project clone, or inside a folder listed in the settings get a log. Each request becomes a "## dd/MM/yyyy - HH:mm - title" entry, listed in the Sumário of the note.

## Logs screen

Ribbon icon or the command "Open the logs screen": list of Claude and Antigravity logs with filters (agent, project, status, date) and search, a preview that renders the note and follows the active conversation.

## Migration mode

`Mode: Observe only` computes what would be written and writes nothing. Switch to `Active` only after comparing with the existing logs. Install the plugin hooks with the command "Install Claude Code hooks".

## Development

```bash
npm install
npm run build      # typecheck + bundle
npm test           # vitest
npm run deploy     # build and copy to the folder in .deploy-target (a test vault)
```

Requires the AI Ecosystem plugin. Desktop only.
