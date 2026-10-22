// Checkpoint per conversation: what was already written, so every update is incremental and
// idempotent. Stored as JSON in the plugin folder.
import { startTimer, stopTimer } from "./timers";

export interface Checkpoint {
  /** Claude Code session id (name of the transcript file). */
  sessao: string;
  /** Value of the `sessao` property of the note (hostSessionId, or local_<sessao>). */
  hostSessionId: string;
  caminhoTranscript: string;
  /** Size and modification time of the transcript at the last sync (nothing to do when unchanged). */
  offset: number;
  mtimeMs: number;
  /** Heading of the last registered entry. */
  hashUltimoRegistro: string;
  notaLog: string | undefined;
  projeto: string | undefined;
  /** The conversation is outside the tracked folders (kept so it is not read again). */
  ignorada?: boolean;
}

/** What was seen of a project repository at the last sync. */
export interface DevState {
  /** Epoch ms of the last sync: only commits after it are new. */
  cursorMs: number;
  /** "origin/main" -> hash of the remote-tracking branch (a change means a push). */
  tips: Record<string, string>;
  /** Local branch names. */
  branches: string[];
  /** Pull request id -> last known state. */
  prStates: Record<string, string>;
}

export interface CheckpointFile {
  version: 1;
  /** Epoch ms of the last full reconciliation; only transcripts changed after it are reconciled. */
  lastReconcileMs: number;
  sessions: Record<string, Checkpoint>;
  /** cwd (normalized) -> answer to the "new project" question. */
  projectAnswers: Record<string, "declined" | "created">;
  /** Repository state per project name. */
  dev: Record<string, DevState>;
  /** Event id -> vault path of its note. */
  devEvents: Record<string, string>;
}

export function emptyCheckpointFile(now: number): CheckpointFile {
  return { version: 1, lastReconcileMs: now, sessions: {}, projectAnswers: {}, dev: {}, devEvents: {} };
}

export function normalizeCheckpointFile(raw: unknown, now: number): CheckpointFile {
  if (typeof raw !== "object" || raw === null) return emptyCheckpointFile(now);
  const r = raw as Partial<CheckpointFile>;
  return {
    version: 1,
    lastReconcileMs: typeof r.lastReconcileMs === "number" ? r.lastReconcileMs : now,
    sessions: typeof r.sessions === "object" && r.sessions !== null ? r.sessions : {},
    projectAnswers: typeof r.projectAnswers === "object" && r.projectAnswers !== null ? r.projectAnswers : {},
    dev: typeof r.dev === "object" && r.dev !== null ? r.dev : {},
    devEvents: typeof r.devEvents === "object" && r.devEvents !== null ? r.devEvents : {},
  };
}

export interface CheckpointStorage {
  load(): Promise<unknown>;
  save(data: CheckpointFile): Promise<void>;
}

export class CheckpointStore {
  private data: CheckpointFile;
  private saveTimer: number | undefined;

  constructor(
    private readonly storage: CheckpointStorage,
    private readonly now: () => number,
    initial?: unknown,
  ) {
    this.data = normalizeCheckpointFile(initial, now());
  }

  static async open(storage: CheckpointStorage, now: () => number): Promise<CheckpointStore> {
    let raw: unknown;
    try {
      raw = await storage.load();
    } catch {
      raw = undefined;
    }
    return new CheckpointStore(storage, now, raw);
  }

  get(sessao: string): Checkpoint | undefined {
    return this.data.sessions[sessao];
  }

  set(cp: Checkpoint): void {
    this.data.sessions[cp.sessao] = cp;
    this.scheduleSave();
  }

  all(): Checkpoint[] {
    return Object.values(this.data.sessions);
  }

  get lastReconcileMs(): number {
    return this.data.lastReconcileMs;
  }

  markReconciled(): void {
    this.data.lastReconcileMs = this.now();
    this.scheduleSave();
  }

  projectAnswer(cwdKey: string): "declined" | "created" | undefined {
    return this.data.projectAnswers[cwdKey];
  }

  setProjectAnswer(cwdKey: string, answer: "declined" | "created"): void {
    this.data.projectAnswers[cwdKey] = answer;
    this.scheduleSave();
  }

  getDev(project: string): DevState | undefined {
    return this.data.dev[project];
  }

  setDev(project: string, state: DevState): void {
    this.data.dev[project] = state;
    this.scheduleSave();
  }

  eventNote(id: string): string | undefined {
    return this.data.devEvents[id];
  }

  setEventNote(id: string, path: string): void {
    this.data.devEvents[id] = path;
    this.scheduleSave();
  }

  /** Writes now (also used on unload). */
  async flush(): Promise<void> {
    if (this.saveTimer) stopTimer(this.saveTimer);
    this.saveTimer = undefined;
    await this.storage.save(this.data);
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = startTimer(() => {
      this.saveTimer = undefined;
      void this.storage.save(this.data).catch(() => undefined);
    }, 500);
  }
}
