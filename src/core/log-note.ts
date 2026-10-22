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
}

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
  fm.push("---");
  const summary = entries.map((e) => e.summaryLink).join("\n");
  const body = entries.map((e) => e.markdown).join("\n");
  return `${fm.join("\n")}\n# ${header.title}\n\n## Sumário\n${summary}\n\n---\n\n${body}`;
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
