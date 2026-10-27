// Text of a log entry: title, "Solicitação" and "Resposta". Port of generate_entry_title(),
// format_solicitacao(), format_resposta() and normalize_session_name() from
// scripts/gerar_log_conversa.py.
import type { Turn } from "./transcript";
import { baseName, decodeUri, shortenAtWord } from "./text-utils";

const QUOTE_LINE = /^>(\s|$)/;

/** Cuts at the end of the first sentence: ".", "?" or "!" followed by a space or the end ("CLAUDE.md" stays whole). */
function cutSentence(text: string): string {
  return (text.split(/[.?!](?=\s|$)/)[0] ?? "").trim();
}

function firstSentence(text: string): string {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  return cutSentence(lines[0] ?? "");
}

export function generateEntryTitle(turn: Pick<Turn, "userText" | "rawText" | "imagesCount" | "filesModified" | "assistantTexts">, sessionName = ""): string {
  const source = turn.rawText || turn.userText;

  const obsidianLink = /obsidian:\/\/open\?[^\s]+file=([^&\s"'<>)\]]+)/.exec(source);
  if (obsidianLink?.[1]) {
    const note = baseName(decodeUri(obsidianLink[1])).replace(/\.md$/, "");
    return `Link da nota [[${note}]]`;
  }

  let clean = (turn.userText || "").replace(/https?:\/\/\S+/g, "");
  clean = clean.replace(/@"[^"]+"/g, "").replace(/obsidian:\/\/\S+/g, "").replace(/[#*`_]/g, "").trim();
  const sentence = firstSentence(clean);
  if (sentence.length >= 5 && sentence.length <= 55) return sentence;
  if (sentence.length > 55) {
    const short = shortenAtWord(sentence, 50);
    if (short) return short;
  }

  const attached = /@"(.*?)"/.exec(source);
  if (attached?.[1]) {
    const fname = baseName(attached[1]);
    if (fname.toLowerCase().includes("pipelinelog")) return "Análise do log do pipeline";
    const base = fname.replace(/\.[^.]+$/, "");
    return `Análise do arquivo ${base.slice(0, 30)}`;
  }

  if (sessionName && !["sessão claude code", "untitled session"].includes(sessionName.toLowerCase())) {
    return sessionName.slice(0, 50);
  }

  for (const text of turn.assistantTexts) {
    for (const rawLine of text.split("\n")) {
      const line = rawLine.replace(/^#+\s*/, "").trim().replace(/^Caminho [AB][^:]*:\s*/, "").trim();
      if (line.length >= 10 && !/^(http|```|\{|<)/.test(line)) {
        const sent = cutSentence(line);
        if (sent.length >= 10 && sent.length <= 50) return sent;
        if (sent.length > 50) {
          const short = shortenAtWord(sent, 50);
          if (short.length >= 10) return short;
        }
      }
    }
  }

  if (turn.filesModified.length > 0) return `Alterações em ${turn.filesModified.slice(0, 2).join(", ")}`;
  if (turn.imagesCount > 0) return "Análise de print / imagem enviada";
  return "Solicitação do usuário";
}

export function formatSolicitacao(turn: Pick<Turn, "userText" | "rawText" | "imagesCount">): string {
  const parts: string[] = [];
  let source = turn.rawText || turn.userText;
  source = source
    .split("\n")
    .filter((l) => !QUOTE_LINE.test(l))
    .join("\n");

  const urls = source.match(/https?:\/\/\S+/g) ?? [];
  const files = [...source.matchAll(/@"(.*?)"/g)].map((m) => m[1] ?? "");
  const obsidianLinks = [...source.matchAll(/obsidian:\/\/open\?[^\s]+file=([^&\s"'<>)\]]+)/g)].map((m) => m[1] ?? "");

  if (turn.imagesCount > 0) parts.push("O usuário enviou print(s)/imagem(ns)");
  if (files.length > 0) parts.push(`anexou arquivo(s) (${files.map(baseName).join(", ")})`);
  if (obsidianLinks.length > 0) {
    for (const link of obsidianLinks) parts.push(`enviou link da nota [[${baseName(decodeUri(link)).replace(/\.md$/, "")}]]`);
  } else if (urls.length > 0) {
    parts.push(`enviou link \`${urls[0]}\``);
  }

  const clean = (turn.userText || source)
    .replace(/https?:\/\/\S+/g, "")
    .replace(/@"[^"]+"/g, "")
    .replace(/obsidian:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (clean) return parts.length > 0 ? `${parts.join("; ")} e solicitou: "${clean}"` : clean;
  if (parts.length > 0) return `${parts.join("; ")}.`;
  return "O usuário não forneceu descrição em texto.";
}

const CLOSING_PATTERNS = [
  /devo (criar|atualizar) (o|um) log/i,
  /quer que eu (mude|faça|execute|implemente)/i,
  /posso prosseguir/i,
  /como prefere seguir/i,
  /deseja que eu/i,
];

export function formatResposta(turn: Pick<Turn, "assistantTexts" | "filesModified">): string {
  const actions: string[] = [];
  if (turn.filesModified.length > 0) {
    actions.push(`Arquivos modificados/criados: ${turn.filesModified.map((f) => `\`${f}\``).join(", ")}.`);
  }
  const full = turn.assistantTexts.join("\n\n").trim();
  if (!full) return actions.length > 0 ? actions.join(" ") : "Solicitação processada e concluída.";

  const cleaned: string[] = [];
  for (const line of full.split("\n")) {
    if (CLOSING_PATTERNS.some((p) => p.test(line.trim()))) continue;
    const header = /^(#{1,6})\s+(.*)$/.exec(line);
    if (header) {
      const text = (header[2] ?? "").trim().replace(/^\*\*(.*?)\*\*$/, "$1");
      cleaned.push(`**${text}**`);
    } else {
      cleaned.push(line);
    }
  }
  const result = cleaned.join("\n").trim().replace(/\n{3,}/g, "\n\n");
  if (actions.length > 0 && result) return `${actions.join(" ")}\n\n${result}`;
  if (result) return result;
  return actions.length > 0 ? actions.join(" ") : "Solicitação processada e concluída.";
}

/** Replaces pasted links in the session title by something readable. */
export function normalizeSessionName(name: string): string {
  if (!name) return name;
  const obsidian = (m: string): string => {
    const f = /file=([^&\s]+)/.exec(m);
    if (!f?.[1]) return "";
    return baseName(decodeUri(f[1])).replace(/\.(md|canvas|base)$/i, "");
  };
  const url = (m: string): string => {
    const path = m
      .replace(/\/$/, "")
      .replace(/^[a-z]+:\/\//i, "")
      .split("?")[0]
      .split("#")[0];
    const parts = path.split("/").filter((p) => p !== "");
    return parts.length > 0 ? decodeUri(parts[parts.length - 1]) : "";
  };
  let out = name.replace(/obsidian:\/\/\S+/g, obsidian).replace(/https?:\/\/\S+/g, url);
  out = out.replace(/…/g, "").replace(/%20/g, " ").replace(/\s{2,}/g, " ").replace(/^[\s-]+|[\s-]+$/g, "");
  return out || "Sessão Claude Code";
}

export interface Entry {
  heading: string;
  summaryLink: string;
  markdown: string;
}

/** Makes a title safe as a heading and as the target of a [[#heading|alias]] link: no [[ ]], |, # or ^. */
export function cleanHeadingTitle(title: string): string {
  return title
    .replace(/\[\[([^\]|]*)(?:\|[^\]]*)?\]\]/g, "$1")
    .replace(/[[\]|#^]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function buildEntry(turn: Turn, sessionName = ""): Entry {
  const title = cleanHeadingTitle(generateEntryTitle(turn, sessionName)) || "Solicitação do usuário";
  const heading = `${turn.timestamp} - ${title}`;
  return {
    heading,
    summaryLink: `- [[#${heading}|${heading}]]`,
    markdown: `## ${heading}\n\n**Solicitação:** ${formatSolicitacao(turn)}\n\n**Resposta:** ${formatResposta(turn)}\n`,
  };
}
