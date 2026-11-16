// Registers the hook script in the Claude Code settings (settings.json), with safe atomic writes,
// timestamped backups, Node availability checks and spool draining (LM-01, LM-13, LM-17, LM-19).
import { execFile } from "node:child_process";
import * as nodeFs from "node:fs/promises";
import * as path from "node:path";
import { HookHandler } from "../core/hook-handler";
import type { HookEvent } from "../core/hook-handler";
import { stripBom } from "../core/text-utils";

export const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"] as const;

const SCRIPT_MARK = "ai-log-manager-hook.mjs";
const MAX_BACKUPS = 5;

/** Events an older version registered (repository commands); the next install removes this plugin's entry. */
const LEGACY_EVENTS = ["PostToolUse"] as const;

/** Maximum age of any spool event before it is discarded without processing (3 days, LM-13). */
export const MAX_SPOOL_AGE_MS = 3 * 24 * 60 * 60_000;

/** Maximum age of a SessionStart event before it is ignored so an old session does not prompt days later (10 min, LM-13). */
export const MAX_SESSION_START_AGE_MS = 10 * 60_000;

/** Removes the entries of this plugin (same command) from one event; returns whether something was removed. */
function stripOwn(next: ClaudeSettings, event: string, command: string): boolean {
  const current = next.hooks?.[event] ?? [];
  const before = current.reduce((n, g) => n + (g.hooks?.length ?? 0), 0);
  const groups = current
    .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => h.command !== command && !isOurs(h)) }))
    .filter((g) => g.hooks.length > 0);
  const after = groups.reduce((n, g) => n + g.hooks.length, 0);
  if (groups.length > 0) next.hooks![event] = groups;
  else delete next.hooks![event];
  return after !== before;
}

interface HookCommand {
  type: string;
  command?: string;
  timeout?: number;
}

interface HookGroup {
  matcher?: string;
  hooks?: HookCommand[];
}

export type ClaudeSettings = Record<string, unknown> & { hooks?: Record<string, HookGroup[]> };

/** Command that runs the script; forward slashes work on Windows too. */
export function hookCommand(scriptPath: string): string {
  return `node "${scriptPath.replace(/\\/g, "/")}"`;
}

function isOurs(entry: HookCommand): boolean {
  return typeof entry.command === "string" && entry.command.includes(SCRIPT_MARK);
}

export function installedEvents(settings: ClaudeSettings, scriptPath?: string): string[] {
  const wanted = scriptPath ? hookCommand(scriptPath) : undefined;
  return HOOK_EVENTS.filter((event) =>
    (settings.hooks?.[event] ?? []).some((g) => (g.hooks ?? []).some((h) => isOurs(h) && (!wanted || h.command === wanted))),
  );
}

export function hooksInstalled(settings: ClaudeSettings, scriptPath: string): boolean {
  return installedEvents(settings, scriptPath).length === HOOK_EVENTS.length;
}

/**
 * Adds the four events. An older entry of this plugin (another vault, an old path) for the same
 * script path is replaced; entries of other tools are never touched.
 */
export function mergeHooks(settings: ClaudeSettings, scriptPath: string): { settings: ClaudeSettings; changed: boolean } {
  const command = hookCommand(scriptPath);
  const next: ClaudeSettings = { ...settings, hooks: { ...(settings.hooks ?? {}) } };
  let changed = false;
  for (const event of HOOK_EVENTS) {
    const groups = (next.hooks?.[event] ?? []).map((g) => ({ ...g, hooks: [...(g.hooks ?? [])] }));
    const present = groups.some((g) => g.hooks.some((h) => h.command === command));
    if (!present) {
      groups.push({ hooks: [{ type: "command", command, timeout: 10 }] });
      changed = true;
    }
    next.hooks![event] = groups;
  }
  for (const event of LEGACY_EVENTS) if (stripOwn(next, event, command)) changed = true;
  return { settings: next, changed };
}

/** Removes the entries of this plugin for the given script path (uninstall). */
export function removeHooks(settings: ClaudeSettings, scriptPath: string): { settings: ClaudeSettings; changed: boolean } {
  const command = hookCommand(scriptPath);
  const next: ClaudeSettings = { ...settings, hooks: { ...(settings.hooks ?? {}) } };
  let changed = false;
  for (const event of [...HOOK_EVENTS, ...LEGACY_EVENTS]) if (stripOwn(next, event, command)) changed = true;
  return { settings: next, changed };
}

