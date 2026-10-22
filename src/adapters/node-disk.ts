// DiskPort on top of Node's fs (desktop only).
import * as fs from "node:fs/promises";
import type { DiskPort, FileStat } from "../core/ports";

export function createNodeDisk(): DiskPort {
  return {
    async readText(path: string): Promise<string> {
      return fs.readFile(path, "utf8");
    },
    async stat(path: string): Promise<FileStat | undefined> {
      try {
        const st = await fs.stat(path);
        return { size: st.size, mtimeMs: st.mtimeMs };
      } catch {
        return undefined;
      }
    },
    async list(path: string): Promise<string[]> {
      try {
        return await fs.readdir(path);
      } catch {
        return [];
      }
    },
    async exists(path: string): Promise<boolean> {
      try {
        await fs.access(path);
        return true;
      } catch {
        return false;
      }
    },
  };
}
