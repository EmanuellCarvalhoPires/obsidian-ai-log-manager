// Ports of the core: what the log engine needs from the outside world. The Obsidian and Node
// implementations live in src/adapters; tests use in-memory ones.

export interface FileStat {
  size: number;
  mtimeMs: number;
}

/** Disk access outside the vault (the Claude Code home folder, the spool of the hook). */
export interface DiskPort {
  readText(path: string): Promise<string>;
  /** Reads only the bytes after `offset` (UTF-8), for incremental transcript reading (LM-07). */
  readFrom?(path: string, offset: number): Promise<string>;
  stat(path: string): Promise<FileStat | undefined>;
  /** Names of the entries of a folder; empty when it does not exist. */
  list(path: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
}

export interface ProjectInfo {
  /** Name of the project note. */
  name: string;
  /** Vault folder of the project, e.g. "Projetos/AI Ecosystem". */
  folder: string;
  /** Absolute path of the local clone, when the note says one. */
  clonePath: string | undefined;
}

/** Vault access used by the engine. Paths are vault-relative with "/". */
export interface VaultPort {
  /** Absolute path of the vault folder on disk. */
  rootPath(): string;
  exists(path: string): boolean;
  read(path: string): Promise<string>;
  /** Creates the note (and its folders). Fails when it exists. */
  create(path: string, content: string): Promise<void>;
  /** Atomic read-modify-write of a note. */
  process(path: string, fn: (content: string) => string): Promise<void>;
  /** Path of the note whose `sessao` property is one of the ids, if any. */
  findNoteBySession(ids: string[]): string | undefined;
  /** Folder that holds the "Memória Claude" note (destination of conversation logs). */
  memoryFolder(): string;
  /** Notes with the tag dev/projeto. */
  projects(): Promise<ProjectInfo[]>;
  /** Content of a note found by its name (no folder, no extension), or undefined when there is none. */
  readNoteByName(name: string): Promise<string | undefined>;
  /** Changes the frontmatter of a note. */
  updateFrontmatter(path: string, fn: (frontmatter: Record<string, unknown>) => void): Promise<void>;
  /** Renames a note (keeps links). */
  rename(path: string, newPath: string): Promise<void>;
  /** Makes sure a folder exists. */
  ensureFolder(path: string): Promise<void>;
  /** Path of the Kanban card with this key (`KAN-8`) inside the cards folder, or undefined (KAN-8). */
  findKanbanCard?(cardsFolder: string, key: string): string | undefined;
}

/** One row of the `steps` table of an Antigravity conversation database. */
export interface ConversationDbStep {
  stepType: number;
  /** Protobuf blob of the step. */
  payload: Uint8Array;
}

/** One row of `conversation_summaries.db` (the index Antigravity keeps next to the conversations). */
export interface ConversationSummary {
  id: string;
  title: string;
  /** Workspace folders as `file://` URIs. */
  workspaceUris: string[];
  /** Epoch ms of the last change, when the index has one. */
  lastModifiedMs: number | undefined;
  /** A conversation of a subagent (it has a parent): its text lives in the log of the parent. */
  nested: boolean;
}

/**
 * Read-only access to the SQLite files of Antigravity (the Gemini agent). Implemented in src/adapters/node-sqlite.ts
 * with Node's built-in `node:sqlite`; every method rejects when SQLite is not available.
 */
export interface ConversationDbPort {
  /** Steps of a conversation database whose type is one of `stepTypes`, in order. */
  readSteps(dbPath: string, stepTypes: number[]): Promise<ConversationDbStep[]>;
  /** The protobuf blob of the `trajectory_metadata_blob` table (workspace of the conversation), if any. */
  readMetadata(dbPath: string): Promise<Uint8Array | undefined>;
  /** Rows of a `conversation_summaries.db`; empty when the file does not exist. */
  readSummaries(summariesPath: string): Promise<ConversationSummary[]>;
}

export interface Clock {
  now(): number;
}

export interface LogSettings {
  /** active writes logs; observe only computes and reports (migration period, decision D8). */
  mode: "active" | "observe";
  watch: boolean;
  debounceSeconds: number;
  /** Extra absolute folders whose conversations get a log. */
  trackedFolders: string[];
  projectsRoot: string;
  projectLogsFolder: string;
  /** Absolute path of the Claude Code home (~/.claude); empty means the user home. */
  claudeHome: string;
}

export const DEFAULT_LOG_SETTINGS: LogSettings = {
  mode: "active",
  watch: true,
  debounceSeconds: 4,
  trackedFolders: [],
  projectsRoot: "Projetos",
  projectLogsFolder: "Logs",
  claudeHome: "",
};