function isPlainObject(v: unknown): v is ClaudeSettings {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function detectIndent(raw: string | undefined): string | number {
  if (!raw) return 2;
  const match = /^([ \t]+)"/m.exec(raw);
  const indent = match?.[1];
  if (!indent) return 2;
  return indent.includes("\t") ? "\t" : indent.length;
}

let backupSeq = 0;

function backupStamp(nowMs = Date.now()): string {
  const time = new Date(nowMs).toISOString().replace(/\D/g, "");
  backupSeq = (backupSeq + 1) % 1000;
  return `${time}-${String(backupSeq).padStart(3, "0")}`;
}

/**
 * Reads `settings.json` safely (LM-01):
 * - Missing file (`ENOENT`) or empty file returns `{ settings: {}, raw: undefined }`.
 * - Invalid JSON, non-object JSON or any read/permission error throws so the caller never overwrites the user's file.
 */
export async function readClaudeSettingsSafe(settingsPath: string): Promise<{ settings: ClaudeSettings; raw: string | undefined }> {
  let raw: string;
  try {
    raw = await nodeFs.readFile(settingsPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { settings: {}, raw: undefined };
    throw new Error(`Could not read ${settingsPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const clean = stripBom(raw);
  if (clean.trim() === "") return { settings: {}, raw };
  let parsed: unknown;
  try {
    parsed = JSON.parse(clean);
  } catch (err) {
    throw new Error(`${settingsPath} is not valid JSON and was left untouched (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`${settingsPath} does not hold a JSON object and was left untouched`);
  }
  return { settings: parsed, raw };
}

/**
 * Installs the plugin's hooks into `settings.json` safely (LM-01):
 * - Refuses to overwrite an unreadable or malformed `settings.json`.
 * - Keeps up to 5 timestamped backups (`settings.json.<stamp>.ai-log-manager.bak`) instead of overwriting a single backup.
 * - Writes atomically via a temporary file + rename, and reads the file back to verify the hooks are present.
 */
export async function applyClaudeHooksSafe(settingsPath: string, scriptPath: string, nowMs = Date.now()): Promise<{ changed: boolean }> {
  const { settings, raw } = await readClaudeSettingsSafe(settingsPath);
  const merged = mergeHooks(settings, scriptPath);
  if (!merged.changed && raw !== undefined) return { changed: false };

  const dir = path.dirname(settingsPath);
  await nodeFs.mkdir(dir, { recursive: true });

  if (raw !== undefined && raw.trim() !== "") {
    const base = path.basename(settingsPath);
    const bakName = `${base}.${backupStamp(nowMs)}.ai-log-manager.bak`;
    await nodeFs.writeFile(path.join(dir, bakName), raw, "utf8");
    await pruneBackups(dir, base);
  }

  const text = `${JSON.stringify(merged.settings, null, detectIndent(raw))}\n`;
  const tmp = `${settingsPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await nodeFs.writeFile(tmp, text, "utf8");
    await nodeFs.rename(tmp, settingsPath);
  } catch (err) {
    await nodeFs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }

  const verified = await readClaudeSettingsSafe(settingsPath);
  if (!hooksInstalled(verified.settings, scriptPath)) {
    throw new Error(`Hooks verification failed after writing ${settingsPath}`);
  }
  return { changed: true };
}

async function pruneBackups(dir: string, baseName: string): Promise<void> {
  try {
    const suffix = ".ai-log-manager.bak";
    const prefix = `${baseName}.`;
    const entries = (await nodeFs.readdir(dir))
      .filter((n) => n.startsWith(prefix) && n.endsWith(suffix) && n !== `${baseName}${suffix}`)
      .sort();
    while (entries.length > MAX_BACKUPS) {
      const oldest = entries.shift()!;
      await nodeFs.rm(path.join(dir, oldest), { force: true }).catch(() => undefined);
    }
  } catch {
    // Non-fatal backup pruning error.
  }
}

/** Checks whether `node` is available in PATH so the settings screen can warn when it is missing (LM-17). */
export function checkNodeInPath(timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      execFile("node", ["--version"], { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
        resolve(!err && typeof stdout === "string" && stdout.trim().startsWith("v"));
      });
    } catch {
      resolve(false);
    }
  });
}

/**
 * Reads and deletes hook spool files one pass at a time, discarding expired events and ignoring stale
 * `SessionStart` events so an old session does not open the "new project?" modal days later (LM-13).
 */
export class SpoolDrainer {
  private running: Promise<number> | undefined;
  private rerun = false;

  constructor(
    private readonly spoolDir: () => string,
    private readonly handleEvent: (event: HookEvent) => Promise<unknown>,
    private readonly now: () => number = Date.now,
    private readonly onError?: (name: string, err: unknown) => void,
  ) {}

  async drain(): Promise<number> {
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = this.drainLoop().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async drainLoop(): Promise<number> {
    let total = 0;
    do {
      this.rerun = false;
      total += await this.drainOnce();
    } while (this.rerun);
    return total;
  }

  private async drainOnce(): Promise<number> {
    const dir = this.spoolDir();
    let names: string[];
    try {
      names = (await nodeFs.readdir(dir)).filter((n) => n.endsWith(".json")).sort();
    } catch {
      return 0;
    }
    let processed = 0;
    const now = this.now();
    for (const name of names) {
      const file = `${dir}/${name}`;
      try {
        const st = await nodeFs.stat(file).catch(() => undefined);
        const rawText = await nodeFs.readFile(file, "utf8");
        await nodeFs.rm(file, { force: true });
        const event = HookHandler.parse(JSON.parse(rawText));
        if (!event) continue;
        const eventTime = event.recebido_em ?? st?.mtimeMs ?? now;
        const ageMs = Math.max(0, now - eventTime);
        if (ageMs > MAX_SPOOL_AGE_MS) continue;
        if (event.evento === "SessionStart" && ageMs > MAX_SESSION_START_AGE_MS) continue;
        await this.handleEvent(event);
        processed++;
      } catch (err) {
        this.onError?.(name, err);
        await nodeFs.rm(file, { force: true }).catch(() => undefined);
      }
    }
    return processed;
  }
}
