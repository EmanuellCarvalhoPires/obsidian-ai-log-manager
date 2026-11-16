// What AI Log Manager registers in the AI Ecosystem: MCP tools (plan section 6), the hook
// endpoint and the instructions. Handlers only translate arguments and results.
import type { CheckpointStore } from "../core/checkpoints";
import type { LogEngine, SyncResult } from "../core/engine";
import { HookHandler } from "../core/hook-handler";
import type { LogSettings, ProjectInfo } from "../core/ports";
import type { ProjectTracker } from "../core/project-tracker";
import type { PendingToolCall, SessionLocator } from "../core/session-locator";
import type { HubRoute, HubTool, HubToolResult } from "../ecosystem/types";

export const MODULE_ID = "ai-log-manager";

export const MODULE_INSTRUCTIONS =
  "AI Log Manager keeps the conversation logs of this vault by itself: it watches the Claude Code transcripts, creates the log of a new conversation " +
  "and adds each new request and answer, without duplicates. You normally do not need to create or update a log. " +
  "The tools find the conversation that calls them (pass sessao only if an error lists several, or \"self\"). Use logs_status to see the state, logs_update to write the latest answer now, logs_set to choose the title, project and branches of a log (it also works before the log exists; logs_create is the old name of logs_set), " +
  "logs_link_project to attach a log to a development project, logs_rename to change its title and logs_add_fact to record a decision or fact of the conversation. Never build a log note by hand.";

type Args = Record<string, unknown>;

export interface RuntimeStatus {
  watching: boolean;
  hooksInstalled: boolean;
  connected: boolean;
}

export interface ToolDeps {
  engine: LogEngine;
  locator: SessionLocator;
  tracker: ProjectTracker;
  store: CheckpointStore;
  hooks: HookHandler;
  settings: () => LogSettings;
  runtime: () => RuntimeStatus;
}

const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);

/** Tool result carrying the payload once, as compact JSON text without structuredContent duplicate (LM-16). */
function jsonResult(structured: Record<string, unknown>, isError = false): HubToolResult {
  return { content: [{ type: "text", text: JSON.stringify(structured) }], isError };
}

function fail(message: string): HubToolResult {
  return jsonResult({ error: message }, true);
}

function describe(res: SyncResult): Record<string, unknown> {
  return { session: res.sessao, status: res.status, entries_added: res.added, note: res.notaLog, detail: res.detail };
}

/** A conversation counts as active when its transcript changed in the last minutes. */
export const ACTIVE_WINDOW_MS = 5 * 60_000;

/**
 * The MCP call does not say which conversation it comes from, so an explicit id always wins; without one the
 * answer is the only active conversation, and more than one active conversation is an error showing the folder
 * and the start of the first prompt of each candidate (LM-09).
 */
export async function resolveSession(
  deps: Pick<ToolDeps, "locator" | "store">,
  explicit: unknown,
  now: () => number = Date.now,
  call?: PendingToolCall,
): Promise<{ session: string } | { error: string }> {
  const given = text(explicit);
  // "self" (or empty) means: find the conversation that is calling this tool.
  if (given && given.toLowerCase() !== "self") return { session: given };
  const tracked = (await deps.locator.listTranscripts()).filter((r) => deps.store.get(r.sessionId)?.ignorada !== true);
  if (tracked.length === 0) return { error: "No conversation found." };
  const active = tracked.filter((r) => now() - r.mtimeMs <= ACTIVE_WINDOW_MS);
  if (active.length > 1) {
    // Claude Code writes the tool_use to the transcript before it runs the tool: the conversation whose transcript ends
    // with a matching tool_use that has no tool_result yet is the caller.
    let candidates = active;
    if (call && typeof deps.locator.hasPendingToolCall === "function") {
      const matched: typeof active = [];
      for (const r of active) if (await deps.locator.hasPendingToolCall(r.path, call)) matched.push(r);
      if (matched.length === 1) return { session: matched[0].sessionId };
      if (matched.length > 1) candidates = matched;
    }
    const items: string[] = [];
    for (const r of candidates.slice(0, 5)) {
      const info = typeof deps.locator.describeTranscript === "function" ? await deps.locator.describeTranscript(r.path) : {};
      const logTitle = logTitleOf(deps.store.get(r.sessionId)?.notaLog);
      const parts = [`changed ${Math.round((now() - r.mtimeMs) / 1000)}s ago`];
      if (info.cwd) parts.push(`cwd: ${info.cwd}`);
      if (info.firstPrompt) parts.push(`prompt: "${info.firstPrompt}"`);
      items.push(`${r.sessionId}${logTitle ? ` - log "${logTitle}"` : ""} (${parts.join(", ")})`);
    }
    return { error: `More than one conversation is active (${items.join("; ")}). Pass "sessao" with the id of this conversation.` };
  }
  return { session: (active[0] ?? tracked[0]).sessionId };
}

