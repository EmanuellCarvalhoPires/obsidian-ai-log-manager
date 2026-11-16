// The log engine: turns a Claude Code transcript into a conversation log note, incrementally
// and without duplicates. Everything outside (disk, vault, clock) comes through ports.
import { CheckpointStore } from "./checkpoints";
import type { Checkpoint } from "./checkpoints";
import { buildEntry, generateEntryTitle, normalizeSessionName } from "./format";
import { addLogLink, kanbanCardsFolder, ticketKeysInRequests } from "./kanban-link";
import { appendEntries, appendFacts, buildNoteContent, extractEntitiesFromTurns, parseTicketPrefixes } from "./log-note";
import type { Entities } from "./log-note";
import type { DiskPort, LogSettings, ProjectInfo, VaultPort } from "./ports";
import { ProjectTracker } from "./project-tracker";
import { SessionLocator } from "./session-locator";
import { sanitizeFilename } from "./text-utils";
import { appendTranscriptChunk, createIncrementalState, forkParentOf, parseTranscript } from "./transcript";
import type { IncrementalTranscriptState, ParsedTranscript, Turn } from "./transcript";

/** Note of the vault that lists the real Jira project prefixes (used to validate cited tickets). */
export const TICKET_PREFIXES_NOTE = "Prefixos de Projetos Jira";
const PREFIXES_TTL_MS = 60_000;

/** An unfinished last turn whose transcript has not changed for this long is flushed on reconciliation (LM-05). */
export const STALE_TURN_MS = 5 * 60_000;

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
  /** Also writes the turn the assistant has not finished (used when the session ends or is stale). */
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

/** The part of `AntigravitySync` (Gemini conversation databases) the engine calls: `.db` paths are not JSONL transcripts. */
export interface ConversationDbSync {
  syncSession(id: string, options?: SyncOptions, knownPath?: string): Promise<SyncResult | undefined>;
  syncAll(options?: { since?: number; force?: boolean; tzOffsetMinutes?: number }): Promise<SyncResult[]>;
}

export interface EngineDeps {
  /** Gemini (Antigravity) conversations, read from their SQLite database instead of a JSONL transcript. */
  antigravity?: ConversationDbSync;
  disk: DiskPort;
  vault: VaultPort;
  locator: SessionLocator;
  tracker: ProjectTracker;
  store: CheckpointStore;
  settings: () => LogSettings;
  agent?: string;
  log?: (message: string, detail?: unknown) => void;
  /** Clock in epoch ms (facts get a timestamp); defaults to Date.now. */
  now?: () => number;
  /** Optional secret redactor from the AI Ecosystem / Environment Keys service (LM-03). */
  redact?: (text: string) => string;
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** Longest request text written to the log of a subagent. */
const SUBAGENT_PROMPT_LIMIT = 1500;

/** "abc.jsonl" from "C:/home/.claude/projects/p/abc.jsonl". */
function transcriptFileName(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() ?? path;
}

export function fileStamp(date: Date, tz?: number): string {
  const d = tz === undefined ? date : new Date(date.getTime() + tz * 60_000);
  const g =
    tz === undefined
      ? [d.getDate(), d.getMonth() + 1, d.getFullYear(), d.getHours(), d.getMinutes()]
      : [d.getUTCDate(), d.getUTCMonth() + 1, d.getUTCFullYear(), d.getUTCHours(), d.getUTCMinutes()];
  return `${pad(g[0])}-${pad(g[1])}-${g[2]} - ${pad(g[3])}h${pad(g[4])}`;
}

/** Picks a unique `.md` path when another conversation already used the same timestamp and title (LM-04). */
export function uniqueNotePath(vault: VaultPort, desiredPath: string, sessionId: string, currentPath?: string): string {
  if (desiredPath === currentPath || !vault.exists(desiredPath)) return desiredPath;
  const base = desiredPath.replace(/\.md$/, "");
  const shortSuffix = `${base} (${sessionId.slice(0, 6)}).md`;
  if (shortSuffix === currentPath || !vault.exists(shortSuffix)) return shortSuffix;
  const fullSuffix = `${base} (${sessionId}).md`;
  if (fullSuffix === currentPath || !vault.exists(fullSuffix)) return fullSuffix;
  let counter = 2;
  while (vault.exists(`${base} (${sessionId.slice(0, 6)}-${counter}).md`)) counter++;
  return `${base} (${sessionId.slice(0, 6)}-${counter}).md`;
}

interface CachedTranscript {
  path: string;
  offset: number;
  tzOffsetMinutes: number | undefined;
  state: IncrementalTranscriptState;
  parsed: ParsedTranscript;
}

export class LogEngine {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly transcriptCache = new Map<string, CachedTranscript>();
  private readonly agent: string;
  private prefixCache: { at: number; prefixes: Set<string> | undefined } | undefined;

