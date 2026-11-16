// In-memory index of the conversation logs (Claude and Antigravity) for the logs view.
// Pure: the Obsidian side only turns notes into LogSource records.

export interface LogRecord {
  path: string;
  title: string;
  /** "claude", "gemini" or the first other tag found. */
  agent: string;
  /** Project note name, without brackets. */
  project: string | undefined;
  /** "ativo" or "arquivado". */
  status: string;
  /** Epoch ms of the last request (last entry heading, else file name stamp, else creation time). */
  date: number;
  sessao: string | undefined;
  /** Headings of the entries, in order (the Sumário). */
  entries: string[];
  mtime: number;
  /** Absolute path of the transcript, from the `jsonl_caminho` property (empty for logs made before it existed). */
  transcript: string | undefined;
  /** The log of a subagent of a conversation (tag `subagente`). */
  subagent: boolean;
  /** File name (no extension) of the note. */
  name: string;
  /** Name of the log of the conversation that called the subagent (first `up` link), for subagent logs. */
  parent: string | undefined;
  /** The log of a fork of another conversation (tag `fork`, KAN-10). */
  fork?: boolean;
  /** Session id of the conversation this one was forked from (`sessao_pai` property), for fork logs. */
  forkOf?: string;
}

/** What the adapter extracts from a note. */
export interface LogSource {
  path: string;
  basename: string;
  tags: string[];
  frontmatter: Record<string, unknown>;
  headings: string[];
  ctime: number;
  mtime: number;
}

/** Agents that make conversation logs; any other tag on a log note is not an agent. */
export const AGENT_TAGS = ["claude", "gemini"];

/** Section headings of a log that are not conversation entries. */
const NON_ENTRY_HEADINGS = ["sumário", "decisões e fatos da sessão"];

const text = (v: unknown): string | undefined => {
  if (Array.isArray(v)) return text(v[0]);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
};

/** "[[Meu App]]" -> "Meu App". */
export function unwikilink(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const m = /^\[\[([^\]|#]+)/.exec(value.trim());
  return (m?.[1] ?? value).trim();
}

/** Date from a log file name ("21-10-2026 - 12h00 - Título"), or undefined. */
export function dateFromName(name: string): number | undefined {
  const m = /(\d{2})-(\d{2})-(\d{4}) - (\d{2})h(\d{2})/.exec(name);
  if (!m) return undefined;
  return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4]), Number(m[5])).getTime();
}

/** Date of the last request, from the last entry heading ("21/10/2026 - 18:26 - Título"), or undefined. */
export function dateFromLastEntry(headings: string[]): number | undefined {
  for (let i = headings.length - 1; i >= 0; i--) {
    const m = /^(\d{2})\/(\d{2})\/(\d{4}) - (\d{2}):(\d{2})/.exec(headings[i] ?? "");
    if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4]), Number(m[5])).getTime();
  }
  return undefined;
}

