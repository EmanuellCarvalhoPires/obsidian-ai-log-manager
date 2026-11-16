// KAN-8: links the log of a conversation to the Kanban cards (tickets) the user asked it to work on.
// Cards are notes in "<project folder>/<project> - Kanban - Cards/" with a `key` property (KAN-8) and the
// sections "## Descrição" and "## Histórico". The log is listed in a "## Logs" section of the card.
// Pure functions only; the engine does the vault access.

/** Name of the folder of the cards of a project, next to the project note. */
export function kanbanCardsFolder(project: { name: string; folder: string }): string {
  return `${project.folder}/${project.name} - Kanban - Cards`;
}

/**
 * Ticket keys (`KAN-8`) written in the requests of the user, in order and without repeats. Only the user's text
 * counts: answers often mention other cards in passing. The keys are only candidates; a key that is not a card
 * of the project is ignored by the engine.
 */
export function ticketKeysInRequests(turns: Array<{ userText: string }>): string[] {
  const keys = new Set<string>();
  for (const turn of turns) for (const m of turn.userText.matchAll(/\b[A-Z][A-Z0-9]{1,9}-\d+\b/g)) keys.add(m[0]);
  return [...keys];
}

export const KANBAN_LOGS_HEADING = "Logs";

const escapeRegExp = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** True when the card already links the log (`[[name]]`, `[[folder/name]]` or `[[name|alias]]`). */
export function hasLogLink(content: string, logName: string): boolean {
  return new RegExp(`\\[\\[(?:[^\\]|\\n]*/)?${escapeRegExp(logName)}(?:#[^\\]|\\n]*)?(?:\\|[^\\]\\n]*)?\\]\\]`).test(content);
}

/**
 * Lists the log in the "## Logs" section of the card (created at the end when missing). Idempotent and
 * append-only: nothing of the card is removed or rewritten.
 */
export function addLogLink(content: string, logName: string): { content: string; added: boolean } {
  if (hasLogLink(content, logName)) return { content, added: false };
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const line = `- [[${logName}]]`;
  const heading = new RegExp(`^##[ \\t]+${escapeRegExp(KANBAN_LOGS_HEADING)}[ \\t]*\\r?$`, "m").exec(content);
  if (!heading) {
    const base = content.replace(/\s+$/, "");
    return { content: `${base}${eol}${eol}## ${KANBAN_LOGS_HEADING}${eol}${eol}${line}${eol}`, added: true };
  }
  const bodyStart = heading.index + heading[0].length;
  const next = /^## /m.exec(content.slice(bodyStart));
  const sectionEnd = next ? bodyStart + next.index : content.length;
  const head = content.slice(0, sectionEnd).replace(/\s+$/, "");
  const tail = content.slice(sectionEnd);
  return { content: `${head}${eol}${line}${eol}${tail ? `${eol}${tail}` : ""}`, added: true };
}
