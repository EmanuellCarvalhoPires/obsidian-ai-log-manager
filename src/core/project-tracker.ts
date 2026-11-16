// Decides which conversations get a log and which development project a conversation belongs to.
import type { DiskPort, LogSettings, ProjectInfo, VaultPort } from "./ports";
import { isInside, normalizePathKey } from "./text-utils";

export type TrackDecision =
  | { track: true; project: ProjectInfo | undefined; reason: "vault" | "project" | "folder" }
  | { track: false; reason: "outside" };

const PROJECT_TTL_MS = 10_000;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface CompiledProject {
  project: ProjectInfo;
  re: RegExp;
}

export class ProjectTracker {
  private cache: { at: number; projects: ProjectInfo[]; compiled: CompiledProject[] } | undefined;

  constructor(
    private readonly vault: VaultPort,
    private readonly disk: DiskPort,
    private readonly settings: () => LogSettings,
    private readonly now: () => number = Date.now,
  ) {}

  async projects(): Promise<ProjectInfo[]> {
    if (this.cache && this.now() - this.cache.at < PROJECT_TTL_MS) return this.cache.projects;
    const projects = await this.vault.projects();
    const compiled = [...projects]
      .sort((a, b) => b.name.length - a.name.length)
      .map((project) => ({
        project,
        re: new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegExp(project.name)}(?![\\p{L}\\p{N}])`, "iu"),
      }));
    this.cache = { at: this.now(), projects, compiled };
    return projects;
  }

  invalidate(): void {
    this.cache = undefined;
  }

  async resolve(cwd: string | undefined): Promise<TrackDecision> {
    if (!cwd) return { track: false, reason: "outside" };
    const project = (await this.projects()).find((p) => p.clonePath !== undefined && isInside(p.clonePath, cwd));
    if (project) return { track: true, project, reason: "project" };
    if (isInside(this.vault.rootPath(), cwd)) return { track: true, project: undefined, reason: "vault" };
    if (this.settings().trackedFolders.some((f) => f.trim() !== "" && isInside(f.trim(), cwd))) {
      return { track: true, project: undefined, reason: "folder" };
    }
    return { track: false, reason: "outside" };
  }

  /** Project whose note name appears in the prompt (whole words, longest name first). */
  async matchByPrompt(prompt: string): Promise<ProjectInfo | undefined> {
    await this.projects();
    return this.cache?.compiled.find((c) => c.re.test(prompt))?.project;
  }

  async byName(name: string): Promise<ProjectInfo | undefined> {
    const key = normalizeProjectName(name);
    if (!key) return undefined;
    return (await this.projects()).find((p) => normalizeProjectName(p.name) === key);
  }

  /** The project whose name looks most like `name` (contains it, is contained, or is a few letters away), if any. */
  async suggest(name: string): Promise<ProjectInfo | undefined> {
    const key = normalizeProjectName(name);
    if (!key) return undefined;
    let best: { project: ProjectInfo; score: number } | undefined;
    for (const project of await this.projects()) {
      const other = normalizeProjectName(project.name);
      const dist = editDistance(key, other);
      const close = other.includes(key) || key.includes(other) || dist <= Math.max(2, Math.floor(Math.max(key.length, other.length) / 4));
      if (!close) continue;
      const score = other.includes(key) || key.includes(other) ? Math.min(dist, 1) : dist;
      if (!best || score < best.score) best = { project, score };
    }
    return best?.project;
  }

  /** A git repository outside the vault that no project note covers: a candidate for a new project. */
  async isNewProjectCandidate(cwd: string | undefined): Promise<boolean> {
    if (!cwd) return false;
    const decision = await this.resolve(cwd);
    if (decision.track) return false;
    if (isInside(this.vault.rootPath(), cwd)) return false;
    return this.disk.exists(`${cwd.replace(/\\/g, "/").replace(/\/+$/, "")}/.git`);
  }
}

/** "[[Projetos/Meu App.md|alias]]", " meu  app " and "Meu App" all give "meu app" (no accents, no brackets, no path). */
export function normalizeProjectName(raw: string): string {
  let name = raw.trim().replace(/^\[\[/, "").replace(/\]\]$/, "");
  name = name.split("|")[0].split("#")[0].replace(/\\/g, "/").replace(/\/+$/, "");
  name = name.split("/").pop() ?? name;
  name = name.replace(/\.md$/i, "");
  return name.normalize("NFD").replace(/\p{M}/gu, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

export function cwdKey(cwd: string): string {
  return normalizePathKey(cwd);
}
