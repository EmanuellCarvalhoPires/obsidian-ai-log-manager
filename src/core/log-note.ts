// Content of a conversation log note: creation and append-only update.
// Same format as [[Template de Log do Claude]] and scripts/gerar_log_conversa.py.
import type { Entry } from "./format";

export interface NoteHeader {
  agent: string;
  hostSessionId: string;
  title: string;
  /** Wikilink targets for `up`, e.g. ["Memória Claude", "AI Ecosystem - Logs"]. */
  up: string[];
  project?: string;
  branches?: string[];
  /** Ticket keys cited in the conversation, written to `tickets_citados`. */
  tickets?: string[];
  /** Pull requests cited ("PR #36"), written to `prs_citados`. */
  prs?: string[];
  /** Names of the project notes cited, written to `projetos_citados` as wikilinks. */
  projects?: string[];
  /** Facts to write in the "Decisões e Fatos da Sessão" section when the note is created. */
  fatos?: string[];
  /** Timestamp (dd/MM/yyyy HH:mm) of the initial facts. */
  factsTimestamp?: string;
}

export const FACTS_HEADING = "Decisões e Fatos da Sessão";

export function buildNoteContent(header: NoteHeader, entries: Entry[]): string {
  const fm = ["---", "tags:", "  - log", `  - ${header.agent}`, "  - sessao/ativo"];
  if (header.up.length === 1) fm.push(`up: "[[${header.up[0]}]]"`);
  else {
    fm.push("up:");
    for (const u of header.up) fm.push(`  - "[[${u}]]"`);
  }
  fm.push(`sessao: ${header.hostSessionId}`, "Status da Sessão: Ativo");
  if (header.project) fm.push(`projeto: "[[${header.project}]]"`);
  if (header.branches && header.branches.length > 0) {
    fm.push("branches:");
    for (const b of header.branches) fm.push(`  - "[[${b}]]"`);
  }
  pushList(fm, "tickets_citados", header.tickets, false);
  pushList(fm, "prs_citados", header.prs, true);
  pushList(fm, "projetos_citados", header.projects?.map((p) => `[[${p}]]`), true);
  fm.push("---");
  const summary = entries.map((e) => e.summaryLink).join("\n");
  const body = entries.map((e) => e.markdown).join("\n");
  const base = `${fm.join("\n")}\n# ${header.title}\n\n## Sumário\n${summary}\n\n---\n\n${body}`;
  const facts = (header.fatos ?? []).filter((f) => f.trim() !== "");
  if (facts.length === 0) return base;
  return appendFacts(base, facts, header.factsTimestamp ?? "").content;
}

function pushList(fm: string[], key: string, values: string[] | undefined, quote: boolean): void {
  if (!values || values.length === 0) return;
  fm.push(`${key}:`);
  for (const v of values) fm.push(quote ? `  - "${v}"` : `  - ${v}`);
}

/** Timestamps (dd/MM/yyyy - HH:mm) of the entries already in the note, as a list so repeats count. */
export function existingTimestamps(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(/^##\s+.*?(\d{2}\/\d{2}\/\d{4}\s*-\s*\d{2}:\d{2})/gm)) {
    out.push((m[1] ?? "").trim().replace(/\s*-\s*/g, " - "));
  }
  return out;
}

export interface AppendResult {
  content: string;
  added: number;
}

/**
 * Adds only the entries that the note does not have yet (matched by timestamp, repeats counted):
 * new Sumário lines at the end of the Sumário and new records at the end of the note.
 * Existing content is never changed.
 */
