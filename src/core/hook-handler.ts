// Handles the events the Claude Code hook drops (SessionStart, UserPromptSubmit, Stop, SessionEnd).
// The hook is thin: all decisions are made here.
import { CheckpointStore } from "./checkpoints";
import { LogEngine } from "./engine";
import { ProjectCreator } from "./project-creator";
import { ProjectTracker, cwdKey } from "./project-tracker";
import type { DevService } from "./dev-service";
import { baseName } from "./text-utils";

export interface HookEvent {
  evento: string;
  sessao: string;
  cwd?: string;
  transcript_path?: string;
  prompt?: string;
  comando?: string;
  /** Output of the command (PostToolUse), cut by the hook. */
  saida?: string;
  tool?: string;
}

/** Asks the person whether a repository becomes a development project (decision D7). */
export interface ProjectPrompter {
  confirmNewProject(info: { cwd: string; name: string }): Promise<boolean>;
}

export interface HookResult {
  ok: boolean;
  action: string;
  detail?: string;
}

export class HookHandler {
  private readonly asking = new Set<string>();

  constructor(
    private readonly engine: LogEngine,
    private readonly tracker: ProjectTracker,
    private readonly store: CheckpointStore,
    private readonly creator: ProjectCreator,
    private readonly prompter: ProjectPrompter,
    private readonly onProjectCreated?: (name: string) => void,
    private readonly dev?: () => DevService | undefined,
    private readonly devEnabled: () => boolean = () => true,
  ) {}

  /** Parses the body of the endpoint or a spool file; returns undefined when it is not an event. */
  static parse(raw: unknown): HookEvent | undefined {
    if (typeof raw !== "object" || raw === null) return undefined;
    const r = raw as Record<string, unknown>;
    const text = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
    const evento = text(r.evento) ?? text(r.hook_event_name);
    const sessao = text(r.sessao) ?? text(r.session_id);
    if (!evento || !sessao) return undefined;
    return {
      evento,
      sessao,
      cwd: text(r.cwd),
      transcript_path: text(r.transcript_path),
      prompt: text(r.prompt),
      comando: text(r.comando),
      saida: text(r.saida),
      tool: text(r.tool),
    };
  }

  async handle(event: HookEvent): Promise<HookResult> {
    switch (event.evento) {
      case "Stop": {
        const res = await this.sync(event, false);
        return { ok: res.status !== "error", action: `sync:${res.status}`, detail: res.detail };
      }
      case "SessionEnd": {
        const res = await this.sync(event, true);
        return { ok: res.status !== "error", action: `sync:${res.status}`, detail: res.detail };
      }
      case "UserPromptSubmit":
        return this.linkByPrompt(event);
      case "SessionStart":
        return this.proposeProject(event);
      case "PostToolUse":
        return this.recordCommand(event);
      default:
        return { ok: true, action: "ignored" };
    }
  }

  private async recordCommand(event: HookEvent): Promise<HookResult> {
    const dev = this.dev?.();
    if (!dev || !this.devEnabled()) return { ok: true, action: "dev-off" };
    const decision = await this.tracker.resolve(event.cwd);
    if (!decision.track || !decision.project) return { ok: true, action: "no-project" };
    const res = await dev.onCommand(decision.project, event.comando, event.saida);
    return { ok: true, action: `dev:${res.action}`, detail: res.created.join(", ") || undefined };
  }

  private sync(event: HookEvent, flush: boolean): ReturnType<LogEngine["syncSession"]> {
    // The extra "update now" trigger: read the transcript even if the watcher already did.
    return event.transcript_path
      ? this.engine.syncTranscript(event.transcript_path, { force: true, flush })
      : this.engine.syncSession(event.sessao, { force: true, flush });
  }

  private async linkByPrompt(event: HookEvent): Promise<HookResult> {
    if (!event.prompt) return { ok: true, action: "no-prompt" };
    const project = await this.tracker.matchByPrompt(event.prompt);
    if (!project) return { ok: true, action: "no-project" };
    const known = this.store.get(event.sessao)?.projeto;
    if (known === project.name) return { ok: true, action: "already-linked" };
    const res = await this.engine.linkProject(event.sessao, project, [], event.transcript_path);
    return { ok: true, action: res.linked ? "linked" : "link-pending", detail: project.name };
  }

  private async proposeProject(event: HookEvent): Promise<HookResult> {
    const cwd = event.cwd;
    if (!cwd || !(await this.tracker.isNewProjectCandidate(cwd))) return { ok: true, action: "not-a-candidate" };
    const key = cwdKey(cwd);
    if (this.store.projectAnswer(key)) return { ok: true, action: "already-answered" };
    if (this.asking.has(key)) return { ok: true, action: "asking" };
    const name = baseName(cwd);
    this.asking.add(key);
    let yes: boolean;
    try {
      yes = await this.prompter.confirmNewProject({ cwd, name });
    } finally {
      this.asking.delete(key);
    }
    if (!yes) {
      this.store.setProjectAnswer(key, "declined");
      return { ok: true, action: "declined" };
    }
    await this.creator.create({ name, clonePath: cwd.replace(/\\/g, "/") });
    this.store.setProjectAnswer(key, "created");
    this.tracker.invalidate();
    this.onProjectCreated?.(name);
    return { ok: true, action: "project-created", detail: name };
  }
}
