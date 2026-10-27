// The log engine: turns a Claude Code transcript into a conversation log note, incrementally
// and without duplicates. Everything outside (disk, vault, clock) comes through ports.
import { CheckpointStore } from "./checkpoints";
import type { Checkpoint } from "./checkpoints";
import { buildEntry, generateEntryTitle, normalizeSessionName } from "./format";
import { appendEntries, buildNoteContent } from "./log-note";
import type { DiskPort, LogSettings, ProjectInfo, VaultPort } from "./ports";
import { ProjectTracker } from "./project-tracker";
import { SessionLocator } from "./session-locator";
import { sanitizeFilename } from "./text-utils";
import { parseTranscript } from "./transcript";

export type SyncStatus = "created" | "updated" | "unchanged" | "ignored" | "pending" | "observed" | "missing" | "error";

export interface SyncResult {
  sessao: string;
  status: SyncStatus;
  /** Entries written (or that would be written, in observe mode). */
  added: number;
  notaLog?: string;
  detail?: string;
}

export interface SyncOptions {
  /** Also writes the turn the assistant has not finished (used when the session ends). */
  flush?: boolean;
  /** Reads the transcript even if it did not change since the last sync. */
  force?: boolean;
  /** Title chosen by the caller for a log that does not exist yet. */
  title?: string;
  /** Project to link when the log is created. */
  project?: string;
  /** Branch note names to write in the frontmatter when the log is created. */
  branches?: string[];
  tzOffsetMinutes?: number;
}

export interface EngineDeps {
  disk: DiskPort;
  vault: VaultPort;
  locator: SessionLocator;
  tracker: ProjectTracker;
  store: CheckpointStore;
  settings: () => LogSettings;
  agent?: string;
  log?: (message: string, detail?: unknown) => void;
}

const pad = (n: number): string => String(n).padStart(2, "0");

function fileStamp(date: Date, tz?: number): string {
  const d = tz === undefined ? date : new Date(date.getTime() + tz * 60_000);
  const g =
    tz === undefined
      ? [d.getDate(), d.getMonth() + 1, d.getFullYear(), d.getHours(), d.getMinutes()]
      : [d.getUTCDate(), d.getUTCMonth() + 1, d.getUTCFullYear(), d.getUTCHours(), d.getUTCMinutes()];
  return `${pad(g[0])}-${pad(g[1])}-${g[2]} - ${pad(g[3])}h${pad(g[4])}`;
}

export class LogEngine {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly agent: string;

  constructor(private readonly deps: EngineDeps) {
    this.agent = deps.agent ?? "claude";
  }

  /** Runs jobs of one conversation one at a time, so the watcher and a hook never race. */
  private serialize<T>(key: string, job: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.then(job, job);
    this.queues.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  }

  async syncSession(sessionId: string, options: SyncOptions = {}): Promise<SyncResult> {
    return this.serialize(sessionId, async () => {
      const path = this.deps.store.get(sessionId)?.caminhoTranscript || (await this.deps.locator.transcriptPath(sessionId));
      if (!path) return { sessao: sessionId, status: "missing", added: 0, detail: "transcript not found" };
      return this.run(sessionId, path, options);
    });
  }

  async syncTranscript(path: string, options: SyncOptions = {}): Promise<SyncResult> {
    const name = path.replace(/\\/g, "/").split("/").pop() ?? "";
    const sessionId = name.replace(/\.jsonl$/, "");
    return this.serialize(sessionId, () => this.run(sessionId, path, options));
  }

  /** Reconciles every transcript changed after the last reconciliation (decision D2). */
  async syncAll(options: { since?: number; force?: boolean; tzOffsetMinutes?: number } = {}): Promise<SyncResult[]> {
    const since = options.since ?? this.deps.store.lastReconcileMs;
    const results: SyncResult[] = [];
    for (const ref of await this.deps.locator.listTranscripts()) {
      const cp = this.deps.store.get(ref.sessionId);
      if (!options.force) {
        if (ref.mtimeMs <= since && !cp) continue;
        if (cp && cp.offset > 0 && cp.mtimeMs === ref.mtimeMs) continue;
        if (cp?.ignorada) continue;
      }
      results.push(await this.syncTranscript(ref.path, { force: options.force, tzOffsetMinutes: options.tzOffsetMinutes }));
    }
    this.deps.store.markReconciled();
    return results;
  }

