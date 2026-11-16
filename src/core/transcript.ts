// Reads a Claude Code transcript (.jsonl) and groups it into turns (request x response).
// Originally ported from scripts/gerar_log_conversa.py of the vault; this plugin is now the source of truth for the format.
import { baseName } from "./text-utils";

export interface Turn {
  /** dd/MM/yyyy - HH:mm in the local time zone. */
  timestamp: string;
  date: Date;
  userText: string;
  rawText: string;
  imagesCount: number;
  tools: string[];
  filesModified: string[];
  commands: string[];
  assistantTexts: string[];
  /** The assistant finished answering (stop_reason end_turn) or a later turn exists. */
  complete: boolean;
}

export interface ParsedTranscript {
  turns: Turn[];
  firstTimestamp: Date | undefined;
  cwd: string | undefined;
  sessionId: string | undefined;
  customTitle: string | undefined;
  /** Distinct `sessionId` values of the message lines, in order of appearance (a fork starts with those of its parent). */
  sessionIds: string[];
}

export interface IncrementalTranscriptState {
  rawTurns: Turn[];
  firstTimestamp: Date | undefined;
  cwd: string | undefined;
  sessionId: string | undefined;
  customTitle: string | undefined;
  sessionIds?: string[];
  remainder?: string;
}

/**
 * Session id of the conversation a transcript was forked from. A fork starts as a copy of its parent: the
 * copied lines keep the parent's `sessionId` and the lines written after the fork carry the transcript's own id.
 * So the parent is the id seen right before the first line of `ownSessionId`.
 */
