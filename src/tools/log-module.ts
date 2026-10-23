// What AI Log Manager registers in the AI Ecosystem: MCP tools (plan section 6), the hook
// endpoint and the instructions. Handlers only translate arguments and results.
import type { CheckpointStore } from "../core/checkpoints";
import type { LogEngine, SyncResult } from "../core/engine";
import { HookHandler } from "../core/hook-handler";
import type { LogSettings } from "../core/ports";
import type { ProjectTracker } from "../core/project-tracker";
import type { SessionLocator } from "../core/session-locator";
import type { HubRoute, HubTool, HubToolResult } from "../ecosystem/types";

export const MODULE_ID = "ai-log-manager";

export const MODULE_INSTRUCTIONS =
  "AI Log Manager keeps the conversation logs of this vault by itself: it watches the Claude Code transcripts, creates the log of a new conversation " +
  "and adds each new request and answer, without duplicates. You normally do not need to create or update a log. " +
  "Use logs_status to see the state, logs_update to write the latest answer now, logs_create only to give a log its title, " +
  "logs_link_project to attach a log to a development project and logs_rename to change its title. Never build a log note by hand.";

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

function jsonResult(structured: Record<string, unknown>, isError = false): HubToolResult {
  return { content: [{ type: "text", text: JSON.stringify(structured, null, 2) }], structuredContent: structured, isError };
}

function fail(message: string): HubToolResult {
  return jsonResult({ error: message }, true);
}

function describe(res: SyncResult): Record<string, unknown> {
  return { session: res.sessao, status: res.status, entries_added: res.added, note: res.notaLog, detail: res.detail };
}

async function resolveSession(deps: ToolDeps, explicit: unknown): Promise<string | undefined> {
  const given = text(explicit);
  if (given) return given;
  // The MCP caller does not say which conversation it is: the most recently changed tracked one is it.
  for (const ref of await deps.locator.listTranscripts()) {
    if (deps.store.get(ref.sessionId)?.ignorada !== true) return ref.sessionId;
  }
  return undefined;
}

const SESSION_PROP = {
  sessao: {
    type: "string",
    description: "Claude Code session id. Leave empty to use the most recently changed conversation.",
  },
};

export function buildTools(deps: ToolDeps): HubTool[] {
  const guard = (fn: (args: Args) => Promise<HubToolResult>) => async (args: Args): Promise<HubToolResult> => {
    try {
      return await fn(args);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
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
      inputSchema: { type: "object", properties: { ...SESSION_PROP, limit: { type: "number", description: "How many conversations to list (default 10)." } } },
      annotations: { readOnlyHint: true, idempotentHint: true },
      availableDuringSetup: true,
      handler: guard(async (args) => {
        const settings = deps.settings();
        const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : 10;
        const only = text(args.sessao);
        const all = deps.store.all().filter((c) => !c.ignorada && (!only || c.sessao === only));
        const sessions = all
          .sort((a, b) => b.mtimeMs - a.mtimeMs)
          .slice(0, limit)
          .map((c) => ({ session: c.sessao, note: c.notaLog, project: c.projeto, last_entry: c.hashUltimoRegistro, transcript: c.caminhoTranscript }));
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
    {
      name: "logs_create",
      categoria: "logs",
      tags: ["logs", "conversa", "criar"],
      resumo: "Cria nota de log de conversa com título customizado",
      efeito: "cofre",
      exposicao: "indice",
      description:
        "Creates the log of a conversation if it does not exist yet, with the given title (3 to 8 words, Portuguese, no links, dates or / \\ : * ? \" < > |). " +
        "The engine creates logs by itself, so use this only to choose the title. Does nothing if the log exists.",
      inputSchema: { type: "object", properties: { ...SESSION_PROP, titulo: { type: "string", description: "Title of the log." }, projeto: { type: "string", description: "Development project note name, optional." } } },
      handler: guard(async (args) => {
        const session = await resolveSession(deps, args.sessao);
        if (!session) return fail("No conversation found.");
        const res = await deps.engine.syncSession(session, { force: true, title: text(args.titulo), project: text(args.projeto) });
        return jsonResult(describe(res), res.status === "error" || res.status === "missing");
      }),
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
        const session = await resolveSession(deps, args.sessao);
        if (!session) return fail("No conversation found.");
        const res = await deps.engine.syncSession(session, { force: true });
        return jsonResult(describe(res), res.status === "error" || res.status === "missing");
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
        if (!project) {
          const names = (await deps.tracker.projects()).map((p) => p.name);
          return fail(`Project "${name}" was not found. Projects with the tag dev/projeto: ${names.join(", ") || "none"}.`);
        }
        const session = await resolveSession(deps, args.sessao);
        if (!session) return fail("No conversation found.");
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
        const session = await resolveSession(deps, args.sessao);
        if (!session) return fail("No conversation found.");
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
      description: "Receives a Claude Code hook event: { evento, sessao, cwd?, prompt?, comando? }.",
      handler: async (req) => {
        const event = HookHandler.parse(req.body);
        if (!event) return { status: 400, body: { error: 'Expected { "evento": string, "sessao": string, ... }.' } };
        const result = await deps.hooks.handle(event);
        return { status: result.ok ? 200 : 500, body: result };
      },
    },
  ];
}
