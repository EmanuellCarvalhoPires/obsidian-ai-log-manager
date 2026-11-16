// Watches folders on disk (outside the vault, so Obsidian's own events do not apply) with Node's
// fs.watch and a debounce per file. Desktop only: recursive watching works on Windows and macOS
// and on Linux with a recent Node, which Obsidian's Electron provides.
import * as fs from "node:fs";
import { startTimer, stopTimer } from "./timers";

export const DEFAULT_WATCH_RETRY_MS = 10_000;

export interface FolderWatcher {
  /** True while the underlying `fs.watch` handle is open and healthy (LM-14). */
  isActive(): boolean;
  stop(): void;
}

export interface WatchOptions {
  /** Called with the absolute path of a changed file, after the quiet time. */
  onChange: (path: string) => void;
  /** Quiet time after the last event of a file, in milliseconds. */
  debounceMs: () => number;
  recursive?: boolean;
  /** Only these files (by relative name) are reported. */
  accept?: (relativePath: string) => boolean;
  onError?: (err: Error) => void;
  /** Retry delay in ms when watching fails (for example the folder does not exist yet); 0 disables retry. */
  retryMs?: number;
}

export function watchFolder(folder: string, options: WatchOptions): FolderWatcher {
  const timers = new Map<string, number>();
  let watcher: fs.FSWatcher | undefined;
  let active = false;
  let stopped = false;
  let retryTimer: number | undefined;
  const retryDelay = options.retryMs ?? DEFAULT_WATCH_RETRY_MS;

  const scheduleRetry = (): void => {
    if (stopped || retryTimer !== undefined || retryDelay <= 0) return;
    retryTimer = startTimer(() => {
      retryTimer = undefined;
      tryStart();
    }, retryDelay);
  };

  const tryStart = (): void => {
    if (stopped) return;
    try {
      watcher = fs.watch(folder, { recursive: options.recursive ?? false, persistent: false }, (_event, filename) => {
        const name = typeof filename === "string" ? filename : filename ? String(filename) : "";
        if (!name) return;
        const relative = name.replace(/\\/g, "/");
        if (options.accept && !options.accept(relative)) return;
        const full = `${folder.replace(/\\/g, "/").replace(/\/+$/, "")}/${relative}`;
        const pending = timers.get(full);
        if (pending) stopTimer(pending);
        timers.set(
          full,
          startTimer(() => {
            timers.delete(full);
            options.onChange(full);
          }, options.debounceMs()),
        );
      });
      active = true;
      watcher.on("error", (err) => {
        active = false;
        try {
          watcher?.close();
        } catch {
          // Ignore close errors.
        }
        watcher = undefined;
        options.onError?.(err);
        scheduleRetry();
      });
    } catch (err) {
      active = false;
      watcher = undefined;
      options.onError?.(err instanceof Error ? err : new Error(String(err)));
      scheduleRetry();
    }
  };

  tryStart();

  return {
    isActive(): boolean {
      return active;
    },
    stop(): void {
      stopped = true;
      active = false;
      if (retryTimer !== undefined) {
        stopTimer(retryTimer);
        retryTimer = undefined;
      }
      watcher?.close();
      watcher = undefined;
      for (const t of timers.values()) stopTimer(t);
      timers.clear();
    },
  };
}

/** A transcript of a conversation: <project>/<session>.jsonl, nothing deeper (subagents live deeper). */
export function isTopLevelTranscript(relativePath: string): boolean {
  const parts = relativePath.split("/");
  return parts.length === 2 && (parts[1] ?? "").endsWith(".jsonl");
}
