// Finds Claude Code sessions and transcripts on disk (~/.claude/sessions and ~/.claude/projects).
import type { DiskPort } from "./ports";
import { redactSecrets } from "./redactor";
import { stripBom } from "./text-utils";
import { parseTranscript } from "./transcript";

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

export interface TranscriptCandidateSummary {
  cwd?: string;
  firstPrompt?: string;
}

export interface SubagentRef {
  agentId: string;
  path: string;
  agentType: string | undefined;
  description: string | undefined;
  model: string | undefined;
  finished: boolean;
}

/** The tool call being answered right now: the tool name and the arguments the plugin received. */
export interface PendingToolCall {
  tool: string;
  args: Record<string, unknown>;
}

const TAIL_BYTES = 96 * 1024;

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Every argument the plugin received (except "sessao") must be in the arguments the agent sent. */
function argsMatch(sent: unknown, received: Record<string, unknown>): boolean {
  let obj = sent;
  if (typeof obj === "string") {
    try {
      obj = JSON.parse(obj);
    } catch {
      return false;
    }
  }
  if (typeof obj !== "object" || obj === null) return Object.keys(received).filter((k) => k !== "sessao").length === 0;
  const rec = obj as Record<string, unknown>;
  return Object.entries(received)
    .filter(([k]) => k !== "sessao")
    .every(([k, v]) => sameValue(rec[k], v));
}

function toolUseMatches(name: string, input: unknown, call: PendingToolCall): boolean {
  const short = name.split("__").pop() ?? name;
  const inp = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  if (short === call.tool) return argsMatch(inp, call.args);
  if (short === "tools_run") {
    const entries = Array.isArray(inp.calls) ? (inp.calls as unknown[]) : [inp];
    return entries.some((e) => {
      const entry = typeof e === "object" && e !== null ? (e as Record<string, unknown>) : {};
      return entry.id === call.tool && argsMatch(entry.args ?? {}, call.args);
    });
  }
  return false;
}

const META_TTL_MS = 15_000;
const LIST_TTL_MS = 2_000;

export class SessionLocator {
  private metaCache: { at: number; byId: Map<string, SessionMeta> } | undefined;
  private listCache: { at: number; list: TranscriptRef[] } | undefined;

  constructor(
    private readonly disk: DiskPort,
    private readonly claudeHome: () => string,
    private readonly now: () => number = Date.now,
  ) {}

  projectsDir(): string {
    return `${this.claudeHome()}/projects`;
  }

  invalidate(): void {
    this.metaCache = undefined;
    this.listCache = undefined;
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
    const now = this.now();
    if (now > 0 && this.listCache && now - this.listCache.at < LIST_TTL_MS) {
      return this.listCache.list;
    }
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
    const sorted = out.sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (now > 0) this.listCache = { at: now, list: sorted };
    return sorted;
  }

  /** Reads the working directory and the beginning of the first user prompt of a candidate transcript (LM-09). */
  async describeTranscript(path: string): Promise<TranscriptCandidateSummary> {
    try {
      const text = await this.disk.readText(path);
      const head = text.length > 32_768 ? text.slice(0, 32_768) : text;
      const parsed = parseTranscript(head);
      const rawPrompt = parsed.turns[0]?.userText?.replace(/\s+/g, " ").trim();
      const firstPrompt = rawPrompt ? redactSecrets(rawPrompt.length > 60 ? `${rawPrompt.slice(0, 60).trimEnd()}…` : rawPrompt) : undefined;
      return { cwd: parsed.cwd, firstPrompt };
    } catch {
      return {};
    }
  }

  /**
   * True when the end of the transcript holds a tool_use (written by Claude Code before it runs the tool) that has no
   * tool_result yet and matches the call being answered: that conversation is the one that called.
   */
  async hasPendingToolCall(path: string, call: PendingToolCall): Promise<boolean> {
    try {
      const st = await this.disk.stat(path);
      if (!st) return false;
      const offset = Math.max(0, st.size - TAIL_BYTES);
      const tail = this.disk.readFrom ? await this.disk.readFrom(path, offset) : (await this.disk.readText(path)).slice(offset);
      const lines = tail.split("\n");
      if (offset > 0) lines.shift();
      const uses: Array<{ id: string | undefined; seq: number; name: string; input: unknown }> = [];
      const done = new Set<string>();
      let lastResultSeq = -1;
      lines.forEach((line, seq) => {
        if (!line.trim()) return;
        let entry: { message?: { content?: unknown } };
        try {
          entry = JSON.parse(stripBom(line)) as typeof entry;
        } catch {
          return;
        }
        const content = entry.message?.content;
        if (!Array.isArray(content)) return;
        for (const block of content as Array<Record<string, unknown>>) {
          if (block.type === "tool_use" && typeof block.name === "string") {
            uses.push({ id: typeof block.id === "string" ? block.id : undefined, seq, name: block.name, input: block.input });
          } else if (block.type === "tool_result") {
            lastResultSeq = seq;
            if (typeof block.tool_use_id === "string") done.add(block.tool_use_id);
          }
        }
      });
      return uses.some((u) => (u.id ? !done.has(u.id) : u.seq > lastResultSeq) && toolUseMatches(u.name, u.input, call));
    } catch {
      return false;
    }
  }

  /** Transcripts of the subagents of a session (`<session>/subagents/agent-*.jsonl`) with their `.meta.json`. */
  async listSubagents(transcriptPath: string): Promise<SubagentRef[]> {
    const dir = `${transcriptPath.replace(/\\/g, "/").replace(/\.jsonl$/, "")}/subagents`;
    const out: SubagentRef[] = [];
    for (const name of await this.disk.list(dir)) {
      if (!name.startsWith("agent-") || !name.endsWith(".jsonl")) continue;
      const base = name.slice(0, -".jsonl".length);
      let meta: Record<string, unknown> = {};
      try {
        meta = JSON.parse(stripBom(await this.disk.readText(`${dir}/${base}.meta.json`))) as Record<string, unknown>;
      } catch {
        // No meta: the subagent is treated as not finished.
      }
      const text = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
      out.push({
        agentId: base.slice("agent-".length),
        path: `${dir}/${name}`,
        agentType: text(meta.agentType),
        description: text(meta.description),
        model: text(meta.model),
        finished: meta.finished === true,
      });
    }
    return out;
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