  constructor(private readonly deps: EngineDeps) {
    this.agent = deps.agent ?? "claude";
  }

  /** Runs jobs of one conversation one at a time, so the watcher and a hook never race, and cleans up the map (LM-15). */
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

  /** Marks a session as ignored when the user deletes its log note in the vault (LM-18). */
  onNoteDeleted(notePath: string): void {
    for (const cp of this.deps.store.all()) {
      if (cp.notaLog === notePath) {
        this.deps.store.set({ ...cp, notaLog: undefined, ignorada: true, apagadaPeloUsuario: true });
      }
    }
  }

  async syncSession(sessionId: string, options: SyncOptions = {}): Promise<SyncResult> {
    return this.serialize(sessionId, async () => {
      const path = this.deps.store.get(sessionId)?.caminhoTranscript || (await this.deps.locator.transcriptPath(sessionId));
      // A Gemini conversation is a `.db` file (or has no Claude Code transcript at all).
      if (!path || path.toLowerCase().endsWith(".db")) {
        const gemini = await this.deps.antigravity?.syncSession(sessionId, options, path || undefined);
        if (gemini) return gemini;
        return { sessao: sessionId, status: "missing", added: 0, detail: "transcript not found" };
      }
      return this.run(sessionId, path, options);
    });
  }

  async syncTranscript(path: string, options: SyncOptions = {}): Promise<SyncResult> {
    const name = path.replace(/\\/g, "/").split("/").pop() ?? "";
    const sessionId = name.replace(/\.jsonl$/, "");
    return this.serialize(sessionId, () => this.run(sessionId, path, options));
  }

  /** Reconciles every transcript changed after the last reconciliation (decision D2, LM-05, LM-15, LM-18). */
  async syncAll(options: { since?: number; force?: boolean; tzOffsetMinutes?: number } = {}): Promise<SyncResult[]> {
    const since = options.since ?? this.deps.store.lastReconcileMs;
    const now = (this.deps.now ?? Date.now)();
    const transcripts = await this.deps.locator.listTranscripts();
    const existingPaths = new Set(transcripts.map((t) => t.path));
    this.deps.store.pruneMissingTranscripts(existingPaths);
    for (const key of this.transcriptCache.keys()) {
      const cached = this.transcriptCache.get(key);
      if (cached && !existingPaths.has(cached.path)) this.transcriptCache.delete(key);
    }

    const results: SyncResult[] = [];
    for (const ref of transcripts) {
      const cp = this.deps.store.get(ref.sessionId);
      if (cp?.apagadaPeloUsuario) continue;
      const isStale = now - ref.mtimeMs >= STALE_TURN_MS;
      const stalePending = cp?.temTurnoPendente === true && isStale;
      if (!options.force) {
        if (ref.mtimeMs <= since && !cp) continue;
        const needsJsonlProps = cp?.notaLog !== undefined && cp.jsonlRegistrado !== ref.path && !cp.ignorada;
        if (cp && cp.offset > 0 && cp.mtimeMs === ref.mtimeMs && !needsJsonlProps && !stalePending) continue;
        if (cp?.ignorada) continue;
      }
      results.push(
        await this.syncTranscript(ref.path, {
          force: options.force || stalePending,
          flush: isStale,
          tzOffsetMinutes: options.tzOffsetMinutes,
        }),
      );
    }
    if (this.deps.antigravity) {
      try {
        results.push(...(await this.deps.antigravity.syncAll(options)));
      } catch (err) {
        this.deps.log?.("antigravity reconciliation failed", err instanceof Error ? err.message : String(err));
      }
    }
    this.deps.store.markReconciled();
    return results;
  }

