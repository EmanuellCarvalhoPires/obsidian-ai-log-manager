import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCheckpointStorage } from "../../src/adapters/checkpoint-storage";
import { emptyCheckpointFile } from "../../src/core/checkpoints";

const dirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ailm-cp-"));
  dirs.push(dir);
  return dir.replace(/\\/g, "/");
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("checkpoint storage", () => {
  it("saves and loads, leaving no temp file behind", async () => {
    const dir = tmpDir();
    const storage = createCheckpointStorage(dir);
    const data = { ...emptyCheckpointFile(7), lastReconcileMs: 123 };
    await storage.save(data);
    expect(await storage.load()).toEqual(data);
    expect(fs.readdirSync(dir)).toEqual(["checkpoints.json"]);
  });

  it("returns undefined without warning when the file does not exist yet", async () => {
    const warned: unknown[] = [];
    const storage = createCheckpointStorage(tmpDir(), { onCorrupt: (info) => warned.push(info) });
    expect(await storage.load()).toBeUndefined();
    expect(warned).toEqual([]);
  });

  it("moves a truncated file aside and warns", async () => {
    const dir = tmpDir();
    fs.writeFileSync(`${dir}/checkpoints.json`, '{"version":1,"sess', "utf8");
    const warned: Array<{ reason: string; backup: string | undefined }> = [];
    const storage = createCheckpointStorage(dir, { onCorrupt: (info) => warned.push(info) });
    expect(await storage.load()).toBeUndefined();
    expect(warned).toHaveLength(1);
    expect(warned[0]!.backup).toBeDefined();
    expect(fs.existsSync(warned[0]!.backup!)).toBe(true);
    expect(fs.existsSync(`${dir}/checkpoints.json`)).toBe(false);
  });

  it("treats an empty file as unreadable", async () => {
    const dir = tmpDir();
    fs.writeFileSync(`${dir}/checkpoints.json`, "", "utf8");
    const warned: unknown[] = [];
    const storage = createCheckpointStorage(dir, { onCorrupt: (info) => warned.push(info) });
    expect(await storage.load()).toBeUndefined();
    expect(warned).toHaveLength(1);
  });

  it("keeps the file valid when many saves run at once, and the last one wins", async () => {
    const dir = tmpDir();
    const storage = createCheckpointStorage(dir);
    const saves: Promise<void>[] = [];
    for (let i = 1; i <= 20; i++) saves.push(storage.save({ ...emptyCheckpointFile(1), lastReconcileMs: i }));
    await Promise.all(saves);
    const loaded = (await storage.load()) as { lastReconcileMs: number };
    expect(loaded.lastReconcileMs).toBe(20);
    expect(fs.readdirSync(dir)).toEqual(["checkpoints.json"]);
  });
});
