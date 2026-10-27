// Checkpoint file on disk: atomic writes (temp file + rename) and a visible warning when it cannot be read.
import * as nodeFs from "node:fs/promises";
import type { CheckpointStorage } from "../core/checkpoints";

export interface CheckpointStorageOptions {
  /** Called when the file exists but cannot be read; the bad file was already moved aside (backup). */
  onCorrupt?: (info: { reason: string; backup: string | undefined }) => void;
}

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function createCheckpointStorage(dir: string, options: CheckpointStorageOptions = {}): CheckpointStorage {
  const file = `${dir}/checkpoints.json`;
  // Saves run one at a time, so two writers never share the temp file.
  let queue: Promise<void> = Promise.resolve();

  return {
    async load(): Promise<unknown> {
      let text: string;
      try {
        text = await nodeFs.readFile(file, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        options.onCorrupt?.({ reason: reasonOf(err), backup: undefined });
        return undefined;
      }
      try {
        return JSON.parse(text) as unknown;
      } catch (err) {
        const backup = `${file}.corrupt-${Date.now()}`;
        const moved = await nodeFs.rename(file, backup).then(
          () => backup,
          () => undefined,
        );
        options.onCorrupt?.({ reason: reasonOf(err), backup: moved });
        return undefined;
      }
    },

    save(data): Promise<void> {
      const job = queue.then(async () => {
        await nodeFs.mkdir(dir, { recursive: true });
        const tmp = `${file}.tmp`;
        await nodeFs.writeFile(tmp, JSON.stringify(data), "utf8");
        await nodeFs.rename(tmp, file);
      });
      queue = job.catch(() => undefined);
      return job;
    },
  };
}
