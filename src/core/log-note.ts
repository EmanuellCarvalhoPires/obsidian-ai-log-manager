// Content of a conversation log note: creation and append-only update.
// Same format as [[Template de Log do Claude]] and scripts/gerar_log_conversa.py.
import type { Entry } from "./format";
import { redactSecrets } from "./redactor";

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
  /** File name and absolute path of the transcript, written to `jsonl` and `jsonl_caminho`. */
  jsonl?: { name: string; path: string };
  /** Extra tag (e.g. "subagente") and properties for logs that are not plain conversations. */
  extraTags?: string[];
  extraProps?: Array<[string, string]>;
}

export const FACTS_HEADING = "Decisões e Fatos da Sessão";

export function buildNoteContent(header: NoteHeader, entries: Entry[]): string {
  const fm = ["---", "tags:", "  - log", `  - ${header.agent}`];
  for (const tag of header.extraTags ?? []) fm.push(`  - ${tag}`);
  fm.push("  - sessao/ativo");
  if (header.up.length === 1) fm.push(`up: "[[${header.up[0]}]]"`);
  else {
    fm.push("up:");
    for (const u of header.up) fm.push(`  - "[[${u}]]"`);
  }
  fm.push(`sessao: ${header.hostSessionId}`, "Status da Sessão: Ativo");
  for (const [key, value] of header.extraProps ?? []) fm.push(`${key}: ${JSON.stringify(value)}`);
  if (header.jsonl) fm.push(`jsonl: ${JSON.stringify(header.jsonl.name)}`, `jsonl_caminho: ${JSON.stringify(header.jsonl.path)}`);
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
  const base = `${fm.join("\n")}\n# ${redactSecrets(header.title)}\n\n## Sumário\n${summary}\n\n---\n\n${body}`;
  const facts = (header.fatos ?? []).filter((f) => f.trim() !== "");
  if (facts.length === 0) return base;
  return appendFacts(base, facts, header.factsTimestamp ?? "").content;
}

function pushList(fm: string[], key: string, values: string[] | undefined, quote: boolean): void {
  if (!values || values.length === 0) return;
  fm.push(`${key}:`);
  for (const v of values) fm.push(quote ? `  - "${v}"` : `  - ${v}`);
}

interface EntrySection {
  timestamp: string;
  start: number;
  end: number;
  text: string;
}

