// Shows a Claude Code transcript (.jsonl) as a list of lines, each one a collapsible record.
const PAGE = 150;

interface Row {
  n: number;
  raw: string;
}

function snippet(text: string, max = 140): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/** One-line description of a transcript record: its type and what it carries. */
export function describeLine(data: unknown): { type: string; text: string } {
  if (typeof data !== "object" || data === null) return { type: "?", text: snippet(String(data)) };
  const rec = data as Record<string, unknown>;
  const type = typeof rec.type === "string" ? rec.type : "?";
  const message = rec.message as { content?: unknown } | undefined;
  const content = message?.content;
  if (typeof content === "string") return { type, text: snippet(content) };
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (typeof item !== "object" || item === null) continue;
      const it = item as Record<string, unknown>;
      if (it.type === "text" && typeof it.text === "string") parts.push(it.text);
      else if (it.type === "tool_use") parts.push(`[${typeof it.name === "string" ? it.name : "tool"}]`);
      else if (it.type === "tool_result") parts.push("[tool_result]");
      else if (it.type === "thinking") parts.push("[thinking]");
      else if (it.type === "image") parts.push("[image]");
    }
    if (parts.length > 0) return { type, text: snippet(parts.join(" ")) };
  }
  for (const key of ["customTitle", "summary", "subtype", "content"]) {
    const v = rec[key];
    if (typeof v === "string" && v !== "") return { type, text: snippet(v) };
  }
  return { type, text: "" };
}

/** Renders `text` (the content of a .jsonl file) into `parent`; long files load in pages. */
export function renderJsonl(parent: HTMLElement, text: string, labels: { loadMore: string; empty: string; lines: string }): void {
  parent.empty();
  const rows: Row[] = [];
  text.split("\n").forEach((raw, i) => {
    if (raw.trim() !== "") rows.push({ n: i + 1, raw });
  });
  if (rows.length === 0) {
    parent.createDiv({ cls: "ailm-empty ailm-muted", text: labels.empty });
    return;
  }
  parent.createDiv({ cls: "ailm-jsonl-count ailm-muted", text: `${rows.length} ${labels.lines}` });
  const list = parent.createDiv({ cls: "ailm-jsonl" });
  let shown = 0;
  let more: HTMLElement | undefined;

  const addPage = (): void => {
    more?.remove();
    for (const row of rows.slice(shown, shown + PAGE)) list.appendChild(buildRow(row));
    shown = Math.min(rows.length, shown + PAGE);
    if (shown < rows.length) {
      more = parent.createEl("button", { cls: "ailm-jsonl-more", text: `${labels.loadMore} (${shown}/${rows.length})` });
      more.addEventListener("click", addPage);
    }
  };
  addPage();
}

function buildRow(row: Row): HTMLElement {
  const details = createEl("details", { cls: "ailm-jsonl-row" });
  let parsed: unknown;
  let valid = true;
  try {
    parsed = JSON.parse(row.raw);
  } catch {
    valid = false;
  }
  const info = valid ? describeLine(parsed) : { type: "?", text: snippet(row.raw) };
  const summary = details.createEl("summary");
  summary.createSpan({ cls: "ailm-jsonl-n ailm-muted", text: String(row.n) });
  summary.createSpan({ cls: `ailm-jsonl-type ailm-jsonl-type-${info.type.replace(/[^a-z-]/gi, "")}`, text: info.type });
  summary.createSpan({ cls: "ailm-jsonl-text", text: info.text });
  let filled = false;
  details.addEventListener("toggle", () => {
    if (!details.open || filled) return;
    filled = true;
    details.createEl("pre", { cls: "ailm-jsonl-body", text: valid ? JSON.stringify(parsed, null, 2) : row.raw });
  });
  return details;
}
