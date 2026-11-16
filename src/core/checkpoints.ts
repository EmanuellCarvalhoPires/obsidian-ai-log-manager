// Checkpoint per conversation: what was already written, so every update is incremental and
// idempotent. Stored as JSON in the plugin folder.
import { startTimer, stopTimer } from "./timers";

export const CHECKPOINT_SAVE_DELAY_MS = 5_000;

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
  /** ISO UTC timestamp of the last recorded entry (LM-11). */
  ultimoRegistroUtc?: string;
  /** True when the last turn of the transcript had no `end_turn` yet (LM-05). */
  temTurnoPendente?: boolean;
  notaLog: string | undefined;
  projeto: string | undefined;
  /** The conversation is outside the tracked folders (kept so it is not read again). */
  ignorada?: boolean;
  /** The log note was deleted by the user; do not recreate it unless explicitly asked (LM-18). */
  apagadaPeloUsuario?: boolean;
  /** Title chosen by logs_set before the log exists; used when the log is created. */
  tituloPendente?: string;
  /** Branch note names chosen before the log exists; written to the frontmatter when the log is created. */
  branchesPendentes?: string[];
  /** Transcript path already written to the `jsonl` properties of the log (so the backfill runs once). */
  jsonlRegistrado?: string;
  /** Session id of the parent already written to the fork properties of the log (KAN-10), so the backfill runs once. */
  forkRegistrado?: string;
}

export interface CheckpointFile {
  version: 1;
  /** Epoch ms of the last full reconciliation; only transcripts changed after it are reconciled. */
  lastReconcileMs: number;
  sessions: Record<string, Checkpoint>;
  /** cwd (normalized) -> answer to the "new project" question. */
  projectAnswers: Record<string, "declined" | "created">;
}

export function emptyCheckpointFile(now: number): CheckpointFile {
  return { version: 1, lastReconcileMs: now, sessions: {}, projectAnswers: {} };
}

export function normalizeCheckpointFile(raw: unknown, now: number): CheckpointFile {
  if (typeof raw !== "object" || raw === null) return emptyCheckpointFile(now);
  const r = raw as Partial<CheckpointFile>;
  return {
    version: 1,
    lastReconcileMs: typeof r.lastReconcileMs === "number" ? r.lastReconcileMs : now,
    sessions: typeof r.sessions === "object" && r.sessions !== null ? r.sessions : {},
    projectAnswers: typeof r.projectAnswers === "object" && r.projectAnswers !== null ? r.projectAnswers : {},
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
    private readonly saveDelayMs: number = CHECKPOINT_SAVE_DELAY_MS,
  ) {
    this.data = normalizeCheckpointFile(initial, now());
  }

  static async open(storage: CheckpointStorage, now: () => number, saveDelayMs = CHECKPOINT_SAVE_DELAY_MS): Promise<CheckpointStore> {
    let raw: unknown;
    try {
      raw = await storage.load();
    } catch {
      raw = undefined;
    }
    return new CheckpointStore(storage, now, raw, saveDelayMs);
  }

  get(sessao: string): Checkpoint | undefined {
    return this.data.sessions[sessao];
  }

  set(cp: Checkpoint): void {
    const prev = this.data.sessions[cp.sessao];
    if (prev && JSON.stringify(prev) === JSON.stringify(cp)) return;
    this.data.sessions[cp.sessao] = cp;
    this.scheduleSave();
  }

  delete(sessao: string): boolean {
    if (!(sessao in this.data.sessions)) return false;
    delete this.data.sessions[sessao];
    this.scheduleSave();
    return true;
  }

  /**
   * Removes checkpoints whose transcript file is not in `existingTranscriptPaths` (LM-15).
   * Checkpoints without `caminhoTranscript` (pending project links before first sync) are kept.
   */
  pruneMissingTranscripts(existingTranscriptPaths: Set<string>): number {
    let removed = 0;
    for (const [key, cp] of Object.entries(this.data.sessions)) {
      // A `.db` is a Gemini (Antigravity) conversation: it is not in the list of Claude Code transcripts.
      if (!cp.caminhoTranscript || cp.caminhoTranscript.toLowerCase().endsWith(".db")) continue;
      // Subagent checkpoint keys look like `<parentSessionId>/agent-<id>`: keep if parent transcript still exists.
      const parentSession = key.includes("/agent-") ? key.slice(0, key.indexOf("/agent-")) : undefined;
      const parentPath = parentSession ? this.data.sessions[parentSession]?.caminhoTranscript : undefined;
      const keep = existingTranscriptPaths.has(cp.caminhoTranscript) || (parentPath !== undefined && existingTranscriptPaths.has(parentPath));
      if (!keep) {
        delete this.data.sessions[key];
        removed++;
      }
    }
    if (removed > 0) this.scheduleSave();
    return removed;
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
    }, this.saveDelayMs);
  }
}
