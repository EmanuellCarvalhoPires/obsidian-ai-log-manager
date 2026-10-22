// Ports of the core: what the log engine needs from the outside world. The Obsidian and Node
// implementations live in src/adapters; tests use in-memory ones.

export interface FileStat {
  size: number;
  mtimeMs: number;
}

/** Disk access outside the vault (the Claude Code home folder, the spool of the hook). */
export interface DiskPort {
  readText(path: string): Promise<string>;
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
  /** Changes the frontmatter of a note. */
  updateFrontmatter(path: string, fn: (frontmatter: Record<string, unknown>) => void): Promise<void>;
  /** Renames a note (keeps links). */
  rename(path: string, newPath: string): Promise<void>;
  /** Makes sure a folder exists. */
  ensureFolder(path: string): Promise<void>;
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
  /** Records development events (commit, push, branch, PR, deploy) of projects with a clone. */
  devEnabled: boolean;
  /** Subfolder of the project folder that receives the event notes. */
  eventsFolder: string;
  /** Commits drawn in a repository graph. */
  graphLimit: number;
  /** Reads pull requests and deployments from GitHub or Bitbucket (needs a secret in Environment Keys). */
  remoteEnabled: boolean;
  /** Names of the Environment Keys secrets (tokens). Only the names are stored here. */
  githubSecret: string;
  bitbucketSecret: string;
}

export const DEFAULT_LOG_SETTINGS: LogSettings = {
  mode: "active",
  watch: true,
  debounceSeconds: 4,
  trackedFolders: [],
  projectsRoot: "Projetos",
  projectLogsFolder: "Logs",
  claudeHome: "",
  devEnabled: true,
  eventsFolder: "Eventos",
  graphLimit: 60,
  remoteEnabled: false,
  githubSecret: "GITHUB_TOKEN",
  bitbucketSecret: "BITBUCKET_TOKEN",
};

/** Runs `git <args>` in a folder and returns stdout. Rejects on a non-zero exit. */
export type GitRunner = (cwd: string, args: string[]) => Promise<string>;

export interface HttpRequest {
  method: "GET";
  url: string;
  headers: Record<string, string>;
}

export interface HttpResponse {
  status: number;
  body: string;
}

/** Authenticated HTTP through Environment Keys (placeholders are resolved there, never here). */
export type SecureHttp = (req: HttpRequest) => Promise<HttpResponse>;