export function toRecord(src: LogSource): LogRecord | undefined {
  const tags = src.tags.map((t) => t.replace(/^#/, ""));
  if (!tags.includes("log")) return undefined;
  const agent = AGENT_TAGS.find((a) => tags.includes(a)) ?? tags.find((t) => t !== "log" && !t.startsWith("sessao/")) ?? "outro";
  const statusTag = tags.find((t) => t.startsWith("sessao/"))?.slice("sessao/".length);
  const statusProp = text(src.frontmatter["Status da Sessão"])?.toLowerCase();
  const title = src.basename.replace(/^\d{2}-\d{2}-\d{4} - \d{2}h\d{2} - /, "");
  return {
    path: src.path,
    title,
    agent,
    project: unwikilink(text(src.frontmatter.projeto)),
    status: statusTag ?? statusProp ?? "ativo",
    date: dateFromLastEntry(src.headings) ?? dateFromName(src.basename) ?? src.ctime,
    sessao: text(src.frontmatter.sessao),
    entries: src.headings.filter((h) => !NON_ENTRY_HEADINGS.includes(h.toLowerCase())),
    mtime: src.mtime,
    transcript: text(src.frontmatter.jsonl_caminho),
    subagent: tags.includes("subagente"),
    name: src.basename,
    parent: tags.includes("subagente") ? unwikilink(text(src.frontmatter.up)) : undefined,
    fork: tags.includes("fork") && !tags.includes("subagente"),
    forkOf: tags.includes("fork") && !tags.includes("subagente") ? text(src.frontmatter.sessao_pai) : undefined,
  };
}

export function buildIndex(sources: LogSource[]): LogRecord[] {
  const out: LogRecord[] = [];
  for (const s of sources) {
    const r = toRecord(s);
    if (r) out.push(r);
  }
  return out.sort((a, b) => b.date - a.date);
}

export interface LogFilters {
  agent?: string;
  project?: string;
  status?: string;
  /** Epoch ms, inclusive. */
  from?: number;
  /** Epoch ms, inclusive (end of day is the caller's job). */
  to?: number;
  query?: string;
}

const fold = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export function filterLogs(records: LogRecord[], f: LogFilters): LogRecord[] {
  const words = f.query ? fold(f.query).split(/\s+/).filter((w) => w !== "") : [];
  return records.filter((r) => {
    if (f.agent && r.agent !== f.agent) return false;
    if (f.project && r.project !== f.project) return false;
    if (f.status && r.status !== f.status) return false;
    if (f.from !== undefined && r.date < f.from) return false;
    if (f.to !== undefined && r.date > f.to) return false;
    if (words.length > 0) {
      const hay = fold(`${r.title} ${r.project ?? ""} ${r.entries.join(" ")}`);
      if (!words.every((w) => hay.includes(w))) return false;
    }
    return true;
  });
}

export function distinct(records: LogRecord[], pick: (r: LogRecord) => string | undefined): string[] {
  return [...new Set(records.map(pick).filter((v): v is string => v !== undefined))].sort((a, b) => a.localeCompare(b));
}

export interface LogGroup {
  record: LogRecord;
  /** Subagent logs of this conversation, in the order they ran. */
  children: LogRecord[];
  /** Logs of the forks of this conversation (KAN-10), in the order they were made; a group apart from the subagents. */
  forks: LogRecord[];
}

/** Session id with the `local_` prefix of the desktop app removed, so `sessao` and `sessao_pai` compare equal. */
const bareSession = (id: string): string => id.replace(/^local_/, "");

/** Returns a function that finds the conversation (not itself a fork) a fork log descends from, or undefined when its log is unknown. */
function forkRootResolver(all: LogRecord[]): (fork: LogRecord) => LogRecord | undefined {
  const bySession = new Map<string, LogRecord>();
  for (const r of all) if (!r.subagent && r.sessao) bySession.set(bareSession(r.sessao), r);
  return (fork) => {
    const seen = new Set<string>([fork.path]);
    let parent = fork.forkOf ? bySession.get(bareSession(fork.forkOf)) : undefined;
    while (parent && !seen.has(parent.path)) {
      if (!parent.fork) return parent;
      seen.add(parent.path);
      parent = parent.forkOf ? bySession.get(bareSession(parent.forkOf)) : undefined;
    }
    return undefined;
  };
}

/** The log of the conversation a fork log was forked from (the root of the chain for a fork of a fork). */
export function forkRootOf(fork: LogRecord, all: LogRecord[]): LogRecord | undefined {
  return fork.fork ? forkRootResolver(all)(fork) : undefined;
}

/**
 * Puts each subagent log and each fork log under the log of the conversation they came from. A subagent or fork
 * whose conversation log is not in `all` stays on its own. A conversation that matched only through its subagents
 * or forks is listed too. A fork of a fork is listed under the conversation at the root of the chain.
 */
export function groupLogs(shown: LogRecord[], all: LogRecord[]): LogGroup[] {
  const byName = new Map<string, LogRecord>();
  for (const r of all) if (!r.subagent) byName.set(r.name, r);
  const rootOfFork = forkRootResolver(all);
  const groups = new Map<string, LogGroup>();
  const order: LogGroup[] = [];
  const groupOf = (record: LogRecord): LogGroup => {
    let g = groups.get(record.path);
    if (!g) {
      g = { record, children: [], forks: [] };
      groups.set(record.path, g);
      order.push(g);
    }
    return g;
  };
  for (const r of shown) {
    const subagentParent = r.subagent && r.parent ? byName.get(r.parent) : undefined;
    const forkParent = r.fork ? rootOfFork(r) : undefined;
    if (subagentParent) groupOf(subagentParent).children.push(r);
    else if (forkParent) groupOf(forkParent).forks.push(r);
    else groupOf(r);
  }
  for (const g of order) {
    g.children.sort((a, b) => a.date - b.date);
    g.forks.sort((a, b) => a.date - b.date);
  }
  return order;
}
