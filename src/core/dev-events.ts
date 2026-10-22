// Development events (commit, push, branch, pull request, deploy) and the notes they become.
import { sanitizeFilename } from "./text-utils";

export type DevEventType = "commit" | "push" | "branch" | "pr" | "deploy";

export const DEV_EVENT_TYPES: DevEventType[] = ["commit", "push", "branch", "pr", "deploy"];

export interface DevEvent {
  tipo: DevEventType;
  projeto: string;
  /** Stable key: the same event never makes two notes. */
  id: string;
  titulo: string;
  data: Date;
  branch?: string;
  hash?: string;
  url?: string;
  autor?: string;
  detalhes?: string;
  /** pr: open, merged, declined. deploy: environment status. */
  estado?: string;
  ambiente?: string;
}

const LABEL: Record<DevEventType, string> = { commit: "Commit", push: "Push", branch: "Branch", pr: "PR", deploy: "Deploy" };

export function isDevEventType(v: unknown): v is DevEventType {
  return typeof v === "string" && (DEV_EVENT_TYPES as string[]).includes(v);
}

const slug = (s: string): string => sanitizeFilename(s.replace(/[\\/]/g, "-")).replace(/\s+/g, " ").slice(0, 70).trim();

/** Vault path of the note of an event, inside the project's events folder. */
export function eventPath(folder: string, ev: DevEvent): string {
  const short = ev.hash ? ev.hash.slice(0, 7) : "";
  let name: string;
  switch (ev.tipo) {
    case "commit":
      name = `Commit ${short} - ${slug(ev.titulo)}`;
      break;
    case "push":
      name = `Push ${slug(ev.branch ?? "")} - ${short}`;
      break;
    case "branch":
      name = `Branch ${slug(ev.branch ?? ev.titulo)}`;
      break;
    case "pr":
      name = `PR ${slug(ev.id.split("-").pop() ?? ev.id)} - ${slug(ev.titulo)}`;
      break;
    default:
      name = `Deploy ${slug(ev.ambiente ?? "")} - ${slug(ev.id.split("-").pop() ?? ev.id)}`;
  }
  return `${folder}/${name.replace(/\s+-\s*$/, "").trim()}.md`;
}

const yamlString = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Content of the note of an event. The `ai-log-graph` block draws the repository graph when the note is open. */
export function renderEventNote(ev: DevEvent, indexNote: string): string {
  const fm = [
    "---",
    "tags:",
    `  - dev/${ev.tipo}`,
    `up: "[[${indexNote}]]"`,
    `projeto: "[[${ev.projeto}]]"`,
    `evento: ${ev.tipo}`,
    `evento_id: ${yamlString(ev.id)}`,
    `data: ${ev.data.toISOString()}`,
  ];
  if (ev.branch) fm.push(`branch: ${yamlString(ev.branch)}`);
  if (ev.hash) fm.push(`hash: ${ev.hash}`);
  if (ev.estado) fm.push(`estado: ${yamlString(ev.estado)}`);
  if (ev.ambiente) fm.push(`ambiente: ${yamlString(ev.ambiente)}`);
  fm.push("---");

  const rows: Array<[string, string]> = [["Projeto", `[[${ev.projeto}]]`]];
  if (ev.branch) rows.push(["Branch", `\`${ev.branch}\``]);
  if (ev.hash) rows.push(["Commit", `\`${ev.hash.slice(0, 7)}\``]);
  if (ev.autor) rows.push(["Autor", ev.autor]);
  if (ev.estado) rows.push(["Estado", ev.estado]);
  if (ev.ambiente) rows.push(["Ambiente", ev.ambiente]);
  rows.push(["Data", ev.data.toLocaleString("pt-BR")]);
  if (ev.url) rows.push(["Link", ev.url]);

  const body = [
    `# ${LABEL[ev.tipo]} - ${ev.titulo}`,
    "",
    "| Campo | Valor |",
    "| :-- | :-- |",
    ...rows.map(([k, v]) => `| ${k} | ${v.replace(/\|/g, "\\|")} |`),
    "",
  ];
  if (ev.detalhes) body.push(ev.detalhes.trim(), "");
  body.push("## Grafo do repositório", "", "```ai-log-graph", `projeto: ${ev.projeto}`);
  if (ev.branch) body.push(`branch: ${ev.branch}`);
  if (ev.hash) body.push(`hash: ${ev.hash}`);
  body.push("```", "");
  return `${fm.join("\n")}\n${body.join("\n")}`;
}

/** Parameters of an `ai-log-graph` block ("key: value" lines). */
export function parseGraphBlock(source: string): { projeto?: string; branch?: string; hash?: string; limite?: number } {
  const out: { projeto?: string; branch?: string; hash?: string; limite?: number } = {};
  for (const line of source.split("\n")) {
    const m = /^\s*(projeto|branch|hash|limite)\s*:\s*(.+?)\s*$/i.exec(line);
    if (!m) continue;
    const key = (m[1] ?? "").toLowerCase();
    const value = m[2] ?? "";
    if (key === "limite") {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) out.limite = Math.floor(n);
    } else if (key === "projeto") out.projeto = value;
    else if (key === "branch") out.branch = value;
    else out.hash = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Detection in Claude Code Bash commands (PostToolUse)
// ---------------------------------------------------------------------------

export type CommandKind = "commit" | "push" | "pr-create" | "pr-merge" | "branch" | "init";

/** What a shell command did to the repository, if it matters here. */
export function detectCommand(command: string | undefined): CommandKind | undefined {
  if (!command) return undefined;
  const c = command;
  if (/\bgh\s+pr\s+create\b/.test(c)) return "pr-create";
  if (/\bgh\s+pr\s+merge\b/.test(c)) return "pr-merge";
  if (/\bgit\b(?:\s+-C\s+\S+)?\s+commit\b/.test(c)) return "commit";
  if (/\bgit\b(?:\s+-C\s+\S+)?\s+push\b/.test(c)) return "push";
  if (/\bgit\b(?:\s+-C\s+\S+)?\s+(?:checkout\s+-b|switch\s+-c|branch\s+(?!-d|-D)\S)/.test(c)) return "branch";
  if (/\bgit\b(?:\s+-C\s+\S+)?\s+init\b/.test(c)) return "init";
  return undefined;
}

/** URL of a GitHub or Bitbucket pull request in a text (the output of `gh pr create`). */
export function findPullRequestUrl(text: string | undefined): { url: string; number: string; host: "github" | "bitbucket"; repo: string } | undefined {
  if (!text) return undefined;
  const gh = /https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/.exec(text);
  if (gh) return { url: gh[0], number: gh[2] ?? "", host: "github", repo: gh[1] ?? "" };
  const bb = /https:\/\/bitbucket\.org\/([^/\s]+\/[^/\s]+)\/pull-requests\/(\d+)/.exec(text);
  if (bb) return { url: bb[0], number: bb[2] ?? "", host: "bitbucket", repo: bb[1] ?? "" };
  return undefined;
}

/** `--title "x"` or `-t 'x'` of a gh command. */
export function titleFromCommand(command: string | undefined): string | undefined {
  const m = command ? /(?:--title|-t)[ =]+(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(command) : null;
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
}
