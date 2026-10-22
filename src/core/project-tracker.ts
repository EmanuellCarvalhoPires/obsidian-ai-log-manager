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

export class ProjectTracker {
  private cache: { at: number; projects: ProjectInfo[] } | undefined;

  constructor(
    private readonly vault: VaultPort,
    private readonly disk: DiskPort,
    private readonly settings: () => LogSettings,
    private readonly now: () => number = Date.now,
  ) {}

  async projects(): Promise<ProjectInfo[]> {
    if (this.cache && this.now() - this.cache.at < PROJECT_TTL_MS) return this.cache.projects;
    const projects = await this.vault.projects();
    this.cache = { at: this.now(), projects };
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
    const sorted = [...(await this.projects())].sort((a, b) => b.name.length - a.name.length);
    return sorted.find((p) => new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegExp(p.name)}(?![\\p{L}\\p{N}])`, "iu").test(prompt));
  }

  async byName(name: string): Promise<ProjectInfo | undefined> {
    const key = name.trim().toLowerCase();
    return (await this.projects()).find((p) => p.name.toLowerCase() === key);
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

export function cwdKey(cwd: string): string {
  return normalizePathKey(cwd);
}
