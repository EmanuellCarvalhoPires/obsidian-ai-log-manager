// Keeps the logs of the Gemini (Antigravity) conversations. The source is the SQLite file of each conversation
// (`~/.gemini/<app>/conversations/<id>.db`), read through `ConversationDbPort`, not a JSONL transcript. The note
// format, the checkpoints and the rules (tracked folders, observe mode, deleted notes) are the ones of `LogEngine`;
// the engine calls this class for the paths ending in `.db`.
import { parseAntigravitySteps, LOG_STEP_TYPES, workspaceFromMetadata, workspaceFromUri } from "./antigravity";
import type { Checkpoint, CheckpointStore } from "./checkpoints";
import { TICKET_PREFIXES_NOTE, fileStamp, uniqueNotePath } from "./engine";
import type { SyncOptions, SyncResult } from "./engine";
import { buildEntry, generateEntryTitle, normalizeSessionName } from "./format";
import { appendEntries, buildNoteContent, extractEntitiesFromTurns, parseTicketPrefixes } from "./log-note";
import type { ConversationDbPort, ConversationSummary, DiskPort, LogSettings, ProjectInfo, VaultPort } from "./ports";
import type { ProjectTracker } from "./project-tracker";
import { sanitizeFilename } from "./text-utils";
import type { Turn } from "./transcript";

/** Same limit as the Claude Code transcripts: an unfinished last turn that stopped changing is written anyway. */
const STALE_TURN_MS = 5 * 60_000;

const SUMMARY_TTL_MS = 15_000;

export const GEMINI_AGENT = "gemini";

export interface AntigravityDeps {
  db: ConversationDbPort;
  disk: DiskPort;
  vault: VaultPort;
  tracker: ProjectTracker;
  store: CheckpointStore;
  settings: () => LogSettings;
  /** Absolute folders of the apps (`~/.gemini/antigravity`, `antigravity-cli`...). Each has `conversations/` inside. */
  appFolders: () => string[];
  now?: () => number;
  redact?: (text: string) => string;
  log?: (message: string, detail?: unknown) => void;
}

export interface ConversationRef {
  id: string;
  /** Absolute path of `<id>.db`. */
  path: string;
  mtimeMs: number;
  summary: ConversationSummary | undefined;
}

const norm = (path: string): string => path.replace(/\\/g, "/").replace(/\/+$/, "");
const fileName = (path: string): string => norm(path).split("/").pop() ?? path;

export function isConversationDb(path: string): boolean {
  return path.toLowerCase().endsWith(".db");
}

export class AntigravitySync {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly summaryCache = new Map<string, { at: number; rows: ConversationSummary[] }>();

  constructor(private readonly deps: AntigravityDeps) {}

  private serialize<T>(key: string, job: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.then(job, job);
    const tracked = next
      .catch(() => undefined)
      .finally(() => {
        if (this.queues.get(key) === tracked) this.queues.delete(key);
      });
    this.queues.set(key, tracked);
    return next;
  }

  /** `<id>.db` in the folders of the apps, or undefined. */
  async locate(id: string): Promise<string | undefined> {
    for (const app of this.deps.appFolders()) {
      const candidate = `${norm(app)}/conversations/${id}.db`;
      if (await this.deps.disk.exists(candidate)) return candidate;
    }
    return undefined;
  }

  /**
   * Size and time of a conversation as one signal of change. The database is in WAL mode, so a new step first lands
   * in the `-wal` file and the `.db` itself may stay untouched for a long time.
   */
  async statOf(path: string): Promise<{ size: number; mtimeMs: number } | undefined> {
    const main = await this.deps.disk.stat(path);
    if (!main) return undefined;
    const wal = await this.deps.disk.stat(`${path}-wal`);
    return { size: main.size + (wal?.size ?? 0), mtimeMs: Math.max(main.mtimeMs, wal?.mtimeMs ?? 0) };
  }

  /** Rows of the `conversation_summaries.db` of an app, cached for a few seconds (it is big and every file event asks). */
  private async summaries(appFolder: string): Promise<ConversationSummary[]> {
    const now = (this.deps.now ?? Date.now)();
    const cached = this.summaryCache.get(appFolder);
    if (now > 0 && cached && now - cached.at < SUMMARY_TTL_MS) return cached.rows;
    let rows: ConversationSummary[] = [];
    try {
      rows = await this.deps.db.readSummaries(`${appFolder}/conversation_summaries.db`);
    } catch (err) {
      this.deps.log?.("antigravity summaries failed", { appFolder, detail: err instanceof Error ? err.message : String(err) });
    }
    this.summaryCache.set(appFolder, { at: now, rows });
    return rows;
  }