export function forkParentOf(sessionIds: string[], ownSessionId: string): string | undefined {
  const at = sessionIds.indexOf(ownSessionId);
  return at > 0 ? sessionIds[at - 1] : undefined;
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** dd/MM/yyyy - HH:mm. With tzOffsetMinutes (minutes east of UTC) the zone is fixed, otherwise it is the local one. */
export function formatTimestamp(date: Date, tzOffsetMinutes?: number): string {
  const d = tzOffsetMinutes === undefined ? date : new Date(date.getTime() + tzOffsetMinutes * 60_000);
  const get =
    tzOffsetMinutes === undefined
      ? { y: d.getFullYear(), mo: d.getMonth() + 1, da: d.getDate(), h: d.getHours(), mi: d.getMinutes() }
      : { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, da: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes() };
  return `${pad(get.da)}/${pad(get.mo)}/${get.y} - ${pad(get.h)}:${pad(get.mi)}`;
}

/** Removes blocks injected by the app (<system-reminder>...) from the user text. */
export function stripSystemBlocks(text: string): string {
  if (!text) return "";
  let out = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
  out = out.replace(/<system-reminder>[\s\S]*/g, "");
  return out.trim();
}

/** Cleans the user prompt: drops attach markers, quoted lines ("> text") and image markers. */
export function cleanUserText(raw: string): string {
  if (!raw) return "";
  let text = raw.trim().replace(/<!-- attach -->/g, "").trim();
  const lines = text.split("\n");
  const nonQuote = lines.filter((l) => !/^>(\s|$)/.test(l));
  if (nonQuote.length > 0 && nonQuote.some((l) => l.trim() !== "")) text = nonQuote.join("\n").trim();
  return text.replace(/\[Image:.*?\]/g, "").trim();
}

/** "/name args" from the XML the app writes when the person runs a slash command; undefined when the text is not one. */
export function extractSlashCommand(text: string): string | undefined {
  const name = /<command-name>\s*([^<]*?)\s*<\/command-name>/.exec(text)?.[1];
  if (!name) return undefined;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim() ?? "";
  const command = name.startsWith("/") ? name : `/${name}`;
  return args ? `${command} ${args}` : command;
}

interface RawLine {
  type?: string;
  timestamp?: string;
  cwd?: string;
  sessionId?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  isVisibleInTranscriptOnly?: boolean;
  customTitle?: string;
  message?: { content?: unknown; stop_reason?: string };
}

function asContentItems(content: unknown): Array<Record<string, unknown>> {
  return Array.isArray(content) ? (content.filter((i) => typeof i === "object" && i !== null) as Array<Record<string, unknown>>) : [];
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Only these line types matter to the parser; the others (progress, attachments, snapshots) are skipped without a JSON.parse. */
const MESSAGE_LINE = /"type"\s*:\s*"(?:user|assistant|custom-title)"/;

export interface ParseOptions {
  /** Reads the lines of a subagent transcript too (all of them are marked as sidechain). */
  includeSidechain?: boolean;
}

export function createIncrementalState(): IncrementalTranscriptState {
  return {
    rawTurns: [],
    firstTimestamp: undefined,
    cwd: undefined,
    sessionId: undefined,
    customTitle: undefined,
    remainder: "",
  };
}

/** Appends a chunk of JSONL lines to an existing incremental transcript state (LM-07). */
export function appendTranscriptChunk(
  state: IncrementalTranscriptState,
  text: string,
  tzOffsetMinutes?: number,
  options: ParseOptions = {},
): ParsedTranscript {
  const turns = state.rawTurns;
  let current: Turn | undefined = turns[turns.length - 1];
  const combined = `${state.remainder ?? ""}${text}`;
  const lines = combined.split("\n");
  state.remainder = "";

  for (let idx = 0; idx < lines.length; idx++) {
    const rawLine = lines[idx] ?? "";
    const trimmed = rawLine.trim();
    if (trimmed === "") continue;
    const isLast = idx === lines.length - 1 && !combined.endsWith("\n");
    if (!MESSAGE_LINE.test(trimmed)) {
      if (isLast) state.remainder = rawLine;
      continue;
    }
    let data: RawLine;
    try {
      data = JSON.parse(trimmed) as RawLine;
    } catch {
      if (isLast) state.remainder = rawLine;
      continue; // partial last line while the file is being written
    }
    if (data.isSidechain === true && !options.includeSidechain) continue;
    if (!state.sessionId && typeof data.sessionId === "string") state.sessionId = data.sessionId;
    if (typeof data.sessionId === "string" && data.sessionId !== "" && !options.includeSidechain) {
      const ids = (state.sessionIds ??= []);
      if (!ids.includes(data.sessionId)) ids.push(data.sessionId);
    }
    if (!state.cwd && typeof data.cwd === "string") state.cwd = data.cwd;
    if (data.type === "custom-title" && typeof data.customTitle === "string" && data.customTitle.trim() !== "") {
      state.customTitle = data.customTitle.trim();
    }

    if (data.type === "user") {
      // The app writes the summary of a compaction as a user message; it is not something the person wrote.
      if (data.isCompactSummary === true || data.isVisibleInTranscriptOnly === true) continue;
      const content = data.message?.content;
      let hasToolResult = false;
      const parts: string[] = [];
      let images = 0;
      let raw = "";
      if (Array.isArray(content)) {
        for (const item of asContentItems(content)) {
          if (item.type === "tool_result") hasToolResult = true;
          else if (item.type === "text") parts.push(str(item.text));
          else if (item.type === "image") images++;
        }
        raw = parts.join("\n").trim();
      } else if (typeof content === "string") {
        raw = content.trim();
      }
      if (hasToolResult) continue;
      raw = stripSystemBlocks(raw);
      images += (raw.match(/\[Image:.*?\]/g) ?? []).length;
      let cleaned = cleanUserText(raw);
      if (cleaned.startsWith("<task-notification>") || cleaned.startsWith("<local-command") || cleaned.startsWith("[Request interrupted")) continue;
      // A slash command the person ran: log "/name args" instead of the XML the app wrote.
      const slash = extractSlashCommand(cleaned);
      if (slash) {
        cleaned = slash;
        raw = slash;
      }
      // Text the app injects when a skill loads: not something the person wrote.
      if (data.isMeta === true || cleaned.startsWith("Base directory for this skill:")) continue;
      if (!cleaned && images === 0 && !raw) continue;

      const date = typeof data.timestamp === "string" ? new Date(data.timestamp) : new Date();
      if (!state.firstTimestamp) state.firstTimestamp = date;

      if (current && current.assistantTexts.length === 0 && current.tools.length === 0) {
        // The previous prompt got no answer yet (text and then a screenshot): same request.
        if (cleaned) current.userText = current.userText ? `${current.userText}\n${cleaned}` : cleaned;
        if (raw) current.rawText = current.rawText ? `${current.rawText}\n${raw}` : raw;
        current.imagesCount += images;
      } else {
        current = {
          timestamp: formatTimestamp(date, tzOffsetMinutes),
          date,
          userText: cleaned,
          rawText: raw,
          imagesCount: images,
          tools: [],
          filesModified: [],
          commands: [],
          assistantTexts: [],
          complete: false,
        };
        turns.push(current);
      }
    } else if (data.type === "assistant" && current) {
      const stop = data.message?.stop_reason;
      current.complete = stop === "end_turn";
      for (const item of asContentItems(data.message?.content)) {
        if (item.type === "tool_use") {
          const name = str(item.name);
          const input = (typeof item.input === "object" && item.input !== null ? item.input : {}) as Record<string, unknown>;
          current.tools.push(name);
          if (["Write", "Edit", "replace_file_content", "write_to_file"].includes(name)) {
            const target = str(input.file_path) || str(input.TargetFile);
            if (target) {
              const fname = baseName(target);
              if (!current.filesModified.includes(fname)) current.filesModified.push(fname);
            }
          } else if (["Bash", "PowerShell", "run_command"].includes(name)) {
            const cmd = str(input.command) || str(input.CommandLine);
            if (cmd) {
              const short = (cmd.trim().split("\n")[0] ?? "").slice(0, 80);
              if (!current.commands.includes(short)) current.commands.push(short);
            }
          }
        } else if (item.type === "text") {
          const t = str(item.text).trim();
          if (t) current.assistantTexts.push(t);
        }
      }
    }
  }

  turns.forEach((turn, i) => {
    if (i < turns.length - 1) turn.complete = true;
  });
  const valid = turns.filter((t) => t.userText || t.imagesCount > 0 || t.rawText);
  return {
    turns: valid,
    firstTimestamp: state.firstTimestamp,
    cwd: state.cwd,
    sessionId: state.sessionId,
    customTitle: state.customTitle,
    sessionIds: state.sessionIds ?? [],
  };
}

export function parseTranscript(text: string, tzOffsetMinutes?: number, options: ParseOptions = {}): ParsedTranscript {
  return appendTranscriptChunk(createIncrementalState(), text, tzOffsetMinutes, options);
}