function parseEntrySections(content: string): EntrySection[] {
  const matches = [...content.matchAll(/^##\s+.*?(\d{2}\/\d{2}\/\d{4}\s*-\s*\d{2}:\d{2}).*$/gm)];
  return matches.map((m, idx) => {
    const start = m.index ?? 0;
    const end = idx + 1 < matches.length ? (matches[idx + 1]?.index ?? content.length) : content.length;
    const timestamp = (m[1] ?? "").trim().replace(/\s*-\s*/g, " - ");
    return { timestamp, start, end, text: content.slice(start, end) };
  });
}

/** Timestamps (dd/MM/yyyy - HH:mm) of the entries already in the note, as a list so repeats count. */
export function existingTimestamps(content: string): string[] {
  return parseEntrySections(content).map((s) => s.timestamp);
}

const RESPONSE_MARKER = "\n\n**Resposta:** ";
const CONTINUATION_MARKER = "\n\n**Resposta (continuação):** ";
const FILES_LINE = /^Arquivos modificados\/criados: [^\n]+(?:\n\n|$)/;

/**
 * Checks whether a turn that is already in the note grew after its first `end_turn` (for example after a
 * `<task-notification>` from a background subagent). Returns only the new response text to append.
 */
function computeContinuation(sectionText: string, newMarkdown: string): string | undefined {
  const newRespIdx = newMarkdown.indexOf(RESPONSE_MARKER);
  const oldRespIdx = sectionText.indexOf(RESPONSE_MARKER);
  if (newRespIdx < 0 || oldRespIdx < 0) return undefined;

  const fullResp = newMarkdown.slice(newRespIdx + RESPONSE_MARKER.length).trim();
  const writtenRaw = sectionText.slice(oldRespIdx + RESPONSE_MARKER.length).trim();
  const combinedExisting = writtenRaw.split(CONTINUATION_MARKER).map((s) => s.trim()).join("\n\n");

  if (!fullResp || fullResp === combinedExisting || combinedExisting.includes(fullResp)) return undefined;
  if (fullResp.startsWith(combinedExisting)) {
    const tail = fullResp.slice(combinedExisting.length).trim();
    return tail || undefined;
  }

  // Handle the case where the continuation modified files and added/updated the "Arquivos modificados/criados:" line.
  const fullFiles = FILES_LINE.exec(fullResp)?.[0]?.trim();
  const oldFiles = FILES_LINE.exec(combinedExisting)?.[0]?.trim();
  const fullBody = fullResp.replace(FILES_LINE, "").trim();
  const oldBody = combinedExisting.replace(FILES_LINE, "").trim();
  if (oldBody && fullBody.startsWith(oldBody)) {
    const tail = fullBody.slice(oldBody.length).trim();
    const parts: string[] = [];
    if (fullFiles && fullFiles !== oldFiles && !writtenRaw.includes(fullFiles)) parts.push(fullFiles);
    if (tail) parts.push(tail);
    return parts.length > 0 ? parts.join("\n\n") : undefined;
  }
  return undefined;
}

export interface AppendResult {
  content: string;
  added: number;
}

/**
 * Adds only the entries that the note does not have yet (matched by turn position when all turns are passed,
 * so timezone changes and duplicate short prompts in the same minute are handled cleanly), and appends
 * `**Resposta (continuação):**` when an existing turn's response grew. Existing text is never overwritten.
 */
export function appendEntries(
  content: string,
  turns: Array<{ timestamp: string; assistantTexts?: string[] }>,
  buildFor: (index: number) => Entry,
): AppendResult {
  const sections = parseEntrySections(content);
  const links: string[] = [];
  const records: string[] = [];
  const continuations: Array<{ sectionIndex: number; text: string }> = [];

  if (turns.length >= sections.length) {
    for (let i = 0; i < sections.length; i++) {
      const turn = turns[i];
      const section = sections[i];
      if (!turn || !section) continue;
      const mayHaveGrown = i === sections.length - 1 || (turn.assistantTexts !== undefined && turn.assistantTexts.length > 1);
      if (!mayHaveGrown) continue;
      const entry = buildFor(i);
      const cont = computeContinuation(section.text, entry.markdown);
      if (cont) continuations.push({ sectionIndex: i, text: cont });
    }
    for (let i = sections.length; i < turns.length; i++) {
      const entry = buildFor(i);
      links.push(entry.summaryLink);
      records.push(entry.markdown);
    }
  } else {
    const seen = sections.map((s) => s.timestamp);
    turns.forEach((turn, i) => {
      const at = seen.indexOf(turn.timestamp);
      if (at >= 0) {
        seen.splice(at, 1);
        return;
      }
      const entry = buildFor(i);
      links.push(entry.summaryLink);
      records.push(entry.markdown);
    });
  }

  if (records.length === 0 && continuations.length === 0) return { content, added: 0 };

  let next = content;
  // Apply continuations from last section to first so string offsets stay valid.
  for (let c = continuations.length - 1; c >= 0; c--) {
    const item = continuations[c];
    const sec = sections[item.sectionIndex];
    const head = next.slice(0, sec.end).replace(/\s+$/, "");
    const tail = next.slice(sec.end);
    next = `${head}\n\n**Resposta (continuação):** ${item.text}\n${tail.startsWith("\n") ? tail : tail ? `\n${tail}` : ""}`;
  }

  if (records.length > 0) {
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
  }
  return { content: next, added: records.length + continuations.length };
}

const FACTS_BODY = /## Decisões e Fatos da Sessão[ \t]*\r?\n([\s\S]*?)(?=\r?\n---|\r?\n## |$)/;

/**
 * Adds facts as `- [timestamp] text` lines to the "Decisões e Fatos da Sessão" section, creating it between the
 * Sumário and the `---` when it does not exist. Exact duplicates (same text) are skipped. appendEntries keeps
 * working with or without the section because the Sumário regex stops at `\n## `.
 */
export function appendFacts(content: string, facts: string[], timestamp: string, externalRedact?: (text: string) => string): AppendResult {
  const clean = [
    ...new Set(
      facts
        .map((f) => redactSecrets(f.replace(/\s+/g, " ").trim(), externalRedact))
        .filter((f) => f !== ""),
    ),
  ];
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
 * Project patterns are compiled once per call instead of once per turn (LM-07).
 */
export function extractEntitiesFromTurns(
  turns: Array<{ userText: string; assistantTexts: string[] }>,
  knownProjects: string[],
  ticketPrefixes?: Set<string>,
): Entities {
  const tickets = new Set<string>();
  const prs = new Set<string>();
  const projects = new Set<string>();
  const compiledProjects = [...knownProjects]
    .sort((a, b) => b.length - a.length)
    .map((name) => ({
      name,
      re: new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, "iu"),
    }));
  for (const turn of turns) {
    const text = [turn.userText, ...turn.assistantTexts].join("\n");
    for (const m of text.matchAll(/\b([A-Z][A-Z0-9]{1,9})-\d+\b/g)) {
      const prefix = m[1] ?? "";
      const ok = ticketPrefixes && ticketPrefixes.size > 0 ? ticketPrefixes.has(prefix) : !TICKET_STOPWORDS.has(prefix);
      if (ok) tickets.add(m[0]);
    }
    for (const m of text.matchAll(/\bPR\s*#(\d+)\b/g)) prs.add(`PR #${m[1]}`);
    for (const { name, re } of compiledProjects) {
      if (projects.has(name)) continue;
      if (re.test(text)) projects.add(name);
    }
  }
  return { tickets: [...tickets], prs: [...prs], projects: [...projects] };
}