  /** Links the log of a conversation to a development project (or remembers it for when the log is created). */
  async linkProject(
    sessionId: string,
    project: ProjectInfo,
    branches: string[] = [],
    transcriptPath?: string,
  ): Promise<{ linked: boolean; notaLog?: string }> {
    return this.serialize(sessionId, async () => {
      const cp = this.deps.store.get(sessionId);
      const logsIndex = `${project.name} - Logs`;
      const note = cp?.notaLog && this.deps.vault.exists(cp.notaLog) ? cp.notaLog : undefined;
      // No log yet: remember the project and the branches so the log is created with them.
      const pending = note ? undefined : [...new Set([...(cp?.branchesPendentes ?? []), ...branches])];
      const withPending = pending && pending.length > 0 ? { branchesPendentes: pending } : {};
      if (cp) this.deps.store.set({ ...cp, projeto: project.name, ...withPending });
      else {
        this.deps.store.set({
          sessao: sessionId,
          hostSessionId: "",
          caminhoTranscript: transcriptPath ?? "",
          offset: 0,
          mtimeMs: 0,
          hashUltimoRegistro: "",
          notaLog: undefined,
          projeto: project.name,
          ...withPending,
        });
      }
      if (!note) return { linked: false };
      await this.deps.vault.updateFrontmatter(note, (fm) => {
        const ups = ([] as unknown[]).concat(fm.up ?? []).map((u) => String(u));
        const wanted = `[[${logsIndex}]]`;
        if (!ups.some((u) => u.replace(/^"|"$/g, "") === wanted)) ups.push(wanted);
        fm.up = ups;
        fm.projeto = `[[${project.name}]]`;
        if (branches.length > 0) {
          const current = ([] as unknown[]).concat(fm.branches ?? []).map((b) => String(b));
          for (const b of branches) if (!current.includes(`[[${b}]]`)) current.push(`[[${b}]]`);
          fm.branches = current;
        }
      });
      return { linked: true, notaLog: note };
    });
  }

