// Finds Claude Code sessions and transcripts on disk (~/.claude/sessions and ~/.claude/projects).
import type { DiskPort } from "./ports";
import { stripBom } from "./text-utils";

export interface SessionMeta {
  sessionId: string;
  hostSessionId: string | undefined;
  name: string | undefined;
  /** "user" when the person named the session, otherwise generated. */
  nameSource: string | undefined;
  cwd: string | undefined;
}

export interface TranscriptRef {
  path: string;
  sessionId: string;
  mtimeMs: number;
}

const META_TTL_MS = 15_000;

export class SessionLocator {
  private metaCache: { at: number; byId: Map<string, SessionMeta> } | undefined;

  constructor(
    private readonly disk: DiskPort,
    private readonly claudeHome: () => string,
    private readonly now: () => number = Date.now,
  ) {}

  projectsDir(): string {
    return `${this.claudeHome()}/projects`;
  }

  async meta(sessionId: string): Promise<SessionMeta | undefined> {
    const cache = await this.loadMeta();
    return cache.get(sessionId);
  }

  /** Transcript of a session: looks in every project folder, like the old script. */
  async transcriptPath(sessionId: string): Promise<string | undefined> {
    for (const dir of await this.disk.list(this.projectsDir())) {
      const candidate = `${this.projectsDir()}/${dir}/${sessionId}.jsonl`;
      if (await this.disk.exists(candidate)) return candidate;
    }
    return undefined;
  }

  /** Every top-level transcript, newest first. Subagent transcripts live deeper and are not listed. */
  async listTranscripts(): Promise<TranscriptRef[]> {
    const out: TranscriptRef[] = [];
    for (const dir of await this.disk.list(this.projectsDir())) {
      const base = `${this.projectsDir()}/${dir}`;
      for (const name of await this.disk.list(base)) {
        if (!name.endsWith(".jsonl")) continue;
        const path = `${base}/${name}`;
        const st = await this.disk.stat(path);
        if (st) out.push({ path, sessionId: name.slice(0, -".jsonl".length), mtimeMs: st.mtimeMs });
      }
    }
    return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  private async loadMeta(): Promise<Map<string, SessionMeta>> {
    if (this.metaCache && this.now() - this.metaCache.at < META_TTL_MS) return this.metaCache.byId;
    const byId = new Map<string, SessionMeta>();
    const dir = `${this.claudeHome()}/sessions`;
    for (const name of await this.disk.list(dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const data = JSON.parse(stripBom(await this.disk.readText(`${dir}/${name}`))) as Record<string, unknown>;
        const sessionId = typeof data.sessionId === "string" ? data.sessionId : undefined;
        if (!sessionId) continue;
        const text = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
        byId.set(sessionId, {
          sessionId,
          hostSessionId: text(data.hostSessionId),
          name: text(data.name),
          nameSource: text(data.nameSource),
          cwd: text(data.cwd),
        });
      } catch {
        // A session file being rewritten; the next call reads it again.
      }
    }
    this.metaCache = { at: this.now(), byId };
    return byId;
  }
}