export function appendEntries(content: string, turns: Array<{ timestamp: string }>, buildFor: (index: number) => Entry): AppendResult {
  const seen = existingTimestamps(content);
  const links: string[] = [];
  const records: string[] = [];
  turns.forEach((turn, i) => {
    const at = seen.indexOf(turn.timestamp);
    if (at >= 0) {
      seen.splice(at, 1);
      return;
    }
    const entry = buildFor(i);
    if (content.includes(`## ${entry.heading}`)) return;
    links.push(entry.summaryLink);
    records.push(entry.markdown);
  });
  if (records.length === 0) return { content, added: 0 };

  let next = content;
  const summary = /(## Sumário\s*\n)([\s\S]*?)(\n---|\n## )/.exec(next);
  if (summary) {
    const header = summary[1] ?? "";
    const body = (summary[2] ?? "").replace(/\s+$/, "");
    const tail = summary[3] ?? "";
    const rebuilt = `${header}${body}\n${links.join("\n")}\n`;
    next = next.slice(0, summary.index) + rebuilt + next.slice(summary.index + summary[0].length - tail.length);
  }
  if (!next.endsWith("\n\n")) next = `${next.replace(/\s+$/, "")}\n\n`;
  next += records.join("\n");
  return { content: next, added: records.length };
}

const FACTS_BODY = /## Decisões e Fatos da Sessão[ \t]*\r?\n([\s\S]*?)(?=\r?\n---|\r?\n## |$)/;

/**
 * Adds facts as `- [timestamp] text` lines to the "Decisões e Fatos da Sessão" section, creating it between the
 * Sumário and the `---` when it does not exist. Exact duplicates (same text) are skipped. appendEntries keeps
 * working with or without the section because the Sumário regex stops at `\n## `.
 */
export function appendFacts(content: string, facts: string[], timestamp: string): AppendResult {
  const clean = [...new Set(facts.map((f) => f.replace(/\s+/g, " ").trim()).filter((f) => f !== ""))];
  if (clean.length === 0) return { content, added: 0 };
  const stamp = timestamp ? `[${timestamp}] ` : "";
  const section = FACTS_BODY.exec(content);
  if (section) {
    const present = (section[1] ?? "").split(/\r?\n/).map((l) => l.replace(/^-\s*(\[[^\]]*\]\s*)?/, "").trim());
    const fresh = clean.filter((f) => !present.includes(f));
    if (fresh.length === 0) return { content, added: 0 };
    const at = section.index + section[0].length;
    const head = content.slice(0, at).replace(/\s+$/, "");
    const lines = fresh.map((f) => `- ${stamp}${f}`).join("\n");
    return { content: `${head}\n${lines}${content.slice(at)}`, added: fresh.length };
  }
  const sumario = content.indexOf("## Sumário");
  if (sumario < 0) return { content, added: 0 };
  const rule = content.indexOf("\n---", sumario);
  if (rule < 0) return { content, added: 0 };
  const lines = clean.map((f) => `- ${stamp}${f}`).join("\n");
  const head = content.slice(0, rule).replace(/\s+$/, "");
  return { content: `${head}\n\n## ${FACTS_HEADING}\n${lines}\n${content.slice(rule)}`, added: clean.length };
}

export interface Entities {
  tickets: string[];
  prs: string[];
  projects: string[];
}

/** Common false positives of the ticket regex, used only when the real Jira prefixes are not available. */
export const TICKET_STOPWORDS = new Set([
  "UTF", "SHA", "ISO", "GPT", "TLS", "SSL", "AES", "RSA", "RFC", "CVE", "MD", "PS", "UTC", "HTTP", "HTTPS", "TCP", "UDP",
  "IPV", "WIN", "LLM", "GMT", "BOM", "CRLF", "ES", "TS", "PDF", "USB", "PNG", "JPEG", "MP", "ECMA", "NFC", "NFD",
  "GBK", "CP", "WCAG", "OAUTH", "ARM", "AMD", "RTX", "GTX", "DDR", "IEEE", "ANSI", "ASCII",
]);

/** Prefixes (`ATL`, `DEVAT`...) from the tables of the "Prefixos de Projetos Jira" note. */
export function parseTicketPrefixes(noteContent: string): Set<string> {
  const out = new Set<string>();
  for (const m of noteContent.matchAll(/^\|\s*`([A-Z][A-Z0-9]*)`\s*\|/gm)) out.add(m[1] ?? "");
  out.delete("");
  return out;
}

const escapeRegExp = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Tickets, pull requests and project names cited in the turns (request and answer text).
 * Tickets count only when the prefix is in `ticketPrefixes`; without that set, a stopword list filters the regex.
 */
export function extractEntitiesFromTurns(
  turns: Array<{ userText: string; assistantTexts: string[] }>,
  knownProjects: string[],
  ticketPrefixes?: Set<string>,
): Entities {
  const tickets = new Set<string>();
  const prs = new Set<string>();
  const projects = new Set<string>();
  const names = [...knownProjects].sort((a, b) => b.length - a.length);
  for (const turn of turns) {
    const text = [turn.userText, ...turn.assistantTexts].join("\n");
    for (const m of text.matchAll(/\b([A-Z][A-Z0-9]{1,9})-\d+\b/g)) {
      const prefix = m[1] ?? "";
      const ok = ticketPrefixes && ticketPrefixes.size > 0 ? ticketPrefixes.has(prefix) : !TICKET_STOPWORDS.has(prefix);
      if (ok) tickets.add(m[0]);
    }
    for (const m of text.matchAll(/\bPR\s*#(\d+)\b/g)) prs.add(`PR #${m[1]}`);
    for (const name of names) {
      if (projects.has(name)) continue;
      if (new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, "iu").test(text)) projects.add(name);
    }
  }
  return { tickets: [...tickets], prs: [...prs], projects: [...projects] };
}
