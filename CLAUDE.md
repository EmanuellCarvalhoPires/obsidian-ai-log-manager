# CLAUDE.md — obsidian-ai-log-manager

- Plan: vault note `Projetos/AI Ecosystem/Plugin AI Log Manager/Plano de Implementação - AI Log Manager.md`. Do not use the `fluxo-de-desenvolvimento` skill here (GitHub, no Jira epic).
- `src/core` has no Obsidian imports; it talks to the world through `src/core/ports.ts`. Keep it that way so tests stay in-memory.
- Entry text is compatible with `scripts/gerar_log_conversa.py` of the vault (parity test). Change both or neither.
- UI: Lucide icons via `setIcon`, never emoji. Timers via `src/core/timers.ts` (window timers).
- Test only in the test vault (`.deploy-target`). `git commit` and `git push` only when asked; merge is the user's.
- No secret values in code, notes, logs or tests.
