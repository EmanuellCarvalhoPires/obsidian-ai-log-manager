// MCP tools of the development events (Phase 3): dev_sync, dev_record_event, dev_changelog, dev_graph.
import { isDevEventType } from "../core/dev-events";
import type { DevService } from "../core/dev-service";
import type { ProjectInfo } from "../core/ports";
import type { ProjectTracker } from "../core/project-tracker";
import type { HubTool, HubToolResult } from "../ecosystem/types";

type Args = Record<string, unknown>;

export const DEV_INSTRUCTIONS =
  "Development events (commits, pushes, new branches, pull requests, deploys) of projects with a clone become notes by themselves: use dev_sync to look now, " +
  "dev_record_event for an event the repository cannot show, dev_changelog for a release note and dev_graph for the repository graph (SVG).";

export interface DevToolDeps {
  dev: DevService;
  tracker: ProjectTracker;
}

const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);

function jsonResult(structured: Record<string, unknown>, isError = false): HubToolResult {
  return { content: [{ type: "text", text: JSON.stringify(structured, null, 2) }], structuredContent: structured, isError };
}

const fail = (message: string): HubToolResult => jsonResult({ error: message }, true);

async function resolveProject(deps: DevToolDeps, name: unknown): Promise<{ project: ProjectInfo } | { error: string }> {
  const given = text(name);
  const projects = await deps.tracker.projects();
  if (given) {
    const project = await deps.tracker.byName(given);
    return project
      ? { project }
      : { error: `Project "${given}" was not found. Projects with the tag dev/projeto: ${projects.map((p) => p.name).join(", ") || "none"}.` };
  }
  const withClone = projects.filter((p) => p.clonePath);
  const only = withClone.length === 1 ? withClone[0] : undefined;
  return only ? { project: only } : { error: '"projeto" is required (more than one project has a clone).' };
}

const PROJECT_PROP = { projeto: { type: "string", description: "Name of the project note (tag dev/projeto)." } };

export function buildDevTools(deps: DevToolDeps): HubTool[] {
  const guard =
    (fn: (args: Args) => Promise<HubToolResult>) =>
    async (args: Args): Promise<HubToolResult> => {
      try {
        return await fn(args);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    };

  return [
    {
      name: "dev_sync",
      description:
        "Looks at the git repository of a project and records the commits, pushes and new branches that are not in the vault yet. " +
        "With remoto=true it also reads pull requests and deployments from GitHub or Bitbucket (needs the secret configured in the plugin).",
      inputSchema: { type: "object", properties: { ...PROJECT_PROP, remoto: { type: "boolean", description: "Also read the remote (PRs and deploys)." } } },
      annotations: { idempotentHint: true },
      handler: guard(async (args) => {
        const found = await resolveProject(deps, args.projeto);
        if ("error" in found) return fail(found.error);
        const res = await deps.dev.sync(found.project, { remote: args.remoto === true });
        return jsonResult(
          { project: res.project, baseline: res.baseline, created: res.created, errors: res.errors },
          res.errors.length > 0 && res.created.length === 0,
        );
      }),
    },
    {
      name: "dev_record_event",
      description:
        "Records a development event as a note in the events folder of the project (once per id). Commits, pushes and branches are recorded by themselves; use this for PRs and deploys that the repository cannot show.",
      inputSchema: {
        type: "object",
        properties: {
          ...PROJECT_PROP,
          tipo: { type: "string", enum: ["commit", "push", "branch", "pr", "deploy"] },
          titulo: { type: "string" },
          id: { type: "string", description: "Stable id so the event is recorded once. Default: type plus branch, hash and title." },
          branch: { type: "string" },
          hash: { type: "string" },
          url: { type: "string" },
          estado: { type: "string", description: "PR: open, merged or declined. Deploy: success, failure..." },
          ambiente: { type: "string", description: "Deploy environment." },
          detalhes: { type: "string", description: "Markdown added under the table." },
        },
        required: ["projeto", "tipo", "titulo"],
      },
      handler: guard(async (args) => {
        const found = await resolveProject(deps, args.projeto);
        if ("error" in found) return fail(found.error);
        if (!isDevEventType(args.tipo)) return fail('"tipo" must be commit, push, branch, pr or deploy.');
        const titulo = text(args.titulo);
        if (!titulo) return fail('"titulo" is required.');
        const hash = text(args.hash);
        const branch = text(args.branch);
        const id = text(args.id) ?? `${args.tipo}-${[branch, hash, titulo].filter(Boolean).join("-")}`;
        const res = await deps.dev.record(found.project, {
          tipo: args.tipo,
          projeto: found.project.name,
          id,
          titulo,
          data: new Date(),
          branch,
          hash,
          url: text(args.url),
          estado: text(args.estado),
          ambiente: text(args.ambiente),
          detalhes: text(args.detalhes),
        });
        return jsonResult({ note: res.path, created: res.created, id });
      }),
    },
    {
      name: "dev_changelog",
      description:
        "Creates the changelog note of a release from the git history between two refs (default: the last tag up to HEAD) in the Changelogs folder of the project.",
      inputSchema: {
        type: "object",
        properties: {
          ...PROJECT_PROP,
          desde: { type: "string", description: "Start ref (tag, branch or hash), exclusive. Default: last tag." },
          ate: { type: "string", description: "End ref, inclusive. Default: HEAD." },
          versao: { type: "string", description: "Release name for the note. Default: the tag or today's date." },
        },
      },
      handler: guard(async (args) => {
        const found = await resolveProject(deps, args.projeto);
        if ("error" in found) return fail(found.error);
        const res = await deps.dev.changelog(found.project, { desde: text(args.desde), ate: text(args.ate), versao: text(args.versao) });
        return jsonResult({ note: res.path, commits: res.commits, created: res.created });
      }),
    },
    {
      name: "dev_graph",
      description: "Returns the repository graph of a project as an SVG document (newest commits of all branches), with an optional branch and commit highlighted.",
      inputSchema: {
        type: "object",
        properties: {
          ...PROJECT_PROP,
          limite: { type: "number", description: "Commits to draw (default from the settings)." },
          branch: { type: "string" },
          hash: { type: "string" },
        },
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
      handler: guard(async (args) => {
        const found = await resolveProject(deps, args.projeto);
        if ("error" in found) return fail(found.error);
        const limit = typeof args.limite === "number" && args.limite > 0 ? Math.floor(args.limite) : undefined;
        const g = await deps.dev.graph(found.project, { limit, highlight: { branch: text(args.branch), hash: text(args.hash) } });
        return jsonResult({ project: found.project.name, commits: g.rows.length, lanes: g.lanes, svg: g.svg });
      }),
    },
  ];
}