/** Title of a log from its note path: the file name without the "dd-mm-yyyy - HHhMM - " prefix and the extension. */
function logTitleOf(notePath: string | undefined): string | undefined {
  if (!notePath) return undefined;
  const base = (notePath.split("/").pop() ?? notePath).replace(/\.md$/i, "");
  return base.replace(/^\d{2}-\d{2}-\d{4} - \d{2}h\d{2} - /, "") || undefined;
}

const SESSION_PROP = {
  sessao: {
    type: "string",
    description:
      'Claude Code session id, or "self" to let the plugin find the conversation that is calling. Optional: when empty it is found automatically; only needed if the error lists several conversations.',
  },
};

/** Project not found: suggests the closest one and lists the others. */
async function projectNotFound(tracker: ProjectTracker, name: string): Promise<HubToolResult> {
  const names = (await tracker.projects()).map((p) => p.name);
  const near = await tracker.suggest(name);
  const hint = near ? ` Did you mean "${near.name}"?` : "";
  return fail(`Project "${name}" was not found.${hint} Projects with the tag dev/projeto: ${names.join(", ") || "none"}.`);
}

export function buildTools(deps: ToolDeps): HubTool[] {
  const guard = (fn: (args: Args) => Promise<HubToolResult>) => async (args: Args): Promise<HubToolResult> => {
    try {
      return await fn(args);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  };

  const setHandler = (toolName: string) =>
    guard(async (args) => {
      const titulo = text(args.titulo);
      const branches = Array.isArray(args.branches)
        ? args.branches.filter((b): b is string => typeof b === "string" && b.trim() !== "").map((b) => b.trim())
        : [];
      const projectArg = text(args.projeto);
      if (!titulo && !projectArg && branches.length === 0) return fail('Pass at least one of "titulo", "projeto" or "branches".');
      const found = await resolveSession(deps, args.sessao, Date.now, { tool: toolName, args });
      if ("error" in found) return fail(found.error);
      const session = found.session;

      const projectName = projectArg ?? (branches.length > 0 ? deps.store.get(session)?.projeto : undefined);
      let project: ProjectInfo | undefined;
      if (projectName) {
        project = await deps.tracker.byName(projectName);
        if (!project) return projectNotFound(deps.tracker, projectName);
      }
      if (branches.length > 0 && !project) return fail('"branches" needs "projeto" (or a conversation already linked to a project).');

      // 1. Project and branches: remembered when the log does not exist yet, written to the frontmatter when it does.
      if (project) await deps.engine.linkProject(session, project, branches);

      // 2. Title: renames an existing log; before the log exists the engine keeps the title for the creation.
      let note = deps.store.get(session)?.notaLog;
      let status = project ? "linked" : "unchanged";
      if (titulo) {
        if (note) {
          note = (await deps.engine.rename(session, titulo)).notaLog;
          status = "renamed";
        } else {
          const res = await deps.engine.syncSession(session, { force: true, title: titulo, project: project?.name, branches });
          if (res.status === "error" || res.status === "missing") return jsonResult(describe(res), true);
          note = res.notaLog;
          status = res.status === "created" ? "created" : "pending";
        }
      }
      return jsonResult({ session, status, title: titulo, project: project?.name, branches, note, pending: note === undefined });
    });

  const SET_PROPS = {
    ...SESSION_PROP,
    titulo: { type: "string", description: "Title of the log." },
    projeto: { type: "string", description: "Development project note name (tag dev/projeto), optional. Accepts the name with or without [[ ]], a path, any case or accents." },
    branches: { type: "array", items: { type: "string" }, description: "Branch note names to list in `branches` (needs projeto, or a conversation already linked to a project)." },
  };
  const setTool: HubTool = {
    name: "logs_set",
    categoria: "logs",
    tags: ["logs", "conversa", "titulo", "projeto"],
    resumo: "Define título, projeto e branches do log da conversa",
    efeito: "cofre",
    exposicao: "indice",
    description:
      "Sets the title, the development project and the branch notes of the log of a conversation. Works before the log exists (the values are kept and used when the log is created) and after (the log is renamed and linked). " +
      "The conversation is found automatically (pass sessao only if the error lists several). " +
      "Title: 3 to 8 words, Portuguese, no links, dates or / \\ : * ? \" < > |. Pass at least one of titulo, projeto or branches.",
    inputSchema: { type: "object", properties: SET_PROPS },
    handler: setHandler("logs_set"),
  };

  return [
    {
      name: "logs_status",
      categoria: "logs",
      tags: ["logs", "conversa", "status"],
      resumo: "Exibe status do motor de logs de conversas",
      efeito: "leitura",
      exposicao: "indice",
      description: "Shows the state of the log engine: mode, watcher, hooks and the latest conversations with their log notes.",
      inputSchema: { type: "object", properties: { ...SESSION_PROP, limit: { type: "number", description: "How many conversations to list (default 3)." } } },
      annotations: { readOnlyHint: true, idempotentHint: true },
      availableDuringSetup: true,
      handler: guard(async (args) => {
        const settings = deps.settings();
        const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : 3;
        const given = text(args.sessao);
        let only = given;
        if (given?.toLowerCase() === "self") {
          const found = await resolveSession(deps, given, Date.now, { tool: "logs_status", args });
          only = "session" in found ? found.session : undefined;
        }
        const all = deps.store.all().filter((c) => !c.ignorada && (!only || c.sessao === only));
        const sessions = all
          .sort((a, b) => b.mtimeMs - a.mtimeMs)
          .slice(0, limit)
          .map((c) => ({ session: c.sessao, note: c.notaLog, project: c.projeto }));
        return jsonResult({
          mode: settings.mode,
          ...deps.runtime(),
          tracked_conversations: deps.store.all().filter((c) => !c.ignorada).length,
          ignored_conversations: deps.store.all().filter((c) => c.ignorada).length,
          last_reconcile: new Date(deps.store.lastReconcileMs).toISOString(),
          sessions,
        });
      }),
    },
    setTool,
    {
      // Old name still found in notes and habits: it does what logs_set does and says so.
      name: "logs_create",
      categoria: "logs",
      tags: ["logs", "conversa", "titulo", "projeto", "obsoleta"],
      resumo: "Obsoleta: use logs_set (mesmos argumentos)",
      efeito: "cofre",
      exposicao: "indice",
      description: "Deprecated alias of logs_set (same arguments, same result plus a notice). Use logs_set.",
      inputSchema: { type: "object", properties: SET_PROPS },
      handler: async (args, ctx) => {
        const res = await setTool.handler(args, ctx);
        try {
          const data = JSON.parse((res.content[0] as { text: string }).text) as Record<string, unknown>;
          return { ...res, content: [{ type: "text", text: JSON.stringify({ ...data, notice: "logs_create is deprecated; use logs_set." }) }] };
        } catch {
          return res;
        }
      },
    },
    {
      name: "logs_update",
      categoria: "logs",
      tags: ["logs", "conversa", "atualizar"],
      resumo: "Atualiza nota de log com novas mensagens da sessão",
      efeito: "cofre",
      exposicao: "indice",
      description: "Writes the requests and answers that are not in the log yet. Only appends; never changes what is written.",
      inputSchema: { type: "object", properties: { ...SESSION_PROP } },
      annotations: { idempotentHint: true },
      handler: guard(async (args) => {
        const found = await resolveSession(deps, args.sessao, Date.now, { tool: "logs_update", args });
        if ("error" in found) return fail(found.error);
        const session = found.session;
        const res = await deps.engine.syncSession(session, { force: true });
        return jsonResult(describe(res), res.status === "error" || res.status === "missing");
      }),
    },
    {
      name: "logs_add_fact",
      categoria: "logs",
      tags: ["logs", "conversa", "fatos", "decisao"],
      resumo: "Registra decisões e fatos da sessão no log da conversa",
      efeito: "cofre",
      exposicao: "indice",
      description:
        "Adds one or more facts or decisions to the section 'Decisões e Fatos da Sessão' of the log of a conversation, each with a date and time stamp. " +
        "The section is created below the Sumário when it does not exist; repeated facts are skipped. The log must already exist.",
      inputSchema: {
        type: "object",
        properties: {
          ...SESSION_PROP,
          fatos: {
            anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
            description: "A fact or a list of facts, e.g. 'Definido uso de RRF no motor de busca'.",
          },
        },
        required: ["fatos"],
      },
      handler: guard(async (args) => {
        const raw = Array.isArray(args.fatos) ? args.fatos : [args.fatos];
        const facts = raw.filter((f): f is string => typeof f === "string" && f.trim() !== "").map((f) => f.trim());
        if (facts.length === 0) return fail('"fatos" is required (a string or a list of strings).');
        const found = await resolveSession(deps, args.sessao, Date.now, { tool: "logs_add_fact", args });
        if ("error" in found) return fail(found.error);
        const session = found.session;
        const res = await deps.engine.addFacts(session, facts);
        return jsonResult({ session, updated: res.updated, facts_added: res.added, note: res.notaLog });
      }),
    },
    {
      name: "logs_sync_all",
      categoria: "logs",
      tags: ["logs", "conversa", "sincronizar"],
      resumo: "Reconcilia todas as conversas modificadas recentemente",
      efeito: "cofre",
      exposicao: "indice",
      description: "Reconciles every conversation changed since the last reconciliation (what happened while Obsidian was closed).",
      inputSchema: { type: "object", properties: { forcar: { type: "boolean", description: "Reads every transcript again, including ignored ones." } } },
      annotations: { idempotentHint: true },
      handler: guard(async (args) => {
        const results = await deps.engine.syncAll({ force: args.forcar === true });
        const changed = results.filter((r) => r.status === "created" || r.status === "updated" || r.status === "observed");
        return jsonResult({
          checked: results.length,
          created: results.filter((r) => r.status === "created").length,
          updated: results.filter((r) => r.status === "updated").length,
          entries_added: results.reduce((n, r) => n + r.added, 0),
          errors: results.filter((r) => r.status === "error").map(describe),
          changed: changed.map(describe),
        });
      }),
    },
    {
      name: "logs_link_project",
      categoria: "logs",
      tags: ["logs", "projeto", "vincular"],
      resumo: "Vincula log de conversa a um projeto de desenvolvimento",
      efeito: "cofre",
      exposicao: "indice",
      description: "Links the log of a conversation to a development project (Logs index in `up`, `projeto` and optional `branches`).",
      inputSchema: {
        type: "object",
        properties: {
          ...SESSION_PROP,
          projeto: { type: "string", description: "Name of the project note (tag dev/projeto)." },
          branches: { type: "array", items: { type: "string" }, description: "Names of branch notes to list in `branches`." },
        },
        required: ["projeto"],
      },
      handler: guard(async (args) => {
        const name = text(args.projeto);
        if (!name) return fail('"projeto" is required.');
        const project = await deps.tracker.byName(name);
        if (!project) return projectNotFound(deps.tracker, name);
        const found = await resolveSession(deps, args.sessao, Date.now, { tool: "logs_link_project", args });
        if ("error" in found) return fail(found.error);
        const session = found.session;
        const branches = Array.isArray(args.branches) ? args.branches.filter((b): b is string => typeof b === "string") : [];
        const res = await deps.engine.linkProject(session, project, branches);
        return jsonResult({ session, project: project.name, linked: res.linked, note: res.notaLog, pending: !res.linked });
      }),
    },
    {
      name: "logs_rename",
      categoria: "logs",
      tags: ["logs", "conversa", "renomear"],
      resumo: "Renomeia nota de log de conversa",
      efeito: "cofre",
      exposicao: "indice",
      description: "Renames the log of a conversation (file name and heading).",
      inputSchema: { type: "object", properties: { ...SESSION_PROP, titulo: { type: "string", description: "New title." } }, required: ["titulo"] },
      handler: guard(async (args) => {
        const title = text(args.titulo);
        if (!title) return fail('"titulo" is required.');
        const found = await resolveSession(deps, args.sessao, Date.now, { tool: "logs_rename", args });
        if ("error" in found) return fail(found.error);
        const session = found.session;
        const res = await deps.engine.rename(session, title);
        return jsonResult({ session, note: res.notaLog });
      }),
    },
  ];
}

export function buildRoutes(deps: ToolDeps): HubRoute[] {
  return [
    {
      method: "POST",
      path: "/hook",
      description: "Receives a Claude Code hook event: { evento, sessao, cwd?, transcript_path?, prompt? }.",
      handler: async (req) => {
        const event = HookHandler.parse(req.body);
        if (!event) return { status: 400, body: { error: 'Expected { "evento": string, "sessao": string, ... }.' } };
        const result = await deps.hooks.handle(event);
        return { status: result.ok ? 200 : 500, body: result };
      },
    },
  ];
}
