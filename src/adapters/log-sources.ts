// Turns the notes of the vault into LogSource records for the index (metadata cache only, no reads).
import { getAllTags } from "obsidian";
import type { App } from "obsidian";
import type { LogSource } from "../core/log-index";

export function collectLogSources(app: App): LogSource[] {
  const out: LogSource[] = [];
  for (const file of app.vault.getMarkdownFiles()) {
    const cache = app.metadataCache.getFileCache(file);
    if (!cache) continue;
    const tags = getAllTags(cache) ?? [];
    if (!tags.includes("#log")) continue;
    out.push({
      path: file.path,
      basename: file.basename,
      tags,
      frontmatter: cache.frontmatter ?? {},
      headings: (cache.headings ?? []).filter((h) => h.level === 2).map((h) => h.heading),
      ctime: file.stat.ctime,
      mtime: file.stat.mtime,
    });
  }
  return out;
}
