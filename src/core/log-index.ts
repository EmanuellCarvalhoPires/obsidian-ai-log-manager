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

const AGENT_TAGS = ["claude", "gemini"];

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
    entries: src.headings.filter((h) => h.toLowerCase() !== "sumário"),
    mtime: src.mtime,
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