  /** Every top-level conversation (subagent conversations are skipped), newest first. */
  async list(): Promise<ConversationRef[]> {
    const out: ConversationRef[] = [];
    for (const app of this.deps.appFolders()) {
      const base = norm(app);
      const summaries = await this.summaries(base);
      const byId = new Map(summaries.map((s) => [s.id, s]));
      for (const name of await this.deps.disk.list(`${base}/conversations`)) {
        if (!name.endsWith(".db")) continue;
        const id = name.slice(0, -".db".length);
        const summary = byId.get(id);
        if (summary?.nested) continue;
        const path = `${base}/conversations/${name}`;
        const st = await this.statOf(path);
        if (st) out.push({ id, path, mtimeMs: st.mtimeMs, summary });
      }
    }
    return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  /** Sync by conversation id; undefined when there is no database for it. */
  async syncSession(id: string, options: SyncOptions = {}, knownPath?: string): Promise<SyncResult | undefined> {
    const path = knownPath && isConversationDb(knownPath) ? knownPath : await this.locate(id);
    if (!path) return undefined;
    return this.serialize(id, () => this.run(id, path, options));
  }

  /** Sync by path of the database (what the folder watcher reports). */
  async syncFile(path: string, options: SyncOptions = {}): Promise<SyncResult> {
    const id = fileName(path).replace(/\.db$/, "");
    return this.serialize(id, () => this.run(id, path, options));
  }

  /** Reconciles the conversations changed after the last reconciliation. Does not mark the reconciliation: the engine does. */
  async syncAll(options: { since?: number; force?: boolean; tzOffsetMinutes?: number } = {}): Promise<SyncResult[]> {
    const { store } = this.deps;
    const since = options.since ?? store.lastReconcileMs;
    const now = (this.deps.now ?? Date.now)();
    const refs = await this.list();
    const results: SyncResult[] = [];
    for (const ref of refs) {
      const cp = store.get(ref.id);
      if (cp?.apagadaPeloUsuario) continue;
      const isStale = now - ref.mtimeMs >= STALE_TURN_MS;
      const stalePending = cp?.temTurnoPendente === true && isStale;
      if (!options.force) {
        if (ref.mtimeMs <= since && !cp) continue;
        if (cp && cp.offset > 0 && cp.mtimeMs === ref.mtimeMs && !stalePending) continue;
        if (cp?.ignorada) continue;
      }
      results.push(
        await this.serialize(ref.id, () =>
          this.run(ref.id, ref.path, { force: options.force || stalePending, flush: isStale, tzOffsetMinutes: options.tzOffsetMinutes }, ref.summary),
        ),
      );
    }
    return results;
  }

  // ---------------------------------------------------------------------------

  private async summaryOf(id: string, path: string): Promise<ConversationSummary | undefined> {
    const appFolder = norm(path).replace(/\/conversations\/[^/]+$/, "");
    return (await this.summaries(appFolder)).find((s) => s.id === id);
  }

  /** Workspace folders of a conversation: the index first, the metadata of the database as a fallback. */
  private async workspaces(path: string, summary: ConversationSummary | undefined): Promise<string[]> {
    const fromIndex = (summary?.workspaceUris ?? []).map(workspaceFromUri).filter((w): w is string => w !== undefined);
    if (fromIndex.length > 0) return fromIndex;
    try {
      const own = workspaceFromMetadata(await this.deps.db.readMetadata(path));
      return own ? [own] : [];
    } catch {
      return [];
    }
  }

  private async run(id: string, path: string, options: SyncOptions, knownSummary?: ConversationSummary): Promise<SyncResult> {
    const { vault, tracker, store } = this.deps;
    const settings = this.deps.settings();
    try {
      const stat = await this.statOf(path);
      if (!stat) return { sessao: id, status: "missing", added: 0, detail: "conversation database not found" };
      const known = store.get(id);

      if (known?.apagadaPeloUsuario && !options.title) return { sessao: id, status: "ignored", added: 0, detail: "log note was deleted" };
      if (known?.notaLog && !vault.exists(known.notaLog) && !options.title) {
        if (!vault.findNoteBySession([known.hostSessionId, id].filter(Boolean))) {
          store.set(this.checkpoint(id, known, path, stat, { notaLog: undefined, ignorada: true, apagadaPeloUsuario: true }));
          return { sessao: id, status: "ignored", added: 0, detail: "log note was deleted" };
        }
      }
      if (known?.ignorada && !options.force && !options.flush && !options.title) return { sessao: id, status: "ignored", added: 0 };
      if (!options.force && !options.flush && !options.title && known && known.offset === stat.size && known.mtimeMs === stat.mtimeMs) {
        return { sessao: id, status: "unchanged", added: 0, notaLog: known.notaLog };
      }

      const summary = knownSummary ?? (await this.summaryOf(id, path));
      if (summary?.nested) return { sessao: id, status: "ignored", added: 0, detail: "conversation of a subagent" };

      // The first workspace that is tracked decides (a conversation can have several).
      let decision = await tracker.resolve(undefined);
      for (const workspace of await this.workspaces(path, summary)) {
        decision = await tracker.resolve(workspace);
        if (decision.track) break;
      }
      if (!decision.track) {
        store.set(this.checkpoint(id, known, path, stat, { ignorada: true }));
        return { sessao: id, status: "ignored", added: 0 };
      }

      const steps = await this.deps.db.readSteps(path, LOG_STEP_TYPES);
      const parsed = parseAntigravitySteps(steps, options.tzOffsetMinutes);
      const lastRawTurn = parsed.turns[parsed.turns.length - 1];
      const hasPendingTurn = lastRawTurn !== undefined && !lastRawTurn.complete && !options.flush;
      const turns = parsed.turns.filter((t) => t.complete || options.flush);
      const sessionName = summary?.title && summary.title !== id ? summary.title : "";
      const host = known?.hostSessionId && !known.hostSessionId.startsWith("local_") ? known.hostSessionId : id;

      let notePath = known?.notaLog && vault.exists(known.notaLog) ? known.notaLog : undefined;
      notePath ??= vault.findNoteBySession([host, id]);

      const projectName = options.project ?? known?.projeto ?? decision.project?.name;
      const project = projectName ? await tracker.byName(projectName) : undefined;

      if (turns.length === 0) {
        store.set(
          this.checkpoint(id, known, path, stat, {
            hostSessionId: host,
            notaLog: notePath,
            projeto: projectName,
            temTurnoPendente: hasPendingTurn,
            ...(notePath
              ? {}
              : {
                  tituloPendente: options.title?.trim() || known?.tituloPendente,
                  branchesPendentes: options.branches && options.branches.length > 0 ? options.branches : known?.branchesPendentes,
                }),
          }),
        );
        return { sessao: id, status: "pending", added: 0, notaLog: notePath };
      }
      const lastTurn = turns[turns.length - 1];
      const lastHeading = buildEntry(lastTurn, sessionName, this.deps.redact).heading;
      const lastUtc = lastTurn.date.toISOString();

      if (notePath) {
        const existing = notePath;
        if (settings.mode === "observe") {
          const content = await vault.read(existing);
          const would = appendEntries(content, turns, (i) => buildEntry(turns[i], sessionName, this.deps.redact)).added;
          store.set(this.checkpoint(id, known, path, stat, { hostSessionId: host, notaLog: existing, projeto: projectName, temTurnoPendente: hasPendingTurn }, true));
          return { sessao: id, status: "observed", added: would, notaLog: existing };
        }
        let added = 0;
        await vault.process(existing, (content) => {
          const result = appendEntries(content, turns, (i) => buildEntry(turns[i], sessionName, this.deps.redact));
          added = result.added;
          return result.content;
        });
        if (added > 0) await this.mergeEntities(existing, turns);
        if (known?.jsonlRegistrado !== path) await this.ensureSourceProps(existing, path);
        store.set(
          this.checkpoint(id, known, path, stat, {
            hostSessionId: host,
            notaLog: existing,
            projeto: projectName,
            hashUltimoRegistro: lastHeading,
            ultimoRegistroUtc: lastUtc,
            temTurnoPendente: hasPendingTurn,
            apagadaPeloUsuario: undefined,
            ignorada: false,
            jsonlRegistrado: path,
          }),
        );
        return { sessao: id, status: added > 0 ? "updated" : "unchanged", added, notaLog: existing };
      }

      // The log does not exist yet.
      const chosenTitle = options.title?.trim() || known?.tituloPendente;
      const title = normalizeSessionName(chosenTitle || sessionName || generateEntryTitle(turns[0], ""));
      const branches = options.branches && options.branches.length > 0 ? options.branches : (known?.branchesPendentes ?? []);
      const folder = project ? `${project.folder}/${settings.projectLogsFolder}` : vault.memoryFolder();
      const first = parsed.firstTimestamp ?? turns[0].date;
      const target = uniqueNotePath(vault, `${folder}/${fileStamp(first, options.tzOffsetMinutes)} - ${sanitizeFilename(title)}.md`, id);
      if (settings.mode === "observe") {
        store.set(this.checkpoint(id, known, path, stat, { hostSessionId: host, projeto: projectName, temTurnoPendente: hasPendingTurn }, true));
        return { sessao: id, status: "observed", added: turns.length, detail: `would create ${target}` };
      }
      const entities = await this.entitiesOf(turns);
      const content = buildNoteContent(
        {
          agent: GEMINI_AGENT,
          hostSessionId: host,
          title,
          up: project ? ["Memória Claude", `${project.name} - Logs`] : ["Memória Claude"],
          project: project?.name,
          branches,
          tickets: entities.tickets,
          prs: entities.prs,
          projects: entities.projects,
          jsonl: { name: fileName(path), path },
        },
        turns.map((t) => buildEntry(t, title, this.deps.redact)),
      );
      await vault.create(target, content);
      store.set(
        this.checkpoint(id, known, path, stat, {
          hostSessionId: host,
          notaLog: target,
          projeto: project?.name,
          hashUltimoRegistro: lastHeading,
          ultimoRegistroUtc: lastUtc,
          temTurnoPendente: hasPendingTurn,
          apagadaPeloUsuario: undefined,
          ignorada: false,
          tituloPendente: undefined,
          branchesPendentes: undefined,
          jsonlRegistrado: path,
        }),
      );
      return { sessao: id, status: "created", added: turns.length, notaLog: target };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.deps.log?.("antigravity sync failed", { id, detail });
      return { sessao: id, status: "error", added: 0, detail };
    }
  }

  private async entitiesOf(turns: Turn[]): Promise<{ tickets: string[]; prs: string[]; projects: string[] }> {
    const { vault, tracker } = this.deps;
    let prefixes: Set<string> | undefined;
    try {
      const text = await vault.readNoteByName(TICKET_PREFIXES_NOTE);
      const parsed = text ? parseTicketPrefixes(text) : undefined;
      prefixes = parsed && parsed.size > 0 ? parsed : undefined;
    } catch {
      prefixes = undefined;
    }
    const names = (await tracker.projects()).map((p: ProjectInfo) => p.name);
    return extractEntitiesFromTurns(turns, names, prefixes);
  }

  /** Adds the cited tickets, pull requests and projects to the frontmatter without duplicates. */
  private async mergeEntities(note: string, turns: Turn[]): Promise<void> {
    const entities = await this.entitiesOf(turns);
    if (entities.tickets.length === 0 && entities.prs.length === 0 && entities.projects.length === 0) return;
    const merge = (fm: Record<string, unknown>, key: string, wanted: string[]): void => {
      if (wanted.length === 0) return;
      const current = ([] as unknown[]).concat(fm[key] ?? []).map((v) => String(v));
      const fresh = wanted.filter((w) => !current.includes(w));
      if (fresh.length > 0) fm[key] = [...current, ...fresh];
    };
    await this.deps.vault.updateFrontmatter(note, (fm) => {
      merge(fm, "tickets_citados", entities.tickets);
      merge(fm, "prs_citados", entities.prs);
      merge(
        fm,
        "projetos_citados",
        entities.projects.map((p) => `[[${p}]]`),
      );
    });
  }

  /** Writes `jsonl` (file name) and `jsonl_caminho` (absolute path of the database) in the frontmatter of a log. */
  private async ensureSourceProps(note: string, path: string): Promise<void> {
    try {
      await this.deps.vault.updateFrontmatter(note, (fm) => {
        fm.jsonl = fileName(path);
        fm.jsonl_caminho = path;
      });
    } catch (err) {
      this.deps.log?.("antigravity properties failed", { note, detail: err instanceof Error ? err.message : String(err) });
    }
  }

  private checkpoint(
    id: string,
    known: Checkpoint | undefined,
    path: string,
    stat: { size: number; mtimeMs: number },
    patch: Partial<Checkpoint>,
    /** Observe mode does not write, so the size is not stored and the next run compares again. */
    skipOffset = false,
  ): Checkpoint {
    return {
      sessao: id,
      hostSessionId: known?.hostSessionId || id,
      caminhoTranscript: path,
      offset: skipOffset ? 0 : stat.size,
      mtimeMs: skipOffset ? 0 : stat.mtimeMs,
      hashUltimoRegistro: known?.hashUltimoRegistro ?? "",
      ultimoRegistroUtc: known?.ultimoRegistroUtc,
      temTurnoPendente: known?.temTurnoPendente,
      notaLog: known?.notaLog,
      projeto: known?.projeto,
      ignorada: known?.ignorada,
      apagadaPeloUsuario: known?.apagadaPeloUsuario,
      tituloPendente: known?.tituloPendente,
      branchesPendentes: known?.branchesPendentes,
      jsonlRegistrado: known?.jsonlRegistrado,
      ...patch,
    };
  }
}
