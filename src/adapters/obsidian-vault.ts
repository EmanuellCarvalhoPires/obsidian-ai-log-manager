// VaultPort on top of the Obsidian API.
import { FileSystemAdapter, TFile, getAllTags, normalizePath } from "obsidian";
import type { App } from "obsidian";
import type { ProjectInfo, VaultPort } from "../core/ports";

const MEMORY_NOTE = "Memória Claude";
const CLONE_LINE = /\*\*Clone local:\*\*\s*`([^`]+)`/;

export class ObsidianVaultPort implements VaultPort {
  private readonly cloneCache = new Map<string, { mtime: number; clone: string | undefined }>();

  constructor(private readonly app: App) {}

  rootPath(): string {
    const adapter = this.app.vault.adapter;
    return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : "";
  }

  exists(path: string): boolean {
    return this.app.vault.getFileByPath(normalizePath(path)) !== null;
  }

  async read(path: string): Promise<string> {
    return this.app.vault.read(this.file(path));
  }

  async create(path: string, content: string): Promise<void> {
    const clean = normalizePath(path);
    const dir = clean.includes("/") ? clean.slice(0, clean.lastIndexOf("/")) : "";
    if (dir) await this.ensureFolder(dir);
    await this.app.vault.create(clean, content);
  }

  async process(path: string, fn: (content: string) => string): Promise<void> {
    await this.app.vault.process(this.file(path), fn);
  }

  findNoteBySession(ids: string[]): string | undefined {
    for (const file of this.app.vault.getMarkdownFiles()) {
      const sessao: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter?.sessao;
      if (typeof sessao === "string" && ids.includes(sessao.trim())) return file.path;
    }
    return undefined;
  }

  memoryFolder(): string {
    const note = this.app.vault.getMarkdownFiles().find((f) => f.basename === MEMORY_NOTE);
    return note?.parent && note.parent.path !== "/" ? note.parent.path : "Knowledge/Logs";
  }

  async projects(): Promise<ProjectInfo[]> {
    const out: ProjectInfo[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const cache = this.app.metadataCache.getFileCache(file);
      if (!cache) continue;
      const tags = getAllTags(cache) ?? [];
      if (!tags.includes("#dev/projeto")) continue;
      out.push({ name: file.basename, folder: file.parent?.path ?? "", clonePath: await this.cloneOf(file) });
    }
    return out;
  }

  async updateFrontmatter(path: string, fn: (frontmatter: Record<string, unknown>) => void): Promise<void> {
    await this.app.fileManager.processFrontMatter(this.file(path), (fm: Record<string, unknown>) => fn(fm));
  }

  async rename(path: string, newPath: string): Promise<void> {
    await this.app.fileManager.renameFile(this.file(path), normalizePath(newPath));
  }

  async ensureFolder(path: string): Promise<void> {
    const parts = normalizePath(path).split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getFolderByPath(current)) {
        try {
          await this.app.vault.createFolder(current);
        } catch {
          // Created by someone else between the check and the call.
        }
      }
    }
  }

  private file(path: string): TFile {
    const file = this.app.vault.getFileByPath(normalizePath(path));
    if (!file) throw new Error(`Note not found: ${path}`);
    return file;
  }

  private async cloneOf(file: TFile): Promise<string | undefined> {
    const cached = this.cloneCache.get(file.path);
    if (cached && cached.mtime === file.stat.mtime) return cached.clone;
    const text = await this.app.vault.cachedRead(file);
    const clone = CLONE_LINE.exec(text)?.[1]?.trim();
    this.cloneCache.set(file.path, { mtime: file.stat.mtime, clone });
    return clone;
  }
}
