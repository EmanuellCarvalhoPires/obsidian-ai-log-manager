// In-memory implementations of the ports, for engine tests.
import { CheckpointStore } from "../../src/core/checkpoints";
import { LogEngine } from "../../src/core/engine";
import { DEFAULT_LOG_SETTINGS } from "../../src/core/ports";
import type { DiskPort, FileStat, LogSettings, ProjectInfo, VaultPort } from "../../src/core/ports";
import { ProjectTracker } from "../../src/core/project-tracker";
import { SessionLocator } from "../../src/core/session-locator";

export class MemoryDisk implements DiskPort {
  files = new Map<string, { text: string; mtimeMs: number }>();
  put(path: string, text: string, mtimeMs = 1000): void {
    this.files.set(path, { text, mtimeMs });
  }
  append(path: string, text: string, mtimeMs: number): void {
    const cur = this.files.get(path);
    this.files.set(path, { text: (cur?.text ?? "") + text, mtimeMs });
  }
  async readText(path: string): Promise<string> {
    const f = this.files.get(path);
    if (!f) throw new Error(`ENOENT ${path}`);
    return f.text;
  }
  async stat(path: string): Promise<FileStat | undefined> {
    const f = this.files.get(path);
    return f ? { size: Buffer.byteLength(f.text), mtimeMs: f.mtimeMs } : undefined;
  }
  async list(path: string): Promise<string[]> {
    const prefix = `${path}/`;
    const names = new Set<string>();
    for (const key of this.files.keys()) if (key.startsWith(prefix)) names.add(key.slice(prefix.length).split("/")[0]!);
    return [...names];
  }
  async exists(path: string): Promise<boolean> {
    if (this.files.has(path)) return true;
    const prefix = `${path}/`;
    return [...this.files.keys()].some((k) => k.startsWith(prefix));
  }
}

export class MemoryVault implements VaultPort {
  notes = new Map<string, string>();
  frontmatterEdits: string[] = [];
  projectList: ProjectInfo[] = [];
  constructor(public root = "C:/Cofre") {}
  rootPath(): string {
    return this.root;
  }
  exists(path: string): boolean {
    return this.notes.has(path);
  }
  async read(path: string): Promise<string> {
    const n = this.notes.get(path);
    if (n === undefined) throw new Error(`no note ${path}`);
    return n;
  }
  async create(path: string, content: string): Promise<void> {
    if (this.notes.has(path)) throw new Error(`exists ${path}`);
    this.notes.set(path, content);
  }
  async process(path: string, fn: (c: string) => string): Promise<void> {
    this.notes.set(path, fn(await this.read(path)));
  }
  findNoteBySession(ids: string[]): string | undefined {
    for (const [path, content] of this.notes) {
      const m = /^sessao: (.+)$/m.exec(content);
      if (m && ids.includes(m[1]!.trim())) return path;
    }
    return undefined;
  }
  memoryFolder(): string {
    return "Knowledge/Logs";
  }
  async projects(): Promise<ProjectInfo[]> {
    return this.projectList;
  }
  async updateFrontmatter(path: string, fn: (fm: Record<string, unknown>) => void): Promise<void> {
    const fm: Record<string, unknown> = {};
    const content = await this.read(path);
    const up = /^up:\s*\n((?:\s+- .*\n)+)/m.exec(content);
    if (up) fm.up = up[1]!.split("\n").filter(Boolean).map((l) => l.replace(/^\s+- /, "").replace(/^"|"$/g, ""));
    else {
      const single = /^up: "(.*)"$/m.exec(content);
      if (single) fm.up = [single[1]];
    }
    fn(fm);
    this.frontmatterEdits.push(JSON.stringify(fm));
  }
  async rename(path: string, newPath: string): Promise<void> {
    this.notes.set(newPath, await this.read(path));
    this.notes.delete(path);
  }
  async ensureFolder(): Promise<void> {}
}

export interface Harness {
  disk: MemoryDisk;
  vault: MemoryVault;
  store: CheckpointStore;
  engine: LogEngine;
  settings: LogSettings;
  tracker: ProjectTracker;
  transcript: string;
}

export function makeHarness(overrides: Partial<LogSettings> = {}): Harness {
  const disk = new MemoryDisk();
  const vault = new MemoryVault();
  const settings: LogSettings = { ...DEFAULT_LOG_SETTINGS, claudeHome: "C:/home/.claude", ...overrides };
  const store = new CheckpointStore({ load: async () => undefined, save: async () => undefined }, () => 5000);
  const locator = new SessionLocator(disk, () => settings.claudeHome, () => 0);
  const tracker = new ProjectTracker(vault, disk, () => settings, () => 0);
  const engine = new LogEngine({ disk, vault, locator, tracker, store, settings: () => settings });
  return { disk, vault, store, engine, settings, tracker, transcript: `${settings.claudeHome}/projects/proj/sess-1.jsonl` };
}

// Transcript line builders.
export const userLine = (text: string, iso: string, cwd = "C:/Cofre"): string =>
  JSON.stringify({ type: "user", timestamp: iso, cwd, sessionId: "sess-1", message: { role: "user", content: text } }) + "\n";

export const assistantLine = (text: string, iso: string, stop: "end_turn" | "tool_use" = "end_turn", extra: unknown[] = []): string =>
  JSON.stringify({
    type: "assistant",
    timestamp: iso,
    message: { role: "assistant", stop_reason: stop, content: [...extra, { type: "text", text }] },
  }) + "\n";

export const toolUseLine = (name: string, input: Record<string, unknown>, iso: string): string =>
  JSON.stringify({
    type: "assistant",
    timestamp: iso,
    message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", name, input }] },
  }) + "\n";

export const toolResultLine = (iso: string): string =>
  JSON.stringify({
    type: "user",
    timestamp: iso,
    message: { role: "user", content: [{ type: "tool_result", content: "ok" }] },
  }) + "\n";