  /**
   * Writes facts in the "Decisões e Fatos da Sessão" section of the log (created between the Sumário and the `---`).
   * Runs in the queue of the conversation, so it never races with the watcher.
   */
  async addFacts(sessionId: string, facts: string[]): Promise<{ updated: boolean; notaLog?: string; added: number }> {
    return this.serialize(sessionId, async () => {
      const note = this.deps.store.get(sessionId)?.notaLog;
      if (!note || !this.deps.vault.exists(note)) throw new Error("This conversation has no log yet. Use logs_update first.");
      const stamp = this.factStamp();
      let added = 0;
      await this.deps.vault.process(note, (content) => {
        const result = appendFacts(content, facts, stamp, this.deps.redact);
        added = result.added;
        return result.content;
      });
      return { updated: added > 0, notaLog: note, added };
    });
  }

  /** dd/MM/yyyy HH:mm in the local time zone. */
  private factStamp(): string {
    const d = new Date((this.deps.now ?? Date.now)());
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  /** Real Jira prefixes from the vault note (cached); undefined when the note is missing, so the regex fallback applies. */
  private async ticketPrefixes(): Promise<Set<string> | undefined> {
    const now = (this.deps.now ?? Date.now)();
    if (this.prefixCache && now - this.prefixCache.at < PREFIXES_TTL_MS) return this.prefixCache.prefixes;
    let prefixes: Set<string> | undefined;
    try {
      const text = await this.deps.vault.readNoteByName(TICKET_PREFIXES_NOTE);
      const parsed = text ? parseTicketPrefixes(text) : undefined;
      prefixes = parsed && parsed.size > 0 ? parsed : undefined;
    } catch {
      prefixes = undefined;
    }
    this.prefixCache = { at: now, prefixes };
    return prefixes;
  }

  private async entitiesOf(turns: Turn[]): Promise<Entities> {
    if (turns.length === 0) return { tickets: [], prs: [], projects: [] };
    const names = (await this.deps.tracker.projects()).map((p) => p.name);
    return extractEntitiesFromTurns(turns, names, await this.ticketPrefixes());
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

  /** Renames a log: the file and its heading (decision D6, "rename later", LM-04, LM-12). */
  async rename(sessionId: string, title: string): Promise<{ notaLog: string }> {
    return this.serialize(sessionId, async () => {
      const cp = this.deps.store.get(sessionId);
      if (!cp?.notaLog || !this.deps.vault.exists(cp.notaLog)) throw new Error("This conversation has no log yet.");
      const name = normalizeSessionName(title);
      const folder = cp.notaLog.includes("/") ? cp.notaLog.slice(0, cp.notaLog.lastIndexOf("/") + 1) : "";
      const file = cp.notaLog.slice(folder.length);
      const stamp = /(\d{2}-\d{2}-\d{4} - \d{2}h\d{2})/.exec(file)?.[1];
      const desired = `${folder}${stamp ? `${stamp} - ` : ""}${sanitizeFilename(name)}.md`;
      const newPath = uniqueNotePath(this.deps.vault, desired, sessionId, cp.notaLog);
      await this.deps.vault.process(cp.notaLog, (content) => content.replace(/^# .*$/m, () => `# ${name}`));
      if (newPath !== cp.notaLog) await this.deps.vault.rename(cp.notaLog, newPath);
      this.deps.store.set({ ...cp, notaLog: newPath });
      return { notaLog: newPath };
    });
  }

  // ---------------------------------------------------------------------------

  /** Reads only the bytes added after the last cached offset when possible (LM-07). */
  private async readIncremental(sessionId: string, path: string, size: number, tzOffsetMinutes?: number): Promise<ParsedTranscript> {
    const { disk } = this.deps;
    const cached = this.transcriptCache.get(sessionId);
    if (cached && cached.path === path && cached.tzOffsetMinutes === tzOffsetMinutes && size >= cached.offset && disk.readFrom) {
      if (size === cached.offset) return cached.parsed;
      const chunk = await disk.readFrom(path, cached.offset);
      const lastNewline = chunk.lastIndexOf("\n");
      if (lastNewline >= 0) {
        const completePart = chunk.slice(0, lastNewline + 1);
        const consumedBytes = Buffer.byteLength(completePart, "utf8");
        const parsed = appendTranscriptChunk(cached.state, completePart, tzOffsetMinutes);
        this.transcriptCache.set(sessionId, {
          path,
          offset: cached.offset + consumedBytes,
          tzOffsetMinutes,
          state: cached.state,
          parsed,
        });
        return parsed;
      }
      // Single line without trailing newline: parse a copy without advancing the committed offset.
      const parsed = appendTranscriptChunk(cached.state, chunk, tzOffsetMinutes);
      this.transcriptCache.set(sessionId, { path, offset: size, tzOffsetMinutes, state: cached.state, parsed });
      return parsed;
    }

    const fullText = await disk.readText(path);
    const state = createIncrementalState();
    const parsed = appendTranscriptChunk(state, fullText, tzOffsetMinutes);
    this.transcriptCache.set(sessionId, { path, offset: size, tzOffsetMinutes, state, parsed });
    return parsed;
  }

  private async run(sessionId: string, path: string, options: SyncOptions): Promise<SyncResult> {
    const { disk, vault, locator, tracker, store } = this.deps;
    const settings = this.deps.settings();
    try {
      const stat = await disk.stat(path);
      if (!stat) return { sessao: sessionId, status: "missing", added: 0, detail: "transcript not found" };
      const known = store.get(sessionId);

      // LM-18: if the user deleted the log note, mark as ignored unless explicitly recreating via logs_set (title).
      if (known?.apagadaPeloUsuario && !options.title) {
        return { sessao: sessionId, status: "ignored", added: 0, detail: "log note was deleted" };
      }
      if (known?.notaLog && !vault.exists(known.notaLog) && !options.title) {
        const moved = vault.findNoteBySession([known.hostSessionId, `local_${sessionId}`, sessionId].filter(Boolean));
        if (!moved) {
          store.set(this.checkpoint(sessionId, known, path, stat, { notaLog: undefined, ignorada: true, apagadaPeloUsuario: true }));
          return { sessao: sessionId, status: "ignored", added: 0, detail: "log note was deleted" };
        }
      }

      if (known?.ignorada && !options.force && !options.flush && !options.title) return { sessao: sessionId, status: "ignored", added: 0 };
      if (!options.force && !options.flush && !options.title && known && known.offset === stat.size && known.mtimeMs === stat.mtimeMs) {
        // Nothing new to write, but logs made before the `jsonl` properties existed get them now (once).
        if (settings.mode === "active" && known.notaLog && vault.exists(known.notaLog) && known.jsonlRegistrado !== path) {
          await this.ensureJsonlProps(known.notaLog, path);
          store.set({ ...known, jsonlRegistrado: path });
        }
        return { sessao: sessionId, status: "unchanged", added: 0, notaLog: known.notaLog };
      }

      const parsed = await this.readIncremental(sessionId, path, stat.size, options.tzOffsetMinutes);
      const decision = await tracker.resolve(parsed.cwd);
      if (!decision.track) {
        store.set(this.checkpoint(sessionId, known, path, stat, { ignorada: true }));
        return { sessao: sessionId, status: "ignored", added: 0 };
      }

      // KAN-10: a fork is a copy of another conversation; its log is listed under the log of that conversation.
      const forkParent = forkParentOf(parsed.sessionIds, sessionId);
      const lastRawTurn = parsed.turns[parsed.turns.length - 1];
      const hasPendingTurn = lastRawTurn !== undefined && !lastRawTurn.complete && !options.flush;
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
            temTurnoPendente: hasPendingTurn,
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
      const lastTurn = turns[turns.length - 1];
      const lastHeading = (): string => buildEntry(lastTurn, sessionName, this.deps.redact).heading;
      const lastUtc = lastTurn.date.toISOString();

      if (notePath) {
        const existing = notePath;
        if (settings.mode === "observe") {
          const content = await vault.read(existing);
          const would = appendEntries(content, turns, (i) => buildEntry(turns[i], sessionName, this.deps.redact)).added;
          store.set(
            this.checkpoint(sessionId, known, path, stat, { hostSessionId: host, notaLog: existing, projeto: projectName, temTurnoPendente: hasPendingTurn }, true),
          );
          return { sessao: sessionId, status: "observed", added: would, notaLog: existing };
        }
        let added = 0;
        await vault.process(existing, (content) => {
          const result = appendEntries(content, turns, (i) => buildEntry(turns[i], sessionName, this.deps.redact));
          added = result.added;
          return result.content;
        });
        if (added > 0) await this.mergeEntities(existing, await this.entitiesOf(turns));
        if (added > 0) await this.linkKanbanCards(existing, turns, project);
        if (known?.jsonlRegistrado !== path) await this.ensureJsonlProps(existing, path);
        if (forkParent && known?.forkRegistrado !== forkParent) await this.ensureForkProps(existing, forkParent);
        store.set(
          this.checkpoint(sessionId, known, path, stat, {
            hostSessionId: host,
            notaLog: existing,
            projeto: projectName,
            hashUltimoRegistro: lastHeading(),
            ultimoRegistroUtc: lastUtc,
            temTurnoPendente: hasPendingTurn,
            apagadaPeloUsuario: undefined,
            ignorada: false,
            jsonlRegistrado: path,
            forkRegistrado: forkParent ?? known?.forkRegistrado,
          }),
        );
        await this.syncSubagents(sessionId, path, existing, project?.name, options.tzOffsetMinutes);
        return { sessao: sessionId, status: added > 0 ? "updated" : "unchanged", added, notaLog: existing };
      }

      // The log does not exist yet.
      const chosenTitle = options.title?.trim() || known?.tituloPendente;
      const title = normalizeSessionName(chosenTitle || sessionName || generateEntryTitle(turns[0], parsed.customTitle ?? ""));
      const branches = options.branches && options.branches.length > 0 ? options.branches : (known?.branchesPendentes ?? []);
      const folder = project ? `${project.folder}/${settings.projectLogsFolder}` : vault.memoryFolder();
      const first = parsed.firstTimestamp ?? turns[0].date;
      const desiredTarget = `${folder}/${fileStamp(first, options.tzOffsetMinutes)} - ${sanitizeFilename(title)}.md`;
      const target = uniqueNotePath(vault, desiredTarget, sessionId);
      if (settings.mode === "observe") {
        store.set(this.checkpoint(sessionId, known, path, stat, { hostSessionId: host, projeto: projectName, temTurnoPendente: hasPendingTurn }, true));
        return { sessao: sessionId, status: "observed", added: turns.length, detail: `would create ${target}` };
      }
      const up = project ? ["Memória Claude", `${project.name} - Logs`] : ["Memória Claude"];
      const entities = await this.entitiesOf(turns);
      const content = buildNoteContent(
        {
          agent: this.agent,
          hostSessionId: host,
          title,
          up,
          project: project?.name,
          branches,
          tickets: entities.tickets,
          prs: entities.prs,
          projects: entities.projects,
          jsonl: { name: transcriptFileName(path), path },
          ...(forkParent ? { extraTags: ["fork"], extraProps: this.forkProps(forkParent) } : {}),
        },
        turns.map((t) => buildEntry(t, title, this.deps.redact)),
      );
      await vault.create(target, content);
      store.set(
        this.checkpoint(sessionId, known, path, stat, {
          hostSessionId: host,
          notaLog: target,
          projeto: project?.name,
          hashUltimoRegistro: lastHeading(),
          ultimoRegistroUtc: lastUtc,
          temTurnoPendente: hasPendingTurn,
          apagadaPeloUsuario: undefined,
          ignorada: false,
          tituloPendente: undefined,
          branchesPendentes: undefined,
          jsonlRegistrado: path,
          forkRegistrado: forkParent,
        }),
      );
      await this.linkKanbanCards(target, turns, project, entities.projects);
      await this.syncSubagents(sessionId, path, target, project?.name, options.tzOffsetMinutes);
      return { sessao: sessionId, status: "created", added: turns.length, notaLog: target };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.deps.log?.("sync failed", { sessionId, detail });
      return { sessao: sessionId, status: "error", added: 0, detail };
    }
  }

  /**
   * KAN-8: lists the log in the "## Logs" section of every Kanban card whose key the user wrote in a request.
   * The cards searched are those of the project of the conversation or, when it has none, of the projects it cites.
   * Idempotent, append-only, and a failure here never fails the sync of the log.
   */
  private async linkKanbanCards(note: string, turns: Turn[], project: ProjectInfo | undefined, citedProjects?: string[]): Promise<void> {
    const { vault } = this.deps;
    if (!vault.findKanbanCard || this.deps.settings().mode !== "active") return;
    try {
      const keys = ticketKeysInRequests(turns);
      if (keys.length === 0) return;
      let candidates: ProjectInfo[] = project ? [project] : [];
      if (candidates.length === 0) {
        const cited = new Set(citedProjects ?? (await this.entitiesOf(turns)).projects);
        candidates = (await this.deps.tracker.projects()).filter((p) => cited.has(p.name));
      }
      const logName = note.replace(/^.*\//, "").replace(/\.md$/, "");
      for (const candidate of candidates) {
        for (const key of keys) {
          const card = vault.findKanbanCard(kanbanCardsFolder(candidate), key);
          // Read first so a card that already lists the log is not rewritten.
          if (card && addLogLink(await vault.read(card), logName).added) await vault.process(card, (content) => addLogLink(content, logName).content);
        }
      }
    } catch (err) {
      this.deps.log?.("kanban link failed", { note, detail: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Properties of the log of a fork: `sessao_pai` (id of the conversation it was forked from) and `fork_de` (link to its log, when it exists). */
  private forkProps(parentSessionId: string): Array<[string, string]> {
    const parentNote = this.deps.vault.findNoteBySession([`local_${parentSessionId}`, parentSessionId]);
    const props: Array<[string, string]> = [["sessao_pai", parentSessionId]];
    if (parentNote) props.push(["fork_de", `[[${parentNote.replace(/^.*\//, "").replace(/\.md$/, "")}]]`]);
    return props;
  }

  /** Marks an existing log as the log of a fork (tag `fork` and the fork properties); logs made before KAN-10 get it now. */
  private async ensureForkProps(note: string, parentSessionId: string): Promise<void> {
    try {
      const props = this.forkProps(parentSessionId);
      await this.deps.vault.updateFrontmatter(note, (fm) => {
        const tags = ([] as unknown[]).concat(fm.tags ?? []).map((t) => String(t));
        if (!tags.includes("fork")) fm.tags = [...tags, "fork"];
        for (const [key, value] of props) fm[key] = value;
      });
    } catch (err) {
      this.deps.log?.("fork properties failed", { note, detail: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Writes `jsonl` (file name) and `jsonl_caminho` (absolute path) in the frontmatter of a log. */
  private async ensureJsonlProps(note: string, transcriptPath: string): Promise<void> {
    try {
      await this.deps.vault.updateFrontmatter(note, (fm) => {
        fm.jsonl = transcriptFileName(transcriptPath);
        fm.jsonl_caminho = transcriptPath;
      });
    } catch (err) {
      this.deps.log?.("jsonl properties failed", { note, detail: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Writes one log per finished subagent of the session, next to the log of the conversation (in "Subagentes"),
   * and lists them in the `subagentes` property of the parent log. Supports multi-turn subagents and updates (LM-08).
   */
  private async syncSubagents(
    sessionId: string,
    transcriptPath: string,
    parentNote: string,
    projectName: string | undefined,
    tz: number | undefined,
  ): Promise<void> {
    const { disk, vault, locator, store } = this.deps;
    if (this.deps.settings().mode !== "active") return;
    try {
      const parentName = parentNote.replace(/^.*\//, "").replace(/\.md$/, "");
      const folder = `${parentNote.includes("/") ? parentNote.slice(0, parentNote.lastIndexOf("/")) : ""}/Subagentes`.replace(/^\//, "");
      const linked: string[] = [];
      for (const ref of await locator.listSubagents(transcriptPath)) {
        if (!ref.finished) continue;
        const key = `${sessionId}/agent-${ref.agentId}`;
        const known = store.get(key);
        const stat = await disk.stat(ref.path);
        if (!stat) continue;
        const existing = known?.notaLog && vault.exists(known.notaLog) ? known.notaLog : vault.findNoteBySession([`agent-${ref.agentId}`]);
        if (existing && known && known.offset === stat.size) {
          linked.push(existing.replace(/^.*\//, "").replace(/\.md$/, ""));
          continue;
        }
        const parsed = parseTranscript(await disk.readText(ref.path), tz, { includeSidechain: true });
        if (parsed.turns.length === 0) continue;
        // The prompt a subagent receives is usually a long brief: keep the log readable.
        const short = (s: string): string => (s.length > SUBAGENT_PROMPT_LIMIT ? `${s.slice(0, SUBAGENT_PROMPT_LIMIT).trimEnd()}…` : s);
        const turns: Turn[] = parsed.turns.map((t) => ({ ...t, userText: short(t.userText), rawText: short(t.rawText) }));
        const title = normalizeSessionName(ref.description || ref.agentType || "Subagente");
        let notePath = existing;
        if (!notePath) {
          const first = parsed.firstTimestamp ?? turns[0].date;
          notePath = `${folder}/${fileStamp(first, tz)} - ${sanitizeFilename(`Subagente - ${title}`)}.md`;
          const content = buildNoteContent(
            {
              agent: this.agent,
              hostSessionId: `agent-${ref.agentId}`,
              title: `Subagente - ${title}`,
              up: [parentName],
              project: projectName,
              extraTags: ["subagente"],
              extraProps: [
                ["sessao_pai", sessionId],
                ...(ref.agentType ? ([["subagente_tipo", ref.agentType]] as Array<[string, string]>) : []),
                ...(ref.model ? ([["modelo", ref.model]] as Array<[string, string]>) : []),
              ],
              jsonl: { name: transcriptFileName(ref.path), path: ref.path },
            },
            turns.map((t) => buildEntry(t, title, this.deps.redact)),
          );
          if (vault.exists(notePath)) notePath = `${notePath.slice(0, -3)} (${ref.agentId.slice(0, 6)}).md`;
          await vault.create(notePath, content);
        } else {
          await vault.process(notePath, (content) => appendEntries(content, turns, (i) => buildEntry(turns[i], title, this.deps.redact)).content);
        }
        store.set({
          sessao: key,
          hostSessionId: `agent-${ref.agentId}`,
          caminhoTranscript: ref.path,
          offset: stat.size,
          mtimeMs: stat.mtimeMs,
          hashUltimoRegistro: "",
          ultimoRegistroUtc: turns[turns.length - 1].date.toISOString(),
          notaLog: notePath,
          projeto: projectName,
          jsonlRegistrado: ref.path,
        });
        linked.push(notePath.replace(/^.*\//, "").replace(/\.md$/, ""));
      }
      if (linked.length > 0) {
        await vault.updateFrontmatter(parentNote, (fm) => {
          const current = ([] as unknown[]).concat(fm.subagentes ?? []).map((v) => String(v));
          const fresh = linked.map((n) => `[[${n}]]`).filter((n) => !current.includes(n));
          if (fresh.length > 0) fm.subagentes = [...current, ...fresh];
        });
      }
    } catch (err) {
      this.deps.log?.("subagent logs failed", { sessionId, detail: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Adds the cited entities to the frontmatter without duplicates (the body stays append-only). */
  private async mergeEntities(note: string, entities: Entities): Promise<void> {
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