  /** Renames a log: the file and its heading (decision D6, "rename later"). */
  async rename(sessionId: string, title: string): Promise<{ notaLog: string }> {
    return this.serialize(sessionId, async () => {
      const cp = this.deps.store.get(sessionId);
      if (!cp?.notaLog || !this.deps.vault.exists(cp.notaLog)) throw new Error("This conversation has no log yet.");
      const name = normalizeSessionName(title);
      const folder = cp.notaLog.includes("/") ? cp.notaLog.slice(0, cp.notaLog.lastIndexOf("/") + 1) : "";
      const file = cp.notaLog.slice(folder.length);
      const stamp = /(\d{2}-\d{2}-\d{4} - \d{2}h\d{2})/.exec(file)?.[1];
      const newPath = `${folder}${stamp ? `${stamp} - ` : ""}${sanitizeFilename(name)}.md`;
      await this.deps.vault.process(cp.notaLog, (content) => content.replace(/^# .*$/m, `# ${name}`));
      if (newPath !== cp.notaLog) await this.deps.vault.rename(cp.notaLog, newPath);
      this.deps.store.set({ ...cp, notaLog: newPath });
      return { notaLog: newPath };
    });
  }

  // ---------------------------------------------------------------------------

  private async run(sessionId: string, path: string, options: SyncOptions): Promise<SyncResult> {
    const { disk, vault, locator, tracker, store } = this.deps;
    const settings = this.deps.settings();
    try {
      const stat = await disk.stat(path);
      if (!stat) return { sessao: sessionId, status: "missing", added: 0, detail: "transcript not found" };
      const known = store.get(sessionId);
      if (known?.ignorada && !options.force && !options.flush) return { sessao: sessionId, status: "ignored", added: 0 };
      if (!options.force && !options.flush && known && known.offset === stat.size && known.mtimeMs === stat.mtimeMs) {
        return { sessao: sessionId, status: "unchanged", added: 0, notaLog: known.notaLog };
      }

      const parsed = parseTranscript(await disk.readText(path), options.tzOffsetMinutes);
      const decision = await tracker.resolve(parsed.cwd);
      if (!decision.track) {
        store.set(this.checkpoint(sessionId, known, path, stat, { ignorada: true }));
        return { sessao: sessionId, status: "ignored", added: 0 };
      }

      const turns = parsed.turns.filter((t) => t.complete || options.flush);
      const meta = await locator.meta(sessionId);
      const host = known?.hostSessionId || meta?.hostSessionId || `local_${sessionId}`;
      const sessionName = meta?.nameSource === "user" && meta.name ? meta.name : (parsed.customTitle ?? "");

      let notePath = known?.notaLog && vault.exists(known.notaLog) ? known.notaLog : undefined;
      notePath ??= vault.findNoteBySession([host, `local_${sessionId}`, sessionId]);

      const projectName = options.project ?? known?.projeto ?? decision.project?.name;
      const project = projectName ? await tracker.byName(projectName) : undefined;

      if (turns.length === 0) {
        store.set(
          this.checkpoint(sessionId, known, path, stat, {
            hostSessionId: host,
            notaLog: notePath,
            projeto: projectName,
            // No log yet: remember what logs_set chose so the log is created with it.
            ...(notePath
              ? {}
              : {
                  tituloPendente: options.title?.trim() || known?.tituloPendente,
                  branchesPendentes: options.branches && options.branches.length > 0 ? options.branches : known?.branchesPendentes,
                }),
          }),
        );
        return { sessao: sessionId, status: "pending", added: 0, notaLog: notePath };
      }
      const lastHeading = (): string => buildEntry(turns[turns.length - 1], sessionName).heading;

      if (notePath) {
        const existing = notePath;
        if (settings.mode === "observe") {
          const content = await vault.read(existing);
          const would = appendEntries(content, turns, (i) => buildEntry(turns[i], sessionName)).added;
          store.set(this.checkpoint(sessionId, known, path, stat, { hostSessionId: host, notaLog: existing, projeto: projectName }, true));
          return { sessao: sessionId, status: "observed", added: would, notaLog: existing };
        }
        let added = 0;
        await vault.process(existing, (content) => {
          const result = appendEntries(content, turns, (i) => buildEntry(turns[i], sessionName));
          added = result.added;
          return result.content;
        });
        store.set(
          this.checkpoint(sessionId, known, path, stat, {
            hostSessionId: host,
            notaLog: existing,
            projeto: projectName,
            hashUltimoRegistro: lastHeading(),
          }),
        );
        return { sessao: sessionId, status: added > 0 ? "updated" : "unchanged", added, notaLog: existing };
      }

      // The log does not exist yet.
      const chosenTitle = options.title?.trim() || known?.tituloPendente;
      const title = normalizeSessionName(chosenTitle || sessionName || generateEntryTitle(turns[0], parsed.customTitle ?? ""));
      const branches = options.branches && options.branches.length > 0 ? options.branches : (known?.branchesPendentes ?? []);
      const folder = project ? `${project.folder}/${settings.projectLogsFolder}` : vault.memoryFolder();
      const first = parsed.firstTimestamp ?? turns[0].date;
      const target = `${folder}/${fileStamp(first, options.tzOffsetMinutes)} - ${sanitizeFilename(title)}.md`;
      if (settings.mode === "observe") {
        store.set(this.checkpoint(sessionId, known, path, stat, { hostSessionId: host, projeto: projectName }, true));
        return { sessao: sessionId, status: "observed", added: turns.length, detail: `would create ${target}` };
      }
      const up = project ? ["Memória Claude", `${project.name} - Logs`] : ["Memória Claude"];
      const content = buildNoteContent(
        { agent: this.agent, hostSessionId: host, title, up, project: project?.name, branches },
        turns.map((t) => buildEntry(t, title)),
      );
      await vault.create(target, content);
      store.set(
        this.checkpoint(sessionId, known, path, stat, {
          hostSessionId: host,
          notaLog: target,
          projeto: project?.name,
          hashUltimoRegistro: lastHeading(),
          tituloPendente: undefined,
          branchesPendentes: undefined,
        }),
      );
      return { sessao: sessionId, status: "created", added: turns.length, notaLog: target };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.deps.log?.("sync failed", { sessionId, detail });
      return { sessao: sessionId, status: "error", added: 0, detail };
    }
  }

  private checkpoint(
    sessionId: string,
    known: Checkpoint | undefined,
    path: string,
    stat: { size: number; mtimeMs: number },
    patch: Partial<Checkpoint>,
    /** Observe mode does not write, so the size is not stored and the next run compares again. */
    skipOffset = false,
  ): Checkpoint {
    return {
      sessao: sessionId,
      hostSessionId: known?.hostSessionId || `local_${sessionId}`,
      caminhoTranscript: path,
      offset: skipOffset ? 0 : stat.size,
      mtimeMs: skipOffset ? 0 : stat.mtimeMs,
      hashUltimoRegistro: known?.hashUltimoRegistro ?? "",
      notaLog: known?.notaLog,
      projeto: known?.projeto,
      tituloPendente: known?.tituloPendente,
      branchesPendentes: known?.branchesPendentes,
      ...patch,
    };
  }
}
